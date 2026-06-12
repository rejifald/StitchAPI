import { defineConfig } from 'tsup';

// Two bundles from one source tree:
//   lib/index.{js,mjs} (+ .d.ts) — the library (function surface), dual-format + types
//   lib/cli.js                   — the `stitch` bin (run/trace/serve/mcp), CJS, no types
export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: ['cjs', 'esm'],
        minify: true,
        dts: true,
        outDir: 'lib',
        clean: true,
    },
    {
        entry: ['src/cli.ts'],
        format: ['cjs'],
        minify: true,
        dts: false,
        outDir: 'lib',
        clean: false,
    },
]);
