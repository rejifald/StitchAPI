import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` and `solid-js` are peer deps (externalised
// by tsup); `@stitchapi/query-core` is a runtime dep and is also kept external so
// the Solid bindings stay a thin layer over it.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    // `solid-js` AND its subpaths (`solid-js/store`) are the peer; the regex
    // keeps them all external so we don't bundle Solid's runtime.
    external: ['@stitchapi/query-core', /^solid-js(\/|$)/],
});
