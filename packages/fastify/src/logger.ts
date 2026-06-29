// A self-contained logger → TraceSink bridge for Fastify's built-in Pino logger
// (`fastify.log` / `request.log`). It is deliberately INLINED here — not imported from
// `@stitchapi/pino` or `@stitchapi/nest` — so this plugin is a single, independently
// mergeable unit with no cross-package coupling. The mapping mirrors the house style of
// the Nest bridge (`packages/nest/src/bridges.ts`), adapted to Pino's level vocabulary.
import type { StitchEvent, TraceContext, TraceSink } from 'stitchapi';

/**
 * The minimal logger surface this sink calls — declared structurally so Fastify's
 * `fastify.log` / `request.log` (a Pino `FastifyBaseLogger`) satisfies it, and a plain
 * `{ error, warn, info, debug }` test double works too. This is exactly Pino's
 * level-method shape, which is also core's own `LoggerLike`.
 */
export interface FastifyLoggerLike {
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
    debug(message: string): void;
}

/** The four levels this sink dispatches to (a subset of Pino's). */
type Level = 'error' | 'warn' | 'info' | 'debug';

export interface FastifyLoggerSinkOptions {
    /**
     * Emit the happy-path lifecycle events (`start` → `debug`, `result` → `info`,
     * `done` → `debug`). Default `true`. They sit at `debug`/`info` so a production log
     * level naturally hides the noisy ones — set `false` to drop them entirely and log
     * only retries, drift findings, and errors.
     */
    lifecycle?: boolean;
}

// The per-event level rule. A `retry`/`circuit` progress means the upstream is misbehaving
// → surface at `warn`; a routine throttle/paginate/cache wait stays at `debug`. Drift follows
// its finding level. The happy-path lifecycle is gated by `lifecycle` (`null` ⇒ drop). `info`
// announcements and `delta` chunks are dropped (a `delta` chunk is raw response data).
function levelFor(event: StitchEvent, lifecycle: boolean): Level | null {
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
            return null; // 'info' (announcement) + 'delta' (raw response data)
    }
}

// Paint the metadata-only one-liner.
//
// SECURITY: a custom sink receives the **raw** event (core only redacts inside its own
// built-in sinks), so a `start` event's `input.headers` still holds `authorization` /
// `cookie` and a `delta`'s `chunk` is raw response data. This logs **only metadata** — name,
// method, scrubbed URL, status, attempt counts, drift path/level, timing — never
// `event.input`, `event.value`, a `delta` chunk, or `JSON.stringify(event)`, and it strips the
// URL query (it can carry `?api_key=…`). `null` ⇒ skip the event.
function messageFor(name: string, event: StitchEvent): string | null {
    switch (event.type) {
        case 'start':
            return `→ ${name} ${event.method} ${scrubUrl(event.url)}`;
        case 'progress':
            return `· ${name} ${event.phase}#${event.attempt}${
                event.waited !== undefined ? ` waited ${event.waited}ms` : ''
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
            return `${name} done ${event.ok ? 'ok' : 'failed'} in ${event.elapsed}ms (${event.attempts} attempt(s))`;
        default:
            return null; // 'info' + 'delta'
    }
}

// Drop the query string (it may carry secrets, e.g. `?api_key=…`) before logging.
function scrubUrl(url: string): string {
    const q = url.indexOf('?');
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/**
 * A {@link TraceSink} that forwards the stitch event stream to Fastify's built-in Pino
 * logger (or any {@link FastifyLoggerLike}), mapping each {@link StitchEvent} to a Pino
 * level: `error` → `error`, a flaky `progress` (`retry`/`circuit`) → `warn`, `drift` → its
 * finding level, the happy-path lifecycle (`start`/`result`/`done`) → `debug`/`info`, and a
 * `delta` chunk is **never** logged (it is raw response data).
 *
 * Used by the plugin to bridge `fastify.log` into the seam (see `logger` option). It logs
 * **only metadata**, so it is safe on a secret-bearing seam regardless of core's own trace
 * redaction (see the SECURITY note above).
 */
export function fastifyLoggerSink(
    logger: FastifyLoggerLike,
    options: FastifyLoggerSinkOptions = {},
): TraceSink {
    const lifecycle = options.lifecycle ?? true;
    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            const level = levelFor(event, lifecycle);
            if (level === null) return;
            const message = messageFor(ctx.name, event);
            if (message == null) return;
            logger[level](message);
        },
        // Logging is synchronous; nothing is buffered to drain.
    };
}
