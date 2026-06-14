/**
 * A2 — real-run trace collector for the playground DAG.
 *
 * Wraps the browser `stitch` build so every `stitch()` call a snippet makes
 * surfaces as a {@link StitchTraceEntry} — the shape the output panel's Mermaid
 * DAG renders (`output-format.ts#traceToMermaid`). Without this, `RunResult.trace`
 * is always empty and the DAG only ever shows "(no trace)".
 *
 * How it works (NO fork of packages/core): each `stitch(config)` gets a core
 * `TraceSink` injected into its config. The engine `tee`s every lifecycle event
 * (`start → … → done`) through that sink on BOTH the `await` and `.stream()`
 * paths (stitch.ts), so the sink sees one start/done pair per call. We translate
 * each pair into a `StitchTraceEntry` and emit it (plus stream `chunk`s) through
 * the run's progress sink — the SAME channel the worker body already relays to
 * the host and accumulates into the final result.
 *
 * Correlation: a stitch instance's calls are tracked in a FIFO of open entries
 * (`start` opens, `done` closes-and-emits). Sequential snippet code — the common
 * case — is exact; concurrent calls on one instance degrade gracefully (entries
 * still emit; timing may attribute to a sibling) and NEVER throw.
 *
 * Scope (A2): nodes render from real runs. Dependency EDGES (`dependsOn`) need
 * the composition graph core doesn't emit, and `seam`-created stitches aren't
 * wrapped yet — both are tracked as follow-ups in RELEASE.md.
 */
import type { StitchTraceEntry } from '../component/runner';
import type { ProgressSink } from './worker-entry';

import { multiplex } from 'stitchapi';
import type { StitchEvent, TraceSink } from 'stitchapi';

/** Header names whose presence we surface as redacted in the trace entry. */
const SECRET_HEADERS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'proxy-authorization',
]);

/** Mutable state for one in-flight stitch call (between `start` and `done`). */
interface OpenEntry {
    id: string;
    label: string;
    method: string;
    url: string;
    headersRedacted?: string[];
    status?: number;
    error?: { name: string; message: string };
    chunks: number;
}

export interface TraceCollector {
    /** Drop-in replacement for the build's `stitch`, exposed to the snippet. */
    stitch: (config: unknown) => unknown;
    /**
     * The {@link WorkerEnv.bindProgress} hook: bind the run's progress sink so
     * trace/chunk events can flow. Returns a teardown that unbinds it.
     */
    bindProgress: (sink: ProgressSink) => () => void;
}

/** Sensitive header names present on a stitch input's headers, if any. */
function redactedNames(headers: unknown): string[] | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const names = Object.keys(headers as Record<string, unknown>).filter((h) =>
        SECRET_HEADERS.has(h.toLowerCase()),
    );
    return names.length ? names : undefined;
}

/** Best-effort stringify of a stream chunk for the `chunk` event's `text`. */
function chunkText(chunk: unknown): string {
    if (typeof chunk === 'string') return chunk;
    try {
        return JSON.stringify(chunk) ?? String(chunk);
    } catch {
        return String(chunk);
    }
}

/** Build the final {@link StitchTraceEntry} from a completed open entry. */
function finalize(
    e: OpenEntry,
    ok: boolean,
    durationMs: number,
): StitchTraceEntry {
    const entry: StitchTraceEntry = {
        id: e.id,
        label: e.label,
        request: { method: e.method, url: e.url },
    };
    if (e.headersRedacted) entry.request.headersRedacted = e.headersRedacted;
    if (e.status !== undefined)
        entry.response = { status: e.status, ok, durationMs };
    if (e.error) entry.error = e.error;
    if (e.chunks > 0) entry.stream = { chunks: e.chunks };
    return entry;
}

/**
 * Create a trace collector around a core `stitch`. `coreStitch` is the browser
 * build's `stitch` (re-exported from `stitchapi`); the returned `stitch` injects
 * the DAG trace sink and is otherwise identical (same call / `.stream()` /
 * `.with()` behaviour — the runtime is unchanged).
 */
export function createTraceCollector(
    coreStitch: (config: unknown) => unknown,
): TraceCollector {
    let activeSink: ProgressSink | undefined;
    let counter = 0;

    // One DAG sink per stitch INSTANCE, so each instance's calls correlate in
    // their own FIFO. All instances emit to the single run-scoped `activeSink`.
    const makeDagSink = (): TraceSink => {
        const open: OpenEntry[] = [];
        return {
            handle(event: StitchEvent, ctx: { name: string }): void {
                switch (event.type) {
                    case 'start':
                        open.push({
                            id: `stitch-${(counter += 1)}`,
                            label: ctx.name,
                            method: event.method,
                            url: event.url,
                            headersRedacted: redactedNames(
                                event.input?.headers,
                            ),
                            chunks: 0,
                        });
                        break;
                    case 'result':
                        if (open[0]) open[0].status = event.status;
                        break;
                    case 'error':
                        if (open[0]) {
                            open[0].error = {
                                name: event.name,
                                message: event.message,
                            };
                            if (event.status !== undefined)
                                open[0].status = event.status;
                        }
                        break;
                    case 'delta':
                        if (open[0]) {
                            open[0].chunks += 1;
                            activeSink?.({
                                type: 'chunk',
                                traceId: open[0].id,
                                text: chunkText(event.chunk),
                            });
                        }
                        break;
                    case 'done': {
                        const e = open.shift();
                        if (e)
                            activeSink?.({
                                type: 'trace',
                                entry: finalize(e, event.ok, event.ms),
                            });
                        break;
                    }
                    // 'progress' / 'drift' carry no DAG-node data — ignored.
                }
            },
        };
    };

    const stitch = (config: unknown): unknown => {
        // Mirror core's string-shorthand normalisation (`asConfig`: a string is
        // a `path`) so `stitch('https://…')` still gets a trace sink. Spreading a
        // raw string would shatter it into char-indexed keys.
        const base: Record<string, unknown> =
            typeof config === 'string'
                ? { path: config }
                : { ...((config as Record<string, unknown>) ?? {}) };
        const dag = makeDagSink();
        const userTrace = base.trace;
        // Compose with a user-supplied sink; otherwise the DAG sink alone. This
        // also neutralises `trace:'console'` (writes to an absent stderr in the
        // browser); `trace:false` is overridden only for the DAG, which never
        // writes console/JSONL, so the "no side effects by default" intent holds.
        base.trace =
            userTrace && typeof userTrace === 'object'
                ? multiplex(userTrace as TraceSink, dag)
                : dag;
        return coreStitch(base);
    };

    const bindProgress = (sink: ProgressSink): (() => void) => {
        activeSink = sink;
        return () => {
            if (activeSink === sink) activeSink = undefined;
        };
    };

    return { stitch, bindProgress };
}
