import { defineConfig } from 'tsup';

// Single dual-format entry. `ajv`, `ajv-formats` and `stitchapi` are external (deps / optional
// peer), externalised by tsup, so the bundle is just the adapter.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
