// Build-time constant: this package's version, injected by esbuild `define` so
// the MCP server's reported version and the CLI's --version never drift from
// package.json. Mirrors packages/core/src/version.d.ts — see that file for the
// full rationale. tsup.config.ts and vitest.config.ts both define it.
declare const __PKG_VERSION__: string;
