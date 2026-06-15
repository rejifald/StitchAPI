// The three bridges between core primitives and the NestJS world (ADR 0006
// Decisions 6-8). None of them touches core: a TraceSink, a `Secret` thunk, and a
// StitchStore are all existing extension points.
import { Logger } from '@nestjs/common';
import type { StitchEvent, StitchStore, TraceSink } from 'stitchapi';

/**
 * A {@link TraceSink} that forwards the stitch event stream to a Nest {@link Logger}.
 *
 * SECURITY: a custom sink receives the **raw** event (core only redacts inside its own
 * built-in sinks), so `event.input.headers` still holds `authorization`/`cookie`. This
 * sink therefore logs only name/method/url/status — never `JSON.stringify(event)` — and
 * strips the URL query (it can carry secrets like `?api_key=`).
 */
export function loggerSink(logger: Logger = new Logger('Stitch')): TraceSink {
    return {
        handle(event: StitchEvent, ctx: { name: string }): void {
            const name = ctx.name;
            switch (event.type) {
                case 'start':
                    logger.log(
                        `→ ${name} ${event.method} ${redactUrl(event.url)}`,
                    );
                    break;
                case 'result':
                    logger.log(
                        `← ${name} ${event.status} (${event.attempts} attempt(s))`,
                    );
                    break;
                case 'error':
                    logger.error(
                        `✗ ${name} ${event.message}${event.status != null ? ` ${event.status}` : ''}`,
                    );
                    break;
                case 'drift':
                    logger.warn(
                        `drift ${name} ${event.finding.path} ${event.finding.change}`,
                    );
                    break;
                case 'progress':
                    logger.debug(`· ${name} ${event.phase}#${event.attempt}`);
                    break;
                default:
                    // 'delta' / 'done': too chatty for a logger — dropped.
                    break;
            }
        },
    };
}

// Drop the query string (it may carry secrets, e.g. `?api_key=…`) before logging.
function redactUrl(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/** The minimal slice of Nest's `ConfigService` this package needs — kept structural so
 * `@nestjs/config` is not even a peer dependency. */
export interface ConfigServiceLike {
    getOrThrow<T = string>(key: string): T;
}

/**
 * A `ConfigService`-backed secret resolver — core's `env(name)` twin. Returns a
 * synchronous `Secret` thunk (`() => string`) resolved at call time, so the credential
 * never lands on `__config` or in a trace. Pass it to any auth strategy:
 * `bearer(fromConfig(config)('API_TOKEN'))`.
 *
 * NOTE: `Secret` is synchronous, so this cannot fetch a rotating secret per call — that
 * is what `oauth2` / `cookieSession` are for (they refresh asynchronously via the vault).
 */
export function fromConfig(
    config: ConfigServiceLike,
): (key: string) => () => string {
    return (key: string) => () => String(config.getOrThrow<string>(key));
}

/**
 * Wrap a store the package does **not** own: `get`/`set`/`incr` delegate, but `close` is
 * omitted, so a seam's `close()` never tears down a store the app passed in (ADR 0006
 * Decision 8). The app — not the package — disposes a store it provides.
 */
export function borrowStore(store: StitchStore): StitchStore {
    return {
        get: (key) => store.get(key),
        set: (key, value, ttlMs) => store.set(key, value, ttlMs),
        incr: (key, ttlMs) => store.incr(key, ttlMs),
    };
}
