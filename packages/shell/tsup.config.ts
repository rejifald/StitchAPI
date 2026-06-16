import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` is a peer dep, externalised by tsup, so the bundle is just
// the surface + the execFile wiring. Not minified.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: false,
    outDir: 'lib',
    clean: true,
});
