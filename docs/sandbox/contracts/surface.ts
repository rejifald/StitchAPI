/**
 * Dispatch contract primitives (frozen by C1, Wave 0) — the leaf module.
 *
 * Holds the TYPES and the frozen `NODE_ONLY_SURFACES` constant that both the
 * surface scan (`./scan-surface`) and the dispatcher (`./dispatch-runner`) build
 * on. It lives apart from `./dispatch` so the implementation modules can depend
 * on these primitives WITHOUT importing `./dispatch` (which re-exports them):
 * keeping the shared definitions in a dependency-free leaf is what breaks the
 * `dispatch → scan-surface → dispatch` import cycle.
 *
 * `./dispatch` re-exports everything here, so the frozen public import surface
 * (and `index.ts`) is unchanged — downstream code keeps importing from
 * `./dispatch` / the contracts barrel. See ./README.md — lower tiers do not
 * widen this.
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
 * Frozen. `as const` makes it a readonly tuple of string literals. Entries track
 * core's SPELLING, though — `otlpTrace` became `otlpSink` here in #494, and the
 * `otlpSink`/`otlpHttpExporter` pair became the single `otlp` namespace when core
 * folded them. The scan matches the identifier at a word boundary and tolerates a
 * leading dot, so the one `otlp` entry covers `otlp.sink(…)` and `otlp.exporter(…)`
 * exactly as the two separate names did.
 *
 * That fold widens the list by one member: `otlp.json` is a pure serializer and
 * used to route BROWSER (it was `toOtlpJson`, never listed here), and a snippet
 * naming only it now routes to the server tier. Deliberate — the alternative is
 * dropping `otlp` from this list entirely, which would route real `otlp.sink()`
 * egress to the browser and silently simulate it. `multiplex` is the precedent:
 * pure JS, listed here anyway, because these are TRACE-pipeline names and the
 * pipeline's destination is the Node-only part. Over-routing a pure serializer to
 * real Node costs a tier hop and returns the identical JSON.
 */
export const NODE_ONLY_SURFACES = [
    'env',
    'cookieSession',
    'createTrace',
    'multiplex',
    'otlp',
    'cli',
    'serve',
    'mcp',
] as const;

/** Union of the Node-only surface identifier literals. */
export type NodeOnlySurface = (typeof NODE_ONLY_SURFACES)[number];
