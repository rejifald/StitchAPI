import { defineConfig } from 'tsup';

// Single dual-format entry. `react`, `swr`, and `stitchapi` are peer deps
// (externalised by tsup) — this package bundles no runtime of its own.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['react', 'swr', 'stitchapi'],
});
