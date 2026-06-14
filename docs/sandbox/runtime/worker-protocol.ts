/**
 * R1 — Worker message protocol (shared by main thread + worker body).
 *
 * Lives in its OWN file (no `DOM` and no `WebWorker` lib needed — it is pure
 * data types) so both `browser-runner.ts` (DOM lib) and `worker-entry.ts`
 * (WebWorker semantics) can import it without a tsconfig `lib` clash. See the
 * header comment in `worker-entry.ts` for the full rationale.
 *
 * The protocol is deliberately tiny and fully structured-cloneable: the main
 * thread posts ONE `RunMessage`, the worker posts back ONE `ResultMessage`.
 * Nothing here carries a function — functions are wired INSIDE the worker scope
 * (the bundled stitch build + fetch shim), never sent across `postMessage`.
 *
 * Wave-4 amendment (A1, additive): alongside the single final `ResultMessage`,
 * the worker MAY post zero-or-more `ProgressMessage`s *as events happen* (a
 * console line, a stream chunk, a completed stitch trace, a shim notice) so the
 * main thread can forward them to `RunRequest.onEvent` for incremental render
 * (SANDBOX §8 / §9). Progress is PURE observation: it never alters the final
 * `ResultMessage`, and a worker that emits no progress behaves exactly as before.
 * Like everything here, the payload is pure data / structured-cloneable — the
 * `RunEvent` shapes mirror the frozen `runner.ts` union, carried by value.
 */
import type { LogLevel, RunEvent, StitchTraceEntry } from '../component/runner';
import type { SimKnobs } from '../contracts/sim';

/* -------------------------------------------------------------------------- */
/*  Main thread → Worker                                                       */
/* -------------------------------------------------------------------------- */

/** The single message the runner posts to the worker to start a run. */
export interface RunMessage {
    type: 'run';
    /** Already-transpiled, runnable JS (R2 ran on the main thread). */
    js: string;
    /**
     * Names of extra scope globals the worker should bind from its injected
     * environment, beyond the always-present `stitch build` / `fetch` /
     * `console` / `process` / `crypto`. The VALUES are NOT sent here (they may
     * be non-cloneable) — only the snippet-visible names the worker should make
     * available from its own env. In v1 this is empty; reserved for additive
     * use so the contract (`RunRequest.scope`) can be honored without widening
     * the wire.
     */
    extraScopeNames: string[];
    /**
     * Baseline simulator knobs to apply to every request this run makes (the
     * playground's "Response knobs" panel — `RunRequest.knobs`). Pure data, so
     * it rides the wire as-is; the worker hands it to the sim fetch shim before
     * executing. Absent → responses are unmodified. URL-explicit knobs still win.
     */
    knobs?: SimKnobs;
}

/* -------------------------------------------------------------------------- */
/*  Worker → Main thread                                                       */
/* -------------------------------------------------------------------------- */

/** A console line captured inside the worker, serialised for transport. */
export interface WireLog {
    level: LogLevel;
    /**
     * Console args, best-effort serialised to structured-cloneable values so a
     * real `postMessage` can carry them. Non-cloneable args (functions, DOM
     * nodes — which shouldn't exist in scope anyway) become their string form.
     */
    args: unknown[];
    /** ms since the worker began executing the snippet. */
    at: number;
}

/** A shim notice drained inside the worker (structurally === RunNotice). */
export interface WireNotice {
    kind: 'shim' | 'info';
    surface?: string;
    message: string;
}

/** A serialised error (Error objects don't survive structured clone fully). */
export interface WireError {
    name: string;
    message: string;
    stack?: string;
}

/** The single message the worker posts back when the run settles. */
export interface ResultMessage {
    type: 'result';
    /** Captured console output, in order. */
    logs: WireLog[];
    /** Drained shim notices. */
    notices: WireNotice[];
    /**
     * The resolved final value, IF it survived structured clone / our JSON
     * round-trip. Absent when the snippet returned nothing or a non-cloneable
     * value the worker could not serialise.
     */
    value?: unknown;
    /**
     * Present iff the snippet itself threw/rejected. Engine/timeout/abort
     * outcomes are decided by the MAIN thread (it owns the clock + the signal +
     * the terminate), never reported through this field.
     */
    error?: WireError;
    /**
     * Structured trace of the `stitch()` calls made during the run, in
     * completion order (A2). Assembled by the worker body from the env's trace
     * producers (the B1 build's traced `stitch`); absent when the run made no
     * observable stitch calls. The main thread maps it to `RunResult.trace` so
     * the playground's Mermaid DAG renders from the REAL run, not a fixture.
     */
    trace?: StitchTraceEntry[];
}

/**
 * A progressive observation posted by the worker DURING a run (A1, Wave 4).
 * Carries one {@link RunEvent} by value (structured-cloneable — the union's
 * fields are plain data: `LogEntry`, text, `StitchTraceEntry`, `RunNotice`).
 *
 * Emitted in real execution order, interleaved with nothing else from the
 * worker until the single terminal `ResultMessage`. Purely additive: it never
 * changes the final result, and the main thread forwards it to
 * `RunRequest.onEvent` (and only there — never to snippet code).
 */
export interface ProgressMessage {
    type: 'progress';
    event: RunEvent;
}

/** Anything the worker can post: zero-or-more `progress`, then one `result`. */
export type FromWorker = ResultMessage | ProgressMessage;
