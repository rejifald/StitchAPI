import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` is a peer dep, externalised by tsup, so
// the bundle is just the framework-agnostic query store. No framework imports.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
