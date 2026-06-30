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
 * Correlation: each call is keyed by its run id (ADR 0007), which core stamps on every event's
 * ctx, so `start` opens an entry and `done` closes-and-emits it by that id. Concurrent calls and
 * interleaved CHILD runs (a cookieSession login firing mid-call) attribute exactly — no FIFO
 * guesswork — and the handler never throws.
 *
 * Scope: nodes render from real runs, and runtime-causality EDGES (`dependsOn`) now populate from
 * the `parentSpanId` core stamps on a child run's ctx (ADR 0007) — a cookieSession login (or, later, a
 * `pipe()` step) draws a parent → child edge. The STATIC `extends` composition graph is a separate
 * axis core deliberately does not emit (ADR 0007 Q4, out of scope).
 */
import type { StitchTraceEntry } from '../component/runner';
import type { ProgressSink } from './worker-entry';

import { multiplex } from 'stitchapi';
import type { StitchEvent, TraceContext, TraceSink } from 'stitchapi';

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
    /** The spawning run's id (ADR 0007), when this run is a child — a cookieSession login, a pipe step. */
    parentId?: string;
    label: string;
    method: string;
    url: string;
    headersRedacted?: string[];
    status?: number;
    error?: { name: string; message: string };
    chunks: number;
    /** Count of `request` progress events — i.e. attempts (ADR 0007); >1 means a retry happened. */
    attempts: number;
    /** Count of `paginate` progress events — i.e. pages fetched (ADR 0007). */
    pages: number;
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
    // Runtime causality (ADR 0007): a child run depends on the parent that spawned it, so the
    // DAG draws a parent → child edge (e.g. cookieSession login → the call that triggered it).
    if (e.parentId) entry.dependsOn = [e.parentId];
    // Per-iteration counts as node annotations (ADR 0007) — only when noteworthy (a retry / a
    // paginated run); the per-attempt/page detail lives in the OTLP waterfall, not as DAG nodes.
    if (e.attempts > 1) entry.attempts = e.attempts;
    if (e.pages > 0) entry.pages = e.pages;
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

    // One DAG sink per stitch INSTANCE, all emitting to the single run-scoped `activeSink`. Calls
    // correlate by their run id (ADR 0007) — core stamps it on every event's ctx — so concurrent
    // calls and interleaved CHILD runs (a cookieSession login firing mid-call) attribute exactly,
    // and a child's `parentId` becomes a `dependsOn` edge. The `counter` is a defensive fallback id
    // for the engine-impossible case of a run arriving with no id.
    const makeDagSink = (): TraceSink => {
        const open = new Map<string, OpenEntry>();
        const find = (ctx: TraceContext): OpenEntry | undefined =>
            ctx.spanId ? open.get(ctx.spanId) : undefined;
        return {
            handle(event: StitchEvent, ctx: TraceContext): void {
                switch (event.type) {
                    case 'start': {
                        const id = ctx.spanId ?? `stitch-${(counter += 1)}`;
                        open.set(id, {
                            id,
                            ...(ctx.parentSpanId !== undefined
                                ? { parentId: ctx.parentSpanId }
                                : {}),
                            label: ctx.name,
                            method: event.method,
                            url: event.url,
                            headersRedacted: redactedNames(
                                event.input?.headers,
                            ),
                            chunks: 0,
                            attempts: 0,
                            pages: 0,
                        });
                        break;
                    }
                    case 'result': {
                        const e = find(ctx);
                        if (e) e.status = event.status;
                        break;
                    }
                    case 'error': {
                        const e = find(ctx);
                        if (e) {
                            e.error = {
                                name: event.name,
                                message: event.message,
                            };
                            if (event.status !== undefined)
                                e.status = event.status;
                        }
                        break;
                    }
                    case 'delta': {
                        const e = find(ctx);
                        if (e) {
                            e.chunks += 1;
                            activeSink?.({
                                type: 'chunk',
                                traceId: e.id,
                                text: chunkText(event.chunk),
                            });
                        }
                        break;
                    }
                    case 'done': {
                        const e = find(ctx);
                        if (e && ctx.spanId) {
                            open.delete(ctx.spanId);
                            activeSink?.({
                                type: 'trace',
                                entry: finalize(e, event.ok, event.ms),
                            });
                        }
                        break;
                    }
                    case 'progress': {
                        // Count attempts (`request` per try) + pages (`paginate` per page) for the
                        // node-annotation counts (ADR 0007); the rich per-iteration timing is OTLP's.
                        const e = find(ctx);
                        if (e) {
                            if (event.phase === 'request') e.attempts += 1;
                            else if (event.phase === 'paginate') e.pages += 1;
                        }
                        break;
                    }
                    // 'drift' / 'info' carry no DAG-node data — ignored.
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
