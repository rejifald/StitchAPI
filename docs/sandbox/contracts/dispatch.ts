/**
 * Dispatch contract (frozen by C1, Wave 0).
 *
 * The dispatcher is itself a `CodeRunner` (SANDBOX.md §2, §8): it runs the §3
 * static surface scan over a snippet and delegates to the browser runner — or,
 * once the Phase-3 server tier exists, the server runner — based on which
 * stitch surfaces the snippet uses.
 *
 * This module is the frozen public surface and stays a thin barrel:
 *   - the TYPES and the frozen `NODE_ONLY_SURFACES` constant live in ./surface
 *     (a dependency-free leaf, so the implementations can import them without
 *     creating an import cycle back through this file);
 *   - the behaviour is implemented in task D1 — `scanSurface` (./scan-surface)
 *     and `dispatchRunner` (./dispatch-runner) — and re-exported here.
 *
 * Re-exporting both keeps the frozen import surface — and index.ts — unchanged.
 * Authored per SANDBOX-IMPLEMENTATION-PLAN.md §3. See ./README.md — lower tiers
 * do not widen this.
 */
export type {
    Tier,
    SurfaceScan,
    DispatchOpts,
    NodeOnlySurface,
} from './surface';
export { NODE_ONLY_SURFACES } from './surface';

/**
 * Static scan of pre-transpile source for Node-only surface references (§3).
 * Signature frozen by C1; implemented in D1 (./scan-surface.ts).
 */
export { scanSurface } from './scan-surface';

/**
 * Compose a browser (+ optional server) runner into the single `CodeRunner`
 * that `<StitchPlayground runner={…}/>` receives. Signature frozen by C1;
 * implemented in D1 (./dispatch-runner.ts).
 */
export { dispatchRunner } from './dispatch-runner';
