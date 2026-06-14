/**
 * StitchAPI Playground — code-execution engine contract ("the shape").
 *
 * The execution engine ITSELF is DEFERRED. This file does not run any code; it
 * defines the *contract* the rest of the playground is built against, so the UI
 * shell and the docs can proceed while the engine is built later.
 *
 *   - Why in-house + why deferred .... ../RATIONALE.md
 *   - Full requirements for the engine  ../REQUIREMENTS.md
 *   - Options we rejected ............... ../COMPETITORS.md
 *
 * Anything that implements `CodeRunner` is droppable into <StitchPlayground/>:
 * the deferred stub today, the in-house engine tomorrow, or a LiveCodes-backed
 * fallback if we ever change our mind. The UI never knows the difference.
 *
 * NOTE: framework-agnostic, pure TypeScript. This is NOT part of the `stitchapi`
 * library build (tsconfig `include` is `src/**\/*.ts` only). It will be relocated
 * into the Fumadocs app when the docs site is scaffolded.
 */
import type { SimKnobs } from '../contracts/sim';

/* -------------------------------------------------------------------------- */
/*  Output model — what a run produces                                        */
/* -------------------------------------------------------------------------- */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** One captured `console.*` call, in execution order. */
export interface LogEntry {
    level: LogLevel;
    /** Raw arguments as passed to console.* — the renderer decides formatting. */
    args: unknown[];
    /** ms since run start, for an optional timeline view. */
    at: number;
}

/**
 * Structured record of a single `stitch()` call made during the run.
 * Lets the output panel render a response card / trace / build-stitch DAG
 * instead of a bare `console.log` dump. Populated by the browser `stitch`
 * build (see ../REQUIREMENTS.md §"Node-only API boundary"), not by the runner.
 */
export interface StitchTraceEntry {
    id: string;
    /** Logical step label when part of a composed pipeline (for the DAG). */
    label?: string;
    request: { method: string; url: string; headersRedacted?: string[] };
    response?: { status: number; ok: boolean; durationMs: number };
    error?: { name: string; message: string };
    /** Parent step ids, when this stitch was composed from earlier ones. */
    dependsOn?: string[];
    /**
     * Streaming hint (additive — see ../SANDBOX.md §8). Present when the
     * response was a chunked/SSE/LLM stream, so the output panel can render it
     * distinctly. `chunks` is the number of stream chunks observed.
     */
    stream?: { chunks: number };
}

export interface RunError {
    name: string;
    message: string;
    stack?: string;
    /** 1-based source position, when the transpiler/runtime can supply it. */
    line?: number;
    column?: number;
    /** Where it blew up: transpiling the source, or executing it. */
    phase: 'transpile' | 'runtime';
    /**
     * Why it failed, when distinguishable (ratified C1/C2, Wave 0). Lets the UI
     * and the SANDBOX-SECURITY-CHECKLIST tests tell apart a hit timeout / user
     * abort / thrown snippet error / engine failure — `phase` alone can't.
     *   - 'throw'    — the snippet threw (or rejected) at runtime
     *   - 'timeout'  — killed at `RunRequest.timeoutMs` (Worker terminated)
     *   - 'abort'    — cancelled via `RunRequest.signal` (Stop / nav)
     *   - 'internal' — engine/harness failure surfaced as a result, not a reject
     */
    reason?: 'throw' | 'timeout' | 'abort' | 'internal';
}

/**
 * A non-fatal notice emitted during a run (ratified C1/C2, Wave 0). Primary use:
 * the shimmed-surface notice the browser runner MUST show when it runs a
 * Node-only surface in shim mode (SANDBOX.md §3, §5.7; SANDBOX-SECURITY-CHECKLIST
 * SEC-3x). A structured channel so the UI and the tests assert the same place
 * instead of scraping `logs`.
 */
export interface RunNotice {
    kind: 'shim' | 'info';
    /** The stitch surface this concerns, when applicable (e.g. 'keychain'). */
    surface?: string;
    message: string;
}

export interface RunResult {
    /** Captured console output, in order. */
    logs: LogEntry[];
    /** Resolved value of the last expression / explicit return (after awaiting). */
    value?: unknown;
    /** Present iff the run failed. `logs` may still be partially populated. */
    error?: RunError;
    /** Wall-clock duration of the run. */
    durationMs: number;
    /** Structured stitch() calls for the rich output panel, if any. */
    trace?: StitchTraceEntry[];
    /**
     * Non-fatal notices (e.g. "ran `keychain` shimmed"). Additive — ratified
     * C1/C2, Wave 0. Absent/empty when there's nothing to surface.
     */
    notices?: RunNotice[];
}

/* -------------------------------------------------------------------------- */
/*  Run request — what the UI hands the engine                                */
/* -------------------------------------------------------------------------- */

export interface RunRequest {
    /** TS/JSX source from the editor (pre-transpile). */
    code: string;
    /**
     * Globals injected into the snippet's scope. The playground puts the
     * browser `stitch` build here, plus any helpers. Snippets must NOT reach
     * arbitrary `window`/`globalThis` — see ../REQUIREMENTS.md §Security.
     *
     * NOTE (R1, Wave 3): in the isolated tiers (browser Worker / server isolate)
     * values cross a structured-clone / postMessage boundary, so non-cloneable
     * `scope` values (live functions, etc.) are NOT transported. The secure
     * posture is name-allowlisting: the runner binds the allowlisted `stitch`
     * build inside the isolate by name rather than shipping arbitrary live
     * values (SEC-34). Treat `scope` here as the allowlist of names to expose,
     * not a channel for injecting arbitrary host objects.
     */
    scope?: Record<string, unknown>;
    /** Cooperative cancellation (Stop button, page nav). */
    signal?: AbortSignal;
    /** Hard cap; the engine aborts the run past this. Default per-engine. */
    timeoutMs?: number;
    /**
     * Optional progressive channel (added Wave 4, additive/non-breaking). A
     * runner MAY call this as events occur — a `console.*` line, a stream chunk,
     * a completed stitch trace — so the UI can render incrementally (the §9
     * "renders streamed output incrementally" / LLM token-by-token criterion).
     * `run()` still resolves once with the full {@link RunResult}; a runner that
     * doesn't support progress simply never calls this and the UI falls back to
     * the final result. Snippet code never sees this — it's runner→host only.
     */
    onEvent?: (event: RunEvent) => void;
    /**
     * Baseline simulator knobs applied to EVERY request this run makes (added
     * additively). The playground's "Response knobs" panel sets these so a
     * configured knob (`__status`, `__flaky`, …) shapes the whole run without
     * editing the snippet. An explicit `?__…` knob in the code still wins for
     * that call. Snippet code never sees this; the browser runner carries it to
     * the worker's fetch shim. Absent → responses are unmodified.
     */
    knobs?: SimKnobs;
}

/**
 * A progressive event emitted during a run via {@link RunRequest.onEvent}
 * (added Wave 4). Lets the output panel render incrementally before `run()`
 * resolves. All fields mirror the final {@link RunResult} pieces so the UI can
 * append-then-reconcile.
 */
export type RunEvent =
    | { type: 'log'; entry: LogEntry }
    | { type: 'chunk'; traceId?: string; text: string }
    | { type: 'trace'; entry: StitchTraceEntry }
    | { type: 'notice'; notice: RunNotice };

/* -------------------------------------------------------------------------- */
/*  The contract                                                              */
/* -------------------------------------------------------------------------- */

export interface CodeRunner {
    /** Stable id for telemetry / debugging ("inhouse", "mock", "deferred"). */
    readonly id: string;
    /**
     * Transpile (TS+JSX erasure) and execute `code` with `scope` injected,
     * awaiting any top-level promise, capturing console output, and resolving
     * to a structured {@link RunResult}. MUST NOT reject for *snippet* errors —
     * those belong in `result.error`. Engine/internal failures (e.g. transpiler
     * failed to load) SHOULD also resolve, as `error.reason === 'internal'`, so
     * the UI always has a renderable result (ratified C1/C2, Wave 0). Rejection
     * is reserved for unrecoverable harness bugs only.
     */
    run(req: RunRequest): Promise<RunResult>;
    /** Release workers/iframes/listeners. Optional. */
    dispose?(): void;
}

/* -------------------------------------------------------------------------- */
/*  Deferred stub — the real engine is not built yet                          */
/* -------------------------------------------------------------------------- */

export const DEFERRED_MESSAGE =
    'StitchAPI playground execution engine is deferred — not implemented yet. ' +
    'See docs/playground/REQUIREMENTS.md for its shape, and RATIONALE.md for why in-house.';

/**
 * Honest placeholder. Surfaces the deferral as a normal `result.error` so the
 * UI renders a clear "coming soon" state rather than crashing.
 */
export class DeferredRunner implements CodeRunner {
    readonly id = 'deferred';
    async run(req: RunRequest): Promise<RunResult> {
        return {
            logs: [],
            durationMs: 0,
            error: {
                name: 'NotImplemented',
                message: DEFERRED_MESSAGE,
                phase: 'runtime',
            },
        };
    }
}

/* -------------------------------------------------------------------------- */
/*  Mock runner — lets the UI shell be developed before the engine exists     */
/* -------------------------------------------------------------------------- */

/**
 * Returns canned output so <StitchPlayground/> can be styled, themed, and
 * snapshot-tested with zero execution. Swap for the in-house engine once built.
 * It does NOT transpile or run anything — it just echoes a plausible result.
 */
export const mockRunner: CodeRunner = {
    id: 'mock',
    async run({ code }: RunRequest): Promise<RunResult> {
        const looksLikeStitch = /\bstitch\s*\(/.test(code);
        return {
            durationMs: 128,
            logs: [
                { level: 'info', args: ['[mock] executing snippet…'], at: 0 },
                {
                    level: 'log',
                    args: ['GET https://reqres.in/api/users/2 → 200'],
                    at: 96,
                },
            ],
            value: looksLikeStitch
                ? { data: { id: 2, first_name: 'Janet', last_name: 'Weaver' } }
                : 'mock runner: no stitch() call detected in snippet',
            trace: looksLikeStitch
                ? [
                      {
                          id: 's1',
                          label: 'getUser',
                          request: {
                              method: 'GET',
                              url: 'https://reqres.in/api/users/2',
                          },
                          response: { status: 200, ok: true, durationMs: 96 },
                      },
                  ]
                : undefined,
        };
    },
};
