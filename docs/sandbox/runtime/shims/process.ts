/**
 * Browser `process` provision for the SNIPPET scope.
 *
 * Web Workers have NO `process` global (B1-SPIKE §7). `worker-main.ts` imports this
 * object and passes it as `WorkerEnv.process`; `worker-entry.ts` binds it as the
 * snippet's `process` parameter (the snippet's `globalThis` is shadowed to
 * `undefined`, so this injection is how a snippet's `process.env.*` reads resolve —
 * to `{}`, i.e. safe defaults).
 *
 * It is NOT needed by `stitchapi` core. Core is browser-isomorphic since GAP-AUDIT
 * §1.5 (PR #102): it reads env only through the guarded `globalThis.process?.env`
 * seam (`util.ts` `readEnv`), which is simply absent in a Worker → core's own safe
 * defaults (console trace off, no JSONL file, no OTLP export). There is no
 * `define:process` build knob anymore — this value reaches the runtime by injection,
 * not by bundle-time inlining.
 *
 * Demo secret values for `env()`/`keychain()` are NOT injected here — the browser
 * entry overrides those surfaces with notice-emitting shims (node-surfaces.ts),
 * which is the documented browser policy (REQUIREMENTS §6).
 */
// Kept JSON-shaped (no methods): it carries no `process.stderr`, so core's
// `createTrace` console branch — which probes `globalThis.process?.stderr` — finds
// none and falls back to `console.error`. The browser entry forces console trace off
// anyway (stitch-browser.ts createTrace), so nothing reaches for `process.stderr`.
export const browserProcess = {
    env: {} as Record<string, string | undefined>,
    /** A few callers probe `platform`; 'browser' is the honest answer. */
    platform: 'browser',
    /** Present so any defensive `typeof process.versions` check stays falsy-safe. */
    versions: {} as Record<string, string>,
};

export default browserProcess;
