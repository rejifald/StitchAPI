import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` and `elysia` are peer deps, externalised by
// tsup, so the bundle is just the plugin + SSE bridge + error mapping.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
