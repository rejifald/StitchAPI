/**
 * StitchAPI Playground sandbox — FROZEN shared contracts (C1, Wave 0).
 *
 * Single import surface for every downstream sandbox task. Lower tiers code
 * against these and MUST NOT widen them: a task that finds a contract
 * insufficient stops and reports back to C1 (T3) for re-ratification, per
 * SANDBOX-IMPLEMENTATION-PLAN.md §3. See ./README.md.
 *
 *   - runner.ts   — re-export of the existing `CodeRunner` contract
 *                   (canonical source stays in ../component/runner.ts)
 *   - sim.ts      — fake-API simulator handler contract
 *   - dispatch.ts — surface scan + dispatcher (signatures; impl in D1)
 *
 * Pure TypeScript, framework-agnostic, no runtime deps — mirrors runner.ts.
 */

/* Runner contract (re-exported from ../component/runner.ts — do not relocate). */
export type {
    CodeRunner,
    RunRequest,
    RunResult,
    RunError,
    StitchTraceEntry,
    LogEntry,
    LogLevel,
} from './runner';

/* Simulator handler contract. */
export type { SimRequest, SimResponse, SimHandler, SimKnobs } from './sim';

/* Dispatch contract — types, frozen constant, and (D1-implemented) signatures. */
export type {
    Tier,
    SurfaceScan,
    DispatchOpts,
    NodeOnlySurface,
} from './dispatch';
export { NODE_ONLY_SURFACES, scanSurface, dispatchRunner } from './dispatch';
