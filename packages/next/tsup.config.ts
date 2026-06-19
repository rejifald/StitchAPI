import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` is the only peer dep; everything else is a
// Web-standard global (Response, ReadableStream, TextEncoder).
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['stitchapi'],
});
