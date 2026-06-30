// A Pino TraceSink for StitchAPI — the logger-specific twin of core's `loggerSink`
// and `@stitchapi/nest`'s NestJS-flavored `loggerSink`. It forwards the stitch event
// stream to a Pino logger, mapping each {@link StitchEvent} to a Pino level and the
// STRUCTURED record Pino is built for: `logger.info({ stitch, method, url, … }, msg)`.
//
// Bring your own pino. The sink imports no logger — it talks to a tiny structural
// {@link PinoLoggerLike} surface, so a real `pino()` instance, a child logger, and a
// plain test double all satisfy it (mirroring core's "contract, not dependency"
// stance). `pino` is the single peer dependency.
import type { StitchEvent, TraceContext, TraceSink } from 'stitchapi';
import { compact } from 'stitchapi';

// ---------------------------------------------------------------------------
// logger contract
// ---------------------------------------------------------------------------

/**
 * A single Pino log method. Pino accepts both shapes — `log(msg)` and the structured
 * `log(mergingObject, msg)` — so this is declared as the union to keep a real pino
 * instance and a minimal test double interchangeable. This sink always calls the
 * structured form (`obj, msg`).
 */
export interface PinoLogFn {
    (obj: object, msg?: string): void;
    (msg: string): void;
}

/**
 * The minimal slice of a Pino logger this sink calls — declared structurally so a real
 * `pino()` instance, a `logger.child({ … })`, and a plain `{ error, warn, info, debug,
 * trace }` test double all satisfy it. `child` is optional and never required by this
 * sink (it is exposed only so a caller can compose one), so a partial logger is fine.
 */
export interface PinoLoggerLike {
    error: PinoLogFn;
    warn: PinoLogFn;
    info: PinoLogFn;
    debug: PinoLogFn;
    trace: PinoLogFn;
    child?: (bindings: object) => PinoLoggerLike;
}

// The Pino levels this sink maps events onto — a strict subset of the five standard
// methods every pino logger exposes. (Pino also has `fatal`; this sink never escalates
// to it — a stitch `error` event is the failure of one call, not a process-fatal.)
type PinoLevel = 'error' | 'warn' | 'info' | 'debug';

/** Options for {@link pinoSink}. */
export interface PinoSinkOptions {
    /**
     * Emit the happy-path lifecycle events: `start` → `debug`, `result` → `info`,
     * `done` → `debug`. Default `true`. `start`/`done` sit at `debug` so a production
     * pino level (`info`) hides them by default; set `false` to drop the lifecycle
     * entirely and log only retries, drift findings, and errors.
     */
    lifecycle?: boolean;
}

// ---------------------------------------------------------------------------
// the sink
// ---------------------------------------------------------------------------

/**
 * A {@link TraceSink} that forwards the stitch event stream to a Pino logger (or any
 * {@link PinoLoggerLike}), mapping each {@link StitchEvent} to a Pino level and logging
 * the STRUCTURED form Pino is designed for — a metadata object plus a short message:
 *
 * - `error` → `error`
 * - `drift` → `error` / `warn` / `debug`, following the finding's `level`
 * - `progress` → `warn` when the phase is `retry` or `circuit` (the upstream is flaky
 *   or the breaker tripped), else `debug` (routine throttle / paginate / cache waits)
 * - `start` → `debug`, `result` → `info`, `done` → `debug` (only when `lifecycle`)
 * - `delta` → dropped (per-chunk streaming output — it is raw response data)
 *
 * SECURITY: a custom sink receives the **raw** event (core only redacts inside its own
 * built-in sinks), so a `start` event's `input.headers` still holds `authorization` /
 * `cookie` and a `delta`'s `chunk` is raw response data. This sink therefore logs
 * **only metadata** — name, method, redacted URL, status, attempt counts, drift
 * path/level/change, phase, waited timing — never `event.input`, `event.data`, a
 * `delta` chunk, or `JSON.stringify(event)`, and it strips the URL query (it can carry
 * `?api_key=…`). That keeps it safe on a secret-bearing seam independent of core's
 * trace redaction.
 *
 * @example
 * ```ts
 * import { seam } from 'stitchapi';
 * import { pinoSink } from '@stitchapi/pino';
 * import pino from 'pino';
 *
 * const api = seam({ trace: pinoSink(pino()) });
 * ```
 */
export function pinoSink(
    logger: PinoLoggerLike,
    options: PinoSinkOptions = {},
): TraceSink {
    const lifecycle = options.lifecycle ?? true;
    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            // A streamed chunk is raw response data — never logged, regardless of options.
            if (event.type === 'delta') return;
            const level = levelFor(event, lifecycle);
            if (level === null) return; // dropped (lifecycle off, or `info` announcement)
            const record = recordFor(ctx.name, event);
            if (record === null) return;
            // Pino's structured form: a metadata-only `obj` plus a short message.
            logger[level](record.obj, record.msg);
        },
        // Logging is synchronous; nothing is buffered to drain.
    };
}

// The per-event level rules — the crux core's per-type map can't express, mirrored from
// `@stitchapi/nest`'s `nestLevel`. A `retry`/`circuit` progress means the upstream is
// misbehaving → surface at `warn`, while a routine throttle/paginate/cache wait stays at
// `debug`; the happy-path lifecycle is gated by `lifecycle` (`null` drops it); drift
// follows its finding level but pins info-drift to `debug`. An `info` announcement is
// dropped (`null`), exactly as core's default does.
function levelFor(event: StitchEvent, lifecycle: boolean): PinoLevel | null {
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
            return null; // 'info' (announcement) + 'delta' (dropped at the call site)
    }
}

// Drop the query string (it may carry secrets, e.g. `?api_key=…`) before logging.
function redactUrl(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

// Build the metadata-only structured record pino logs: a flat `obj` of safe fields plus
// a short `msg`. The `stitch` name is on every record so log queries can pivot on it.
//
// SECURITY: this receives the **raw** event (core only redacts inside its own built-in
// sinks), so a `start` event's `input.headers` still holds `authorization` / `cookie`
// and a `delta`'s `chunk` is raw response data. It therefore logs **only metadata** —
// name, method, redacted URL, status, attempt counts, drift path/level/change, phase,
// waited timing — never `event.input`, `event.data`, a `delta` chunk, or
// `JSON.stringify(event)`, and it strips the URL query. `null` ⇒ skip the event.
function recordFor(
    name: string,
    event: StitchEvent,
): { obj: object; msg: string } | null {
    switch (event.type) {
        case 'start':
            return {
                obj: {
                    stitch: name,
                    method: event.method,
                    url: redactUrl(event.url),
                },
                msg: `→ ${name} ${event.method} ${redactUrl(event.url)}`,
            };
        case 'progress':
            return {
                obj: {
                    stitch: name,
                    phase: event.phase,
                    attempt: event.attempt,
                    ...(event.waited !== undefined
                        ? { waited: event.waited }
                        : {}),
                },
                msg: `· ${name} ${event.phase}#${event.attempt}${
                    event.waited !== undefined
                        ? ` waited ${event.waited}ms`
                        : ''
                }`,
            };
        case 'drift': {
            const f = event.finding;
            return {
                obj: compact({
                    stitch: name,
                    path: f.path,
                    level: f.level,
                    change: f.change,
                    detail: f.detail,
                }),
                msg: `drift ${name} ${f.path} ${f.change}${f.detail ? ` (${f.detail})` : ''}`,
            };
        }
        case 'result':
            return {
                obj: {
                    stitch: name,
                    status: event.status,
                    attempts: event.attempts,
                },
                msg: `← ${name} ${event.status} (${event.attempts} attempt(s))`,
            };
        case 'error':
            return {
                obj: {
                    stitch: name,
                    message: event.message,
                    ...(event.status != null ? { status: event.status } : {}),
                    attempts: event.attempts,
                },
                msg: `✗ ${name} ${event.message}${event.status != null ? ` ${event.status}` : ''} (${event.attempts} attempt(s))`,
            };
        case 'done':
            return {
                obj: {
                    stitch: name,
                    ok: event.ok,
                    elapsed: event.elapsed,
                    attempts: event.attempts,
                },
                msg: `${name} done ${event.ok ? 'ok' : 'failed'} in ${event.elapsed}ms (${event.attempts} attempt(s))`,
            };
        default:
            return null; // 'info' + 'delta' — never logged
    }
}
