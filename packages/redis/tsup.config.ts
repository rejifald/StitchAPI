import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi`, `ioredis` and `redis` are peer deps,
// externalised by tsup, so the bundle is just the store + driver adapters.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
