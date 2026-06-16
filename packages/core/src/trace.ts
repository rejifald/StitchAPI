// Zero-infra observability sink: append every StitchEvent as a JSONL record and,
// optionally, print a compact colored one-line-per-event summary to stderr. No deps.
import type { DriftLevel, StitchEvent, TraceContext, TraceSink } from './types';
import { dirnameOf, isSecretQueryKey, nodeFs, readEnv, scrubUrl } from './util';

export interface TraceOptions {
    console?: boolean; // pretty one-line-per-event to stderr (default true)
    file?: string | false; // JSONL path; default `${process.env.HOME}/.stitch/runs/proto.jsonl`; false disables
    /**
     * Max length (in characters of the JSON encoding) of the request body and the
     * response value persisted to the JSONL sink. Anything larger is replaced with a
     * `{ truncated, bytes, preview }` marker, so a multi-MB response never bloats the
     * log or persists a payload in full. Default {@link DEFAULT_MAX_BODY_BYTES}; pass
     * `false` for full capture (the pre-1.0 behaviour); `0` keeps only the marker.
     */
    maxBodyBytes?: number | false;
    /**
     * Extra header names (case-insensitive) to redact on top of the built-in
     * denylist. Additive — you can widen the denylist but never shrink it, so a
     * custom value can't accidentally un-redact `authorization`/`cookie`/…
     */
    redactHeaders?: readonly string[];
}

// Header names whose values are secrets: redacted before any event leaves for a
// built-in sink (JSONL/console). Matched case-insensitively wherever headers appear
// in an event payload (start input.headers, result/response headers, etc.).
const SECRET_HEADERS = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
];
const REDACTED = '[REDACTED]';

// Default body/result truncation cap: large enough to keep a small JSON response or
// error body fully readable, small enough to bound on-disk growth and limit how much
// payload is persisted by default. Opt into full capture with `maxBodyBytes: false`.
const DEFAULT_MAX_BODY_BYTES = 2048;

// Deep-clone `value`, replacing any object property whose key is in `denylist`
// (lowercased secret header names) with '[REDACTED]'. Non-mutating: the engine keeps
// the real headers; only the trace copy is scrubbed.
function redact(value: unknown, denylist: Set<string>): unknown {
    if (Array.isArray(value)) return value.map((v) => redact(v, denylist));
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = denylist.has(k.toLowerCase())
                ? REDACTED
                : redact(v, denylist);
        }
        return out;
    }
    return value;
}

// Replace a request body / response value with a compact marker once its JSON
// encoding exceeds `max` characters; `false` disables truncation (full capture).
// The preview is the JSON prefix of the ALREADY-REDACTED value, so header secrets
// never reach it (body-field secrets can — full capture is opt-in, not the default).
function capBody(value: unknown, max: number | false): unknown {
    if (max === false || value === undefined || value === null) return value;
    try {
        const json = JSON.stringify(value);
        if (json.length <= max) return value;
        return {
            truncated: true,
            bytes: json.length,
            preview: json.slice(0, max),
        };
    } catch {
        // Unserializable (a cycle, or a value that stringifies to undefined) —
        // leave it to the outer writer, which already JSON.stringifies the record.
        return value;
    }
}

// Replace the values of secret-bearing query params (api_key, access_token, …) with
// '[REDACTED]', the same denylist scrubUrl applies to the URL. Shallow: query slots
// are flat name → string | string[]; a whole secret value is dropped wholesale.
function redactSecretQuery(
    query: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query))
        out[k] = isSecretQueryKey(k) ? REDACTED : v;
    return out;
}

// Build the final JSONL record for one event: header redaction everywhere, URL
// credential-scrubbing on `start`, and body/result truncation. Operates on a fresh
// clone — the live event the engine emitted is untouched.
function prepareRecord(
    name: string,
    event: StitchEvent,
    denylist: Set<string>,
    maxBody: number | false,
): unknown {
    const record = redact({ name, ...event }, denylist) as Record<
        string,
        unknown
    >;
    if (event.type === 'start') {
        if (typeof record['url'] === 'string')
            record['url'] = scrubUrl(record['url']);
        const input = record['input'];
        if (input !== null && typeof input === 'object') {
            const i = input as Record<string, unknown>;
            // Body: size-bound it. Query: redact secret param values so the
            // structured input can't leak what scrubUrl already stripped from `url`.
            if ('body' in i) i['body'] = capBody(i['body'], maxBody);
            const query = i['query'];
            if (query !== null && typeof query === 'object')
                i['query'] = redactSecretQuery(
                    query as Record<string, unknown>,
                );
        }
    } else if (event.type === 'result') {
        record['value'] = capBody(record['value'], maxBody);
    } else if (event.type === 'delta') {
        // A streamed chunk is response-body data too — cap it like `result.value`.
        record['chunk'] = capBody(record['chunk'], maxBody);
    }
    return record;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

const LEVEL_COLOR: Record<DriftLevel, string> = {
    error: RED,
    warn: YELLOW,
    info: BLUE,
};

function paint(color: string, text: string): string {
    return `${color}${text}${RESET}`;
}

// Render one StitchEvent as a compact human-readable line (without trailing newline).
function format(name: string, event: StitchEvent): string | null {
    switch (event.type) {
        case 'start':
            return `${paint(CYAN, '→')} ${name} ${event.method} ${scrubUrl(event.url)}`;
        case 'progress': {
            const waited =
                event.waitedMs != null ? ` waited ${event.waitedMs}ms` : '';
            return paint(
                DIM,
                `  · ${name} ${event.phase}#${event.attempt}${waited}`,
            );
        }
        case 'info': {
            const detail = event.detail != null ? `: ${event.detail}` : '';
            return paint(DIM, `  ℹ ${name} ${event.topic}${detail}`);
        }
        case 'drift': {
            const f = event.finding;
            const detail = f.detail != null ? ` (${f.detail})` : '';
            return paint(
                LEVEL_COLOR[f.level],
                `  ⚠ ${name} drift[${f.level}] ${f.path} ${f.change}${detail}`,
            );
        }
        case 'result':
            return `${paint(GREEN, '←')} ${name} ${event.status} ok (${event.attempts} attempt(s))`;
        case 'error': {
            const status = event.status != null ? ` ${event.status}` : '';
            return paint(RED, `✗ ${name} ${event.message}${status}`);
        }
        case 'done':
            return paint(DIM, `  ${name} done in ${event.ms}ms`);
        default:
            return null; // 'delta' and any future events: file-only, no console line
    }
}

// The log levels {@link loggerSink} maps events onto. A strict subset of the methods
// every host logger (pino/winston/console) exposes — DriftLevel ('error'|'warn'|'info')
// is a subset too, so a drift finding's own level is a valid LogLevel as-is.
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** The minimal logger `loggerSink` needs — pino, winston, console, and most host loggers satisfy it. */
export interface LoggerLike {
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
    debug(message: string): void;
}

export interface LoggerSinkOptions {
    /**
     * Override the default event-type → level mapping. By default: result→info, error→error,
     * start/progress/info/done→debug, drift→the finding's own level, and `delta` is never logged
     * (it carries response-body data). Set a type to a level to override; `drift` is special-
     * cased to the finding level unless you override it here.
     */
    levels?: Partial<Record<StitchEvent['type'], LogLevel>>;
    /**
     * Resolve the level per event INSTANCE — a strict superset of {@link levels} (which keys only on
     * the event *type*). Return a {@link LogLevel} to log at it, `null` to DROP the event, or
     * `undefined` to defer to {@link levels} / the defaults. Lets a host express conditional rules the
     * per-type map can't — e.g. a `retry`/`circuit` `progress` at `warn` but a routine throttle at
     * `debug`, or dropping the happy-path lifecycle. Takes precedence over {@link levels}. `delta` is
     * dropped before this runs, so it is never called for one.
     */
    level?: (
        event: StitchEvent,
        ctx: TraceContext,
    ) => LogLevel | null | undefined;
    /**
     * Override the payload-free one-liner. Return the message to log, or `null` to skip the event.
     * The default formatter emits metadata only — name, method, scrubbed URL, status, attempt counts,
     * drift path/level, timing — never `event.input`, `event.value`, or a `delta` chunk. SECURITY: if
     * you supply your own, YOU take on that guarantee — a custom sink receives the **raw** event, so
     * log only metadata, never a header/body/chunk value or `JSON.stringify(event)`. `delta` is
     * dropped before this runs.
     */
    format?: (event: StitchEvent, ctx: TraceContext) => string | null;
}

// The DEFAULT event-type → level mapping (drift is resolved per-finding at call time, and
// 'delta' is absent because it is never logged — a streamed chunk is raw response data).
const DEFAULT_LEVELS: Record<
    Exclude<StitchEvent['type'], 'drift' | 'delta'>,
    LogLevel
> = {
    start: 'debug',
    progress: 'debug',
    info: 'debug',
    result: 'info',
    error: 'error',
    done: 'debug',
};

// Render one StitchEvent as a PLAIN (no ANSI) metadata-only one-liner — the same
// name/method/scrubbed-url/status/attempts/timing fields `format` paints, minus colour and
// glyphs. NEVER includes the response body / result value / delta chunk, so it is safe to log
// verbatim even though a custom sink receives the un-redacted event. `null` ⇒ don't log.
function summary(name: string, event: StitchEvent): string | null {
    switch (event.type) {
        case 'start':
            return `${name} ${event.method} ${scrubUrl(event.url)}`;
        case 'progress': {
            const waited =
                event.waitedMs != null ? ` waited ${event.waitedMs}ms` : '';
            return `${name} ${event.phase}#${event.attempt}${waited}`;
        }
        case 'info': {
            const detail = event.detail != null ? `: ${event.detail}` : '';
            return `${name} ${event.topic}${detail}`;
        }
        case 'drift': {
            const f = event.finding;
            const detail = f.detail != null ? ` (${f.detail})` : '';
            return `${name} drift[${f.level}] ${f.path} ${f.change}${detail}`;
        }
        case 'result':
            return `${name} ${event.status} ok (${event.attempts} attempt(s))`;
        case 'error': {
            const status = event.status != null ? ` ${event.status}` : '';
            return `${name} ${event.message}${status}`;
        }
        case 'done':
            return `${name} done in ${event.ms}ms`;
        default:
            return null; // 'delta': raw response data — never logged.
    }
}

/**
 * A {@link TraceSink} that bridges the stitch event stream to any host logger — pino, winston,
 * the `console`, anything that is a {@link LoggerLike} — mapping each {@link StitchEvent} to a
 * log level. The logger-agnostic core twin of `@stitchapi/nest`'s NestJS-specific `loggerSink`.
 *
 * Default level map: `result` → `info`, `error` → `error`, `start`/`progress`/`info`/`done` →
 * `debug`, and `drift` → the finding's own `level` ('error'|'warn'|'info'). A `delta` event is
 * **never** logged — a streamed chunk is raw response data. Override any per-type level via
 * {@link LoggerSinkOptions.levels} (e.g. `{ result: 'debug' }`); `drift` still follows the finding
 * level unless you pin it there too. For conditional rules the per-type map can't express, pass a
 * {@link LoggerSinkOptions.level} resolver (per-instance; `null` drops the event); for a different
 * house style, pass a {@link LoggerSinkOptions.format} formatter (it then owns the payload-free
 * guarantee). `@stitchapi/nest`'s Nest-flavored `loggerSink` is built by delegating here with both.
 *
 * SECURITY: a custom sink receives the **raw** event (core only redacts inside its own built-in
 * sinks), so a `start` event's `input.headers` still holds `authorization` / `cookie` and a
 * `delta`'s `chunk` is raw response data. This sink therefore logs **only metadata** — name,
 * method, scrubbed URL, status, attempt counts, drift path/level, timing — never `event.input`,
 * `event.value`, a `delta` chunk, or `JSON.stringify(event)`, and it strips the URL query (it can
 * carry `?api_key=…`). That keeps it payload-free on a secret-bearing seam regardless of core's
 * trace redaction.
 *
 * @example
 * ```ts
 * import { stitch } from 'stitchapi';
 * import { loggerSink } from 'stitchapi';
 * import pino from 'pino';
 *
 * const api = stitch({ baseUrl: '…', path: '/users', trace: loggerSink(pino()) });
 * ```
 */
export function loggerSink(
    logger: LoggerLike,
    opts?: LoggerSinkOptions,
): TraceSink {
    const overrides = opts?.levels;
    const resolveLevel = opts?.level;
    const format = opts?.format;
    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            // A streamed chunk is raw response data — never logged, regardless of any option.
            if (event.type === 'delta') return;
            // Per-instance resolver wins (null ⇒ drop, undefined ⇒ defer); else per-type
            // override; else drift follows its finding level, everything else its default.
            // DriftLevel ⊂ LogLevel, so the finding level needs no map.
            let level = resolveLevel?.(event, ctx);
            if (level === null) return; // resolver dropped it
            // `undefined` ⇒ no resolver, or it deferred: fall back to the per-type override,
            // drift's finding level, or the default. (`level` is non-null here, so `??=` only
            // fires on undefined.)
            level ??=
                overrides?.[event.type] ??
                (event.type === 'drift'
                    ? event.finding.level
                    : DEFAULT_LEVELS[event.type]);
            // Default formatter is payload-free; a `format` override owns that guarantee itself.
            const message = format
                ? format(event, ctx)
                : summary(ctx.name, event);
            if (message == null) return;
            logger[level](message);
        },
        // Logging is synchronous; nothing is buffered to drain.
    };
}

// Resolve the JSONL path once: `false` disables (null), `undefined` => default under $HOME.
function resolvePath(file: TraceOptions['file']): string | null {
    if (file === false) return null;
    if (file === undefined) {
        const home = readEnv('HOME');
        return home ? `${home}/.stitch/runs/proto.jsonl` : null;
    }
    return file;
}

// stderr in Node; console.error in the browser (where `process` doesn't exist).
function writeLine(line: string): void {
    const proc = (
        globalThis as { process?: { stderr?: { write(s: string): void } } }
    ).process;
    if (proc?.stderr) proc.stderr.write(`${line}\n`);
    else console.error(line);
}

export function createTrace(
    opts?: TraceOptions,
): TraceSink & { path: string | null } {
    const toConsole = opts?.console ?? true;
    // File tracing needs node:fs — absent (browser), it is an explicit no-op.
    const fs = nodeFs();
    const path = fs ? resolvePath(opts?.file) : null;
    let dirReady = false;
    // Privacy policy resolved once: the denylist is the built-ins WIDENED by any
    // caller-supplied names (never shrunk), and bodies truncate at the cap unless
    // full capture is requested.
    const denylist = new Set([
        ...SECRET_HEADERS,
        ...(opts?.redactHeaders ?? []).map((h) => h.toLowerCase()),
    ]);
    const maxBody = opts?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    return {
        path,
        handle(event: StitchEvent, ctx: TraceContext): void {
            if (fs && path) {
                if (!dirReady) {
                    fs.mkdirSync(dirnameOf(path), { recursive: true });
                    dirReady = true;
                }
                fs.appendFileSync(
                    path,
                    `${JSON.stringify(prepareRecord(ctx.name, event, denylist, maxBody))}\n`,
                );
            }
            if (toConsole) {
                const line = format(ctx.name, event);
                if (line != null) writeLine(line);
            }
        },
        // Sync appends mean there is nothing buffered to drain.
        flush(): void {
            /* console/JSONL writes are synchronous; nothing is buffered */
        },
    };
}

/** A console-only sink: the colored one-line-per-event stream to stderr, nothing on disk. */
export function consoleSink(): TraceSink {
    return createTrace({ console: true, file: false });
}

/**
 * A file-only sink: append every event as JSONL to `path` (defaults to
 * `~/.stitch/runs/proto.jsonl`). Writing to disk is a side effect, so you reach
 * for this explicitly — a stitch never opens a trace file on its own.
 */
export function fileSink(
    path?: string,
    opts?: Omit<TraceOptions, 'console' | 'file'>,
): TraceSink {
    return createTrace({
        console: false,
        ...(path !== undefined ? { file: path } : {}),
        ...opts,
    });
}

/** Fan every event out to several sinks (e.g. console/JSONL + OTLP) — one event stream, many consumers. */
export function multiplex(...sinks: TraceSink[]): TraceSink {
    return {
        handle(event, ctx): void {
            for (const sink of sinks) sink.handle(event, ctx);
        },
        async flush(): Promise<void> {
            for (const sink of sinks) await sink.flush?.();
        },
    };
}

/** Parse `STITCH_EXPORT` (comma list, e.g. "otlp" or "console,otlp") into lowercased export names. */
export function exportsFromEnv(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}
