// The three bridges between core primitives and the NestJS world (ADR 0006
// Decisions 6-8). None of them CHANGES core — they are built ON it: `nestLoggerSink` and
// `fromNestConfig` DELEGATE to core's `loggerSink` / `secretFrom` (passing Nest-flavored
// level/format/source adapters), and `nestBorrowStore` wraps a `StitchStore`. A TraceSink,
// a `Secret` thunk, and a StitchStore are all existing extension points.
import { Logger } from '@nestjs/common';
import { loggerSink as coreLoggerSink, secretFrom } from 'stitchapi';
import type {
    LoggerLike as CoreLoggerLike,
    LogLevel,
    StitchEvent,
    StitchStore,
    TraceSink,
} from 'stitchapi';

/**
 * The minimal logger surface this sink calls — declared structurally so Nest's
 * `Logger` satisfies it and a plain `{ log, warn, error, debug, verbose }` test
 * double works too. `debug`/`verbose` are optional and guarded at the call site,
 * so a partial logger (or one whose level hides them) is fine.
 */
export interface NestLoggerLike {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
    verbose?(message: string): void;
}

/** Options for {@link nestLoggerSink}. */
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
 * (or any {@link NestLoggerLike}), mapping each {@link StitchEvent} to a log level:
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
export function nestLoggerSink(
    logger: NestLoggerLike = new Logger('Stitch'),
    options: NestLoggerSinkOptions = {},
): TraceSink {
    const lifecycle = options.lifecycle ?? true;
    // DELEGATE the event→level→log dispatch (and the never-log-delta rule) to core's
    // `loggerSink`, supplying Nest's house style: a verbose-aware logger adapter, the
    // per-instance level rules (`nestLevel`), and the glyph one-liners (`nestFormat`). The
    // resulting levels and messages are identical to the hand-rolled switch this replaced.
    return coreLoggerSink(toCoreLogger(logger), {
        level: (event) => nestLevel(event, lifecycle),
        format: (event, ctx) => nestFormat(ctx.name, event),
    });
}

/**
 * @deprecated Renamed to {@link nestLoggerSink}. The bare name collided with core's
 * generic `loggerSink` (you had to alias one at every shared import site), so the
 * cross-package logger-sink family is now ecosystem-qualified — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). This alias is kept
 * through the `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export const loggerSink = nestLoggerSink;

/**
 * @deprecated Renamed to {@link NestLoggerLike} (it was indistinguishable from core's
 * `LoggerLike`) — see [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md).
 * Kept through the `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export type LoggerLike = NestLoggerLike;

// Adapt a Nest `Logger` to core's `LoggerLike`. Core's level vocabulary is
// error|warn|info|debug; Nest's is error|warn|log|debug|verbose. We route core `info` →
// Nest `verbose` (the level `result` lands on) and guard `debug`/`verbose`, which a partial
// logger — or one whose level hides them — may omit.
function toCoreLogger(logger: NestLoggerLike): CoreLoggerLike {
    return {
        error: (m) => logger.error(m),
        warn: (m) => logger.warn(m),
        info: (m) => logger.verbose?.(m),
        debug: (m) => logger.debug?.(m),
    };
}

// Nest's per-event level rules — the crux core's per-type `levels` map can't express. A
// `retry`/`circuit` progress means the upstream is misbehaving → surface at warn, while a
// routine throttle/paginate/cache wait stays at debug; the happy-path lifecycle is gated by
// `lifecycle` (`null` drops it); drift follows its finding level but pins info-drift to
// debug. `result` → core `info`, which `toCoreLogger` routes to Nest `verbose`. An `info`
// event (a strategy announcement) is dropped, exactly as the previous switch did.
function nestLevel(event: StitchEvent, lifecycle: boolean): LogLevel | null {
    switch (event.type) {
        case 'start':
            return lifecycle ? 'debug' : null;
        case 'progress':
            return event.phase === 'retry' || event.phase === 'circuit'
                ? 'warn'
                : 'debug';
        case 'drift':
            return event.finding.level === 'error'
                ? 'error'
                : event.finding.level === 'warn'
                  ? 'warn'
                  : 'debug';
        case 'result':
            return lifecycle ? 'info' : null;
        case 'error':
            return 'error';
        case 'done':
            return lifecycle ? 'debug' : null;
        default:
            return null; // 'info' (announcement) + 'delta' (already dropped by core)
    }
}

// Paint the metadata-only one-liner Nest logs — name, method, redacted URL, status, attempt
// counts, drift path/level, timing.
//
// SECURITY: a custom formatter receives the **raw** event (core only redacts inside its own
// built-in sinks), so a `start` event's `input.headers` still holds `authorization` /
// `cookie` and a `delta`'s `chunk` is raw response data. This logs **only metadata** — never
// `event.input`, `event.value`, a `delta` chunk, or `JSON.stringify(event)` — and strips the
// URL query (it can carry `?api_key=…`), keeping the sink safe on a secret-bearing seam
// independent of core's trace redaction. `null` ⇒ skip the event.
function nestFormat(name: string, event: StitchEvent): string | null {
    switch (event.type) {
        case 'start':
            return `→ ${name} ${event.method} ${redactUrl(event.url)}`;
        case 'progress':
            return `· ${name} ${event.phase}#${event.attempt}${
                event.waitedMs !== undefined
                    ? ` waited ${event.waitedMs}ms`
                    : ''
            }`;
        case 'drift': {
            const f = event.finding;
            return `drift ${name} ${f.path} ${f.change}${f.detail ? ` (${f.detail})` : ''}`;
        }
        case 'result':
            return `← ${name} ${event.status} (${event.attempts} attempt(s))`;
        case 'error':
            return `✗ ${name} ${event.message}${event.status != null ? ` ${event.status}` : ''} (${event.attempts} attempt(s))`;
        case 'done':
            return `${name} done ${event.ok ? 'ok' : 'failed'} in ${event.ms}ms (${event.attempts} attempt(s))`;
        default:
            return null; // 'info' + 'delta' — never formatted (dropped upstream)
    }
}

// Drop the query string (it may carry secrets, e.g. `?api_key=…`) before logging.
function redactUrl(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/** The minimal slice of Nest's `ConfigService` this package needs — kept structural so
 * `@nestjs/config` is not even a peer dependency. */
export interface NestConfigServiceLike {
    getOrThrow<T = string>(key: string): T;
}

/**
 * A `ConfigService`-backed secret resolver — core's `secretFrom(source, name)` bound to a Nest
 * `ConfigService`. Returns a synchronous `Secret` thunk (`() => string`) resolved at call time,
 * so the credential never lands on `__config` or in a trace. Pass it to any auth strategy:
 * `bearer(fromNestConfig(config)('API_TOKEN'))`.
 *
 * Resolution delegates to core: a missing key still throws (the `ConfigService.getOrThrow` error
 * propagates), and — like core's `env()` / `secretFrom()` — an empty value is rejected too, so a
 * blank credential can never silently ride along.
 *
 * NOTE: `Secret` is synchronous, so this cannot fetch a rotating secret per call — that
 * is what `oauth2` / `cookieSession` are for (they refresh asynchronously via the vault).
 */
export function fromNestConfig(
    config: NestConfigServiceLike,
): (key: string) => () => string {
    // `getOrThrow` already throws on a missing key (Nest's own error); core's `secretFrom` adds
    // the empty-value rejection and the `() => string` thunk shape, matching `env()`/`secretFrom()`.
    return (key: string) =>
        secretFrom((name) => String(config.getOrThrow<string>(name)), key);
}

/**
 * Wrap a store the package does **not** own: `get`/`set`/`incr` delegate, but `close` is
 * omitted, so a seam's `close()` never tears down a store the app passed in (ADR 0006
 * Decision 8). The app — not the package — disposes a store it provides.
 */
export function nestBorrowStore(store: StitchStore): StitchStore {
    return {
        get: (key) => store.get(key),
        set: (key, value, ttlMs) => store.set(key, value, ttlMs),
        incr: (key, ttlMs) => store.incr(key, ttlMs),
    };
}

/**
 * @deprecated Renamed to {@link fromNestConfig} so the adapter's secret-source
 * constructor is ecosystem-qualified (a bare `fromConfig` would collide with any
 * other framework's config bridge) — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the
 * `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export const fromConfig = fromNestConfig;

/**
 * @deprecated Renamed to {@link nestBorrowStore} so the helper is ecosystem-qualified
 * (a bare `borrowStore` would collide with any other adapter's store wrapper) — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the
 * `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export const borrowStore = nestBorrowStore;

/**
 * @deprecated Renamed to {@link NestConfigServiceLike} so the duck-type is
 * ecosystem-qualified — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the
 * `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export type ConfigServiceLike = NestConfigServiceLike;
