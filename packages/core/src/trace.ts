// Zero-infra observability sink: append every StitchEvent as a JSONL record and,
// optionally, print a compact colored one-line-per-event summary to stderr. No deps.
import type { DriftLevel, StitchEvent, TraceSink } from './types';
import { dirnameOf, nodeFs, readEnv } from './util';

export interface TraceOptions {
    console?: boolean; // pretty one-line-per-event to stderr (default true)
    file?: string | false; // JSONL path; default `${process.env.HOME}/.stitch/runs/proto.jsonl`; false disables
}

// Header names whose values are secrets: redacted before any event leaves for a
// built-in sink (JSONL/console). Matched case-insensitively wherever headers appear
// in an event payload (start input.headers, result/response headers, etc.).
const SECRET_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
]);
const REDACTED = '[REDACTED]';

// Deep-clone `value`, replacing any object property whose key is a secret header
// name (case-insensitive) with '[REDACTED]'. Non-mutating: the engine keeps the
// real headers; only the trace copy is scrubbed.
function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : redact(v);
        }
        return out;
    }
    return value;
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
            return `${paint(CYAN, '→')} ${name} ${event.method} ${event.url}`;
        case 'progress': {
            const waited =
                event.waitedMs != null ? ` waited ${event.waitedMs}ms` : '';
            return paint(
                DIM,
                `  · ${name} ${event.phase}#${event.attempt}${waited}`,
            );
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
                    `${JSON.stringify(redact({ name: ctx.name, ...event }))}\n`,
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
