import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` is a peer dep; `ai` is an optional peer
// (never imported — the tool object is structural). Both externalised.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['stitchapi', 'ai'],
});
