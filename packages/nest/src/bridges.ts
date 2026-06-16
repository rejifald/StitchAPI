// The three bridges between core primitives and the NestJS world (ADR 0006
// Decisions 6-8). None of them touches core: a TraceSink, a `Secret` thunk, and a
// StitchStore are all existing extension points.
import { Logger } from '@nestjs/common';
import type { StitchEvent, StitchStore, TraceSink } from 'stitchapi';

/**
 * The minimal logger surface this sink calls — declared structurally so Nest's
 * `Logger` satisfies it and a plain `{ log, warn, error, debug, verbose }` test
 * double works too. `debug`/`verbose` are optional and guarded at the call site,
 * so a partial logger (or one whose level hides them) is fine.
 */
export interface LoggerLike {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
    verbose?(message: string): void;
}

/** Options for {@link loggerSink}. */
export interface NestLoggerSinkOptions {
    /**
     * Emit the happy-path lifecycle events: `start` → `debug`, `result` → `verbose`,
     * `done` → `debug`. Default `true`. They sit at `debug`/`verbose` precisely so
     * Nest's default log level hides them in production — raise the level to see them,
     * or set `false` to drop them and log only retries, drift findings, and errors.
     */
    lifecycle?: boolean;
}

/**
 * A {@link TraceSink} that forwards the stitch event stream to a Nest {@link Logger}
 * (or any {@link LoggerLike}), mapping each {@link StitchEvent} to a log level:
 *
 * - `error` → `error`
 * - `drift` → `error` / `warn` / `debug`, following the finding's `level`
 * - `progress` → `warn` when the phase is `retry` or `circuit` (the upstream is flaky
 *   or the breaker tripped), else `debug` (routine throttle / paginate / cache waits)
 * - `start` → `debug`, `result` → `verbose`, `done` → `debug` (only when `lifecycle`)
 * - `delta` → dropped (per-chunk streaming output — it is raw response data)
 *
 * SECURITY: a custom sink receives the **raw** event (core only redacts inside its own
 * built-in sinks), so a `start` event's `input.headers` still holds `authorization` /
 * `cookie` and a `delta`'s `chunk` is raw response data. This sink therefore logs
 * **only metadata** — name, method, redacted URL, status, attempt counts, drift
 * path/level, timing — never `event.input`, `event.value`, a `delta` chunk, or
 * `JSON.stringify(event)`, and it strips the URL query (it can carry `?api_key=…`).
 * That keeps it safe on a secret-bearing seam independent of core's trace redaction.
 */
export function loggerSink(
    logger: LoggerLike = new Logger('Stitch'),
    options: NestLoggerSinkOptions = {},
): TraceSink {
    const lifecycle = options.lifecycle ?? true;
    return {
        handle(event: StitchEvent, ctx: { name: string }): void {
            const name = ctx.name;
            switch (event.type) {
                case 'start':
                    if (lifecycle)
                        logger.debug?.(
                            `→ ${name} ${event.method} ${redactUrl(event.url)}`,
                        );
                    return;
                case 'progress': {
                    const line = `· ${name} ${event.phase}#${event.attempt}${
                        event.waitedMs !== undefined
                            ? ` waited ${event.waitedMs}ms`
                            : ''
                    }`;
                    // A retry or a tripped circuit means the upstream is misbehaving —
                    // surface it at warn; throttle/paginate/cache waits are routine.
                    if (event.phase === 'retry' || event.phase === 'circuit')
                        logger.warn(line);
                    else logger.debug?.(line);
                    return;
                }
                case 'drift': {
                    const f = event.finding;
                    const line = `drift ${name} ${f.path} ${f.change}${f.detail ? ` (${f.detail})` : ''}`;
                    if (f.level === 'error') logger.error(line);
                    else if (f.level === 'warn') logger.warn(line);
                    else logger.debug?.(line);
                    return;
                }
                case 'result':
                    if (lifecycle)
                        logger.verbose?.(
                            `← ${name} ${event.status} (${event.attempts} attempt(s))`,
                        );
                    return;
                case 'error':
                    logger.error(
                        `✗ ${name} ${event.message}${event.status != null ? ` ${event.status}` : ''} (${event.attempts} attempt(s))`,
                    );
                    return;
                case 'done':
                    if (lifecycle)
                        logger.debug?.(
                            `${name} done ${event.ok ? 'ok' : 'failed'} in ${event.ms}ms (${event.attempts} attempt(s))`,
                        );
                    return;
                default:
                    // 'delta' — per-chunk streaming output; never logged (raw data).
                    return;
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
