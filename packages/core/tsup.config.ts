import { defineConfig } from 'tsup';

// Two bundles from one source tree:
//   lib/index.{js,mjs} (+ .d.ts) — the library (function surface), dual-format + types
//   plus serve/mcp/registry/testing/fingerprint/cache as their own subpath entry points (stitchapi/serve, etc.)
//   lib/cli.js                   — the `stitch` bin (run/trace/serve/mcp), CJS, no types
// `cache` is its own entry so `import { stitch }` never pulls the cache engine (ADR 0003 §11):
// the engine reaches it via a lazy `import('./cache')`, which esm splitting keeps in its chunk.
export default defineConfig([
    {
        entry: [
            'src/index.ts',
            'src/serve.ts',
            'src/mcp.ts',
            'src/registry.ts',
            'src/testing.ts',
            'src/fingerprint.ts',
            'src/cache.ts',
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
