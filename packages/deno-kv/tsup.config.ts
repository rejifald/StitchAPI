import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` is the only peer dep, externalised by
// tsup. The Deno KV surface is a structural interface (no runtime client), so
// the bundle is just the store + the atomic-increment logic.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
