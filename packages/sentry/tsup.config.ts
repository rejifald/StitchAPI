import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` is the only peer dep; the Sentry SDK is
// passed in structurally (never imported), so nothing else is external.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['stitchapi'],
});
