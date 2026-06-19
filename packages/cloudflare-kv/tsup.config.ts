import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` is the only peer dep, externalised by
// tsup, so the bundle is just the store + the structural namespace interface. No
// runtime deps and no `node:*` — the output is edge-safe.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
