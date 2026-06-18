import { defineConfig } from 'tsup';

// Single dual-format entry; `stitchapi` and `pino` are peer deps, externalised by
// tsup, so the bundle is just the sink + the event→level→record mapping.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
