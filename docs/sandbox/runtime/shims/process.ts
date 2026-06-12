/**
 * Browser `process` provision — B1 (browser `stitch` build).
 *
 * Web Workers have NO `process` global (B1-SPIKE §7), yet core reads `process.env`
 * at runtime on the hot path:
 *   - stitch.ts getTrace(): STITCH_TRACE_FILE / STITCH_TRACE_CONSOLE / STITCH_EXPORT
 *     — read on EVERY makeStitch()
 *   - trace.ts: process.env.HOME (default JSONL path)
 *   - otlp.ts:  OTEL_EXPORTER_OTLP_ENDPOINT
 *   - auth.ts:  arbitrary env[name] inside env()/keychain() closures
 *
 * The build `define`s `process` to this object's literal value (see
 * build-stitch-browser.mjs: `--define:process=...`). Exporting it here keeps the
 * shape in one auditable place; the define inlines the literal so the bundle has
 * ZERO residual `process.env` references.
 *
 * `env` is an empty object by design: every STITCH_ / OTEL_ read returns
 * `undefined`, so core takes its safe defaults (console trace off, no JSONL file,
 * no OTLP export). Demo secret values for `env()`/`keychain()` are NOT injected
 * here — the browser entry overrides those surfaces directly with notice-emitting
 * shims (stitch-browser.ts), which is the documented browser policy (REQUIREMENTS §6).
 */
// NOTE: this is also expressed as a JSON literal in build-stitch-browser.mjs for
// `--define:process=...`. A define literal CANNOT carry functions, so there is no
// `process.stderr`. Core's only stderr use is `createTrace`'s console branch, which
// the browser entry forces off (stitch-browser.ts createTrace) — so nothing reaches
// for `process.stderr`. Keep this object JSON-shaped (no methods) to match the define.
export const browserProcess = {
    env: {} as Record<string, string | undefined>,
    /** A few callers probe `platform`; 'browser' is the honest answer. */
    platform: 'browser',
    /** Present so any defensive `typeof process.versions` check stays falsy-safe. */
    versions: {} as Record<string, string>,
};

export default browserProcess;
