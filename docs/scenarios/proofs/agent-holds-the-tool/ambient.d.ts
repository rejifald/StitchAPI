// Core's `mcp.ts` interpolates the build-time `__PKG_VERSION__` define (tsup injects it; core
// declares it in `src/version.d.ts`, which a bare file-list `tsc` run never loads). Redeclared
// here so this directory's documented typecheck command works against the unmodified tree.
declare const __PKG_VERSION__: string;
