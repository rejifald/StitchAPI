// Zero-infra observability sink: append every StitchEvent as a JSONL record and,
// optionally, print a compact colored one-line-per-event summary to stderr. No deps.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DriftLevel, StitchEvent, TraceSink } from './types';

export interface TraceOptions {
    console?: boolean; // pretty one-line-per-event to stderr (default true)
    file?: string | false; // JSONL path; default `${process.env.HOME}/.stitch/runs/proto.jsonl`; false disables
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

const LEVEL_COLOR: Record<DriftLevel, string> = { error: RED, warn: YELLOW, info: BLUE };

function paint(color: string, text: string): string {
    return `${color}${text}${RESET}`;
}

// Render one StitchEvent as a compact human-readable line (without trailing newline).
function format(name: string, event: StitchEvent): string | null {
    switch (event.type) {
        case 'start':
            return `${paint(CYAN, '→')} ${name} ${event.method} ${event.url}`;
        case 'progress': {
            const waited = event.waitedMs != null ? ` waited ${event.waitedMs}ms` : '';
            return paint(DIM, `  · ${name} ${event.phase}#${event.attempt}${waited}`);
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
    if (file === undefined) return `${process.env.HOME}/.stitch/runs/proto.jsonl`;
    return file;
}

export function createTrace(opts?: TraceOptions): TraceSink & { path: string | null } {
    const toConsole = opts?.console ?? true;
    const path = resolvePath(opts?.file);
    let dirReady = false;

    return {
        path,
        handle(event: StitchEvent, ctx: { name: string }): void {
            if (path) {
                if (!dirReady) {
                    mkdirSync(dirname(path), { recursive: true });
                    dirReady = true;
                }
                appendFileSync(path, `${JSON.stringify({ name: ctx.name, ...event })}\n`);
            }
            if (toConsole) {
                const line = format(ctx.name, event);
                if (line != null) process.stderr.write(`${line}\n`);
            }
        },
        // Sync appends mean there is nothing buffered to drain.
        flush(): void {},
    };
}
