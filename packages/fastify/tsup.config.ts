import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` and `fastify` are peer deps and `fastify-plugin`
// a tiny dependency — tsup externalises the peers so the bundle is just the plugin + bridges.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
