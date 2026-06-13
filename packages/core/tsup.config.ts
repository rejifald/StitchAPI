import { defineConfig } from 'tsup';

// Two bundles from one source tree:
//   lib/index.{js,mjs} (+ .d.ts) — the library (function surface), dual-format + types
//   plus serve/mcp/registry/testing as their own subpath entry points (stitchapi/serve, etc.)
//   lib/cli.js                   — the `stitch` bin (run/trace/serve/mcp), CJS, no types
export default defineConfig([
    {
        entry: [
            'src/index.ts',
            'src/serve.ts',
            'src/mcp.ts',
            'src/registry.ts',
            'src/testing.ts',
        ],
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
