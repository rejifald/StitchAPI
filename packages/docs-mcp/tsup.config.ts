import { version } from './package.json';

import { defineConfig } from 'tsup';

// Mirrors packages/core/tsup.config.ts's __PKG_VERSION__ pattern — see that
// file's header comment for the full rationale.
const define = { __PKG_VERSION__: JSON.stringify(version) };

export default defineConfig([
    {
        // Library entry — the MCP SDK, Orama, and transformers.js are real
        // dependencies (unlike the other @stitchapi/* integration packages'
        // peer deps), so tsup externalises them as usual rather than bundling.
        entry: ['src/index.ts'],
        format: ['cjs', 'esm'],
        dts: true,
        minify: true,
        outDir: 'lib',
        clean: true,
        // search.ts/get-doc.ts resolve their bundled data/ path from
        // import.meta.url, which is empty under a CJS build without this —
        // shims polyfills it (and __dirname under ESM) for both formats.
        shims: true,
        define,
    },
    {
        // The `stitchapi-docs-mcp` bin — CJS only, no types, same as core's CLI bundle.
        entry: ['src/cli.ts'],
        format: ['cjs'],
        minify: true,
        dts: false,
        outDir: 'lib',
        clean: false,
        shims: true,
        define,
    },
]);
