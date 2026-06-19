import { defineConfig } from 'tsup';

// Single dual-format entry. `@angular/*`, `rxjs`, and `stitchapi` are peer deps
// (externalised by tsup); `@stitchapi/query-core` is a runtime dep and is also
// kept external so the Angular bindings stay a thin layer over it.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    // Keep Angular and RxJS (and their subpaths, e.g. `@angular/core/rxjs-interop`,
    // `rxjs/operators`) external so we never bundle a framework runtime.
    external: ['@stitchapi/query-core', /^@angular\//, /^rxjs(\/|$)/],
});
