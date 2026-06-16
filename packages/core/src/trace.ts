// Zero-infra observability sink: append every StitchEvent as a JSONL record and,
// optionally, print a compact colored one-line-per-event summary to stderr. No deps.
import type { DriftLevel, StitchEvent, TraceSink } from './types';
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
        handle(event: StitchEvent, ctx: { name: string }): void {
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
