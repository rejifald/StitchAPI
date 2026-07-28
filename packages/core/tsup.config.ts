import { version } from './package.json';

import { defineConfig } from 'tsup';

// Inject the canonical package version as a build-time constant so the shipped
// library never hardcodes it (and never drifts from the published release). Used
// by src/mcp.ts for the version the MCP server reports; declared for `tsc` in
// src/version.d.ts and mirrored in vitest.config.ts so the test run sees it too.
// This stays a literal substitution — package.json is NOT pulled into the bundle.
const define = { __PKG_VERSION__: JSON.stringify(version) };

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
            // server-side SSE emission kit shared by the HTTP adapters → stitchapi/sse-emit
            'src/sse-emit.ts',
            'src/stream.ts',
            'src/download.ts',
            // the postMessage surface (ADR 0009) → stitchapi/postmessage
            'src/postmessage.ts',
            // non-HTTP surfaces + composition (ADR 0008) → stitchapi/llm, stitchapi/pipe
            'src/llm.ts',
            'src/pipe.ts',
            // the browser-only xhr adapter (upload progress) → stitchapi/xhr
            'src/xhr-adapter.ts',
        ],
        format: ['cjs', 'esm'],
        minify: true,
        dts: true,
        outDir: 'lib',
        clean: true,
        define,
    },
    {
        // The CLI bundle pulls in src/mcp.ts (via serveStdio), so it needs the
        // same version define.
        entry: ['src/cli.ts'],
        format: ['cjs'],
        minify: true,
        dts: false,
        outDir: 'lib',
        clean: false,
        define,
    },
]);
