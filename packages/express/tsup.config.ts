import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` and `express` are peer deps, externalised
// by tsup, so the bundle is just the middleware + SSE bridge + error handler.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
