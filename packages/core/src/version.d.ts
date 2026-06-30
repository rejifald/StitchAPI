// Build-time constant: the canonical `stitchapi` package version, injected by
// esbuild `define` so the shipped library never hardcodes (and never drifts from)
// the real release. The value is the `version` field of packages/core/package.json,
// stringified at build time:
//   - tsup.config.ts defines it for both the library and CLI bundles
//   - vitest.config.ts defines it so the test run sees the same value
// `tsc` only needs to know the identifier exists and is a string — it does not
// perform the substitution. There is no runtime fallback by design: every path
// that executes this code (tsup output, vitest) performs the `define`.
declare const __PKG_VERSION__: string;
