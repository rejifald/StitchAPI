/**
 * Dispatch contract (frozen by C1, Wave 0).
 *
 * The dispatcher is itself a `CodeRunner` (SANDBOX.md §2, §8): it runs the §3
 * static surface scan over a snippet and delegates to the browser runner — or,
 * once the Phase-3 server tier exists, the server runner — based on which
 * stitch surfaces the snippet uses.
 *
 * This module freezes the TYPES and SIGNATURES only. The behaviour is
 * implemented in task D1 (`scanSurface`, `dispatchRunner`); the throwing stubs
 * below exist solely so the contract type-checks and so accidental early use
 * fails loudly rather than silently. Authored per SANDBOX-IMPLEMENTATION-PLAN.md
 * §3. See ./README.md — lower tiers do not widen this.
 */
import type { CodeRunner } from '../component/runner';

/** Where a snippet runs: the browser Web Worker, or the server isolate. */
export type Tier = 'browser' | 'server';

/**
 * Result of the static surface scan (SANDBOX.md §3). Intentionally conservative:
 * a clear Node-only reference routes to `'server'`; ambiguous / dynamic access
 * sets `ambiguous` and routes to the safe default (`'browser'` + shim + notice),
 * never silently to the isolate.
 */
export interface SurfaceScan {
    /** The tier this snippet should run on. */
    tier: Tier;
    /** Node-only identifiers the scan matched (from {@link NODE_ONLY_SURFACES}). */
    nodeOnlyHits: string[];
    /** True when access was dynamic/unresolvable, forcing the safe default. */
    ambiguous: boolean;
}

/**
 * Options handed to {@link dispatchRunner}: the concrete runners it composes.
 * The server runner is optional — Phases 1–2 ship browser-only (SANDBOX.md §2),
 * and a Node-only snippet then runs browser-shimmed with a notice (§3).
 *
 * NOTE (C1): the §3 contract snippet writes `dispatchRunner(opts: DispatchOpts)`
 * but does not spell out `DispatchOpts`. This is the minimal frozen shape
 * consistent with SANDBOX.md §8 ("wraps the two [runners]"); see the C1 report's
 * ambiguity note. D1 codes against exactly this.
 */
export interface DispatchOpts {
    /** Runner for browser-safe snippets (R1's `browserWorkerRunner`). */
    browser: CodeRunner;
    /** Runner for Node-only snippets (SR1's `serverRunner`); absent pre-Phase-3. */
    server?: CodeRunner;
}

/**
 * Stitch surfaces that do not exist in the browser and must run on real Node
 * (SANDBOX.md §3). The single source of truth the scan keys on — D1 and the
 * tests (T-α) import this constant rather than re-listing the identifiers.
 *
 * Frozen. `as const` makes it a readonly tuple of string literals.
 */
export const NODE_ONLY_SURFACES = [
    'keychain',
    'env',
    'cookieSession',
    'createTrace',
    'multiplex',
    'otlpTrace',
    'otlpHttpExporter',
    'cli',
    'serve',
    'mcp',
] as const;

/** Union of the Node-only surface identifier literals. */
export type NodeOnlySurface = (typeof NODE_ONLY_SURFACES)[number];

/**
 * Static scan of pre-transpile source for Node-only surface references (§3).
 * Signature frozen by C1; implemented in D1.
 *
 * The throwing stub was replaced in D1 by the real heuristic, which lives in
 * ./scan-surface.ts (kept out of this frozen-signatures module so the contract
 * file stays types-only). Re-exported here so the frozen import surface — and
 * index.ts — are unchanged.
 */
// implemented in D1
export { scanSurface } from './scan-surface';

/**
 * Compose a browser (+ optional server) runner into the single `CodeRunner`
 * that `<StitchPlayground runner={…}/>` receives. Signature frozen by C1;
 * implemented in D1 (impl in ./dispatch-runner.ts; re-exported here).
 */
// implemented in D1
export { dispatchRunner } from './dispatch-runner';
