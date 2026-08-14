import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` (and its `stitchapi/download` subpath) is a
// peer dep, externalised by tsup, so the bundle is just the batch orchestrator —
// the FIFO scheduler, aggregate progress/ETA, cancel wiring, and error classifier.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
