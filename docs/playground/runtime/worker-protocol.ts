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
 */

import type { LogLevel } from '../component/runner';

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
}

/** Anything the worker can post. (Only `result` in v1.) */
export type FromWorker = ResultMessage;
