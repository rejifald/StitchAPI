import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` and `zod` are peer deps, externalised by
// tsup, so the bundle is just the strategy.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
