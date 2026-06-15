import { defineConfig } from 'tsup';

// Two bundles from one source tree:
//   lib/index.{js,mjs} (+ .d.ts) — the library (function surface), dual-format + types
//   plus serve/mcp/registry/testing/fingerprint/cache as their own subpath entry points (stitchapi/serve, etc.)
//   plus each non-http surface (graphql/sse/stream/download) and the xhr adapter as their own
//   subpath entries (ADR 0005 Decision 10) — `import { stitch }` bundles `http` only; every other
//   surface is reached through its subpath, exactly like the cache engine.
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
            // surfaces (ADR 0005 Decision 10) — subpath-only; the root entry bundles http alone
            'src/graphql.ts',
            'src/sse.ts',
            'src/stream.ts',
            'src/download.ts',
            // the browser-only xhr adapter (upload progress) → stitchapi/xhr
            'src/xhr-adapter.ts',
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
