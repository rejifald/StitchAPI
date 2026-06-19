import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` is a peer dep; `node:crypto` is the Node
// fallback for Web Crypto (a builtin, never bundled). Both externalised.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['stitchapi', 'node:crypto'],
});
