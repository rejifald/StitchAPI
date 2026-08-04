#!/usr/bin/env node

/**
 * Build the sandbox MCP server + its Node worker bundle.
 *
 * Two esbuild Node-ESM bundles into docs/sandbox/dist/:
 *   - mcp.mjs         ← mcp/bin.ts                  (the stdio MCP server; the
 *                                                    `stitch-sandbox` bin)
 *   - node-worker.mjs ← runtime/worker-main.node.ts (the worker_threads body that
 *                                                    node-runner.ts spawns by path)
 *
 * Knobs (vs the browser build): platform 'node' (real node: builtins, NO shims,
 * NO process define), alias `stitchapi` → packages/core/src so the bundle
 * resolves WITHOUT a build:core, and the `__PKG_VERSION__` define core's
 * src/mcp.ts needs (see below). `@babel/standalone` (transpile's never-taken
 * load-failure fallback) is marked external so esbuild doesn't try to resolve it.
 *
 * Usage:  pnpm --filter @stitchapi/sandbox run build:mcp
 */
import { PLAYGROUND_PACKAGES } from './playground-packages.mjs';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const pkgRoot = resolve(__dirname, '..'); // docs/sandbox

const OUTDIR = process.env.OUT ?? resolve(pkgRoot, 'dist');
const CORE =
    process.env.CORE ?? resolve(repoRoot, 'packages/core/src/index.ts');
// The auth surface is its own entry (ADR 0021); `stitchapi` aliases to a FILE, so
// `stitchapi/auth` cannot resolve underneath it and needs its own alias.
const CORE_AUTH = CORE.replace(/index\.ts$/, 'auth.ts');
// Alias each workspace `@stitchapi/*` playground package to its source (its published
// `lib/` isn't built on this path); the node worker bundles them for snippet imports.
// Derived from the one package list — adding a package needs no edit here.
const WORKSPACE_ALIASES = Object.fromEntries(
    PLAYGROUND_PACKAGES.filter((p) => p.src).map((p) => [
        p.specifier,
        resolve(repoRoot, p.src),
    ]),
);

// The MCP bundle pulls in core's src/mcp.ts (mcp/server.ts wraps `createMcpServer`),
// and that module reads `__PKG_VERSION__` — a build-time constant with NO runtime
// fallback by design (packages/core/src/version.d.ts). Every other build that
// compiles that file substitutes it (core's tsup.config.ts and vitest.config.ts);
// without the same define here the placeholder survives into dist/mcp.mjs and the
// `stitch-sandbox` bin dies at import with `__PKG_VERSION__ is not defined`.
// Same convention as those two: the literal `version` of the canonical
// packages/core/package.json — core's version, because it is core's MCP server
// reporting it — stringified at build time, so package.json is NOT pulled into
// the bundle.
const CORE_VERSION = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/core/package.json'), 'utf8'),
).version;

async function loadEsbuild() {
    try {
        return await import('esbuild');
    } catch {
        /* fall through */
    }
    try {
        const requireFromCwd = createRequire(
            resolve(process.cwd(), 'package.json'),
        );
        return await import(
            pathToFileURL(requireFromCwd.resolve('esbuild')).href
        );
    } catch {
        /* fall through */
    }
    const fromEnv = process.env.ESBUILD;
    if (fromEnv) {
        try {
            return await import(fromEnv);
        } catch (e) {
            console.error(`Could not import ESBUILD=${fromEnv}: ${e}`);
        }
    }
    console.error(
        'esbuild not found. Run via `pnpm --filter @stitchapi/sandbox run build:mcp` ' +
            '(esbuild is a devDependency), or set ESBUILD=/abs/path.',
    );
    process.exit(2);
}

const esbuild = await loadEsbuild();

/** @type {import('esbuild').BuildOptions} */
const shared = {
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    // Resolve the real core from source (no build:core needed). Node built-ins
    // stay external automatically under platform:node.
    alias: {
        stitchapi: CORE,
        'stitchapi/auth': CORE_AUTH,
        ...WORKSPACE_ALIASES,
    },
    // transpile.ts prefers sucrase (bundled) and only dynamically imports
    // @babel/standalone if sucrase fails to LOAD — never on this path. Keep it
    // external so the build doesn't require the heavy Babel bundle.
    external: ['@babel/standalone'],
    // Shared by both bundles: mcp.mjs needs it (core's src/mcp.ts), and node-worker.mjs
    // gets it for free — it costs nothing on a bundle that never references the constant,
    // and keeps the define from going missing if the worker graph ever reaches mcp.ts.
    define: { __PKG_VERSION__: JSON.stringify(CORE_VERSION) },
    logLevel: 'info',
};

// 1. The MCP server / bin (executable shebang).
await esbuild.build({
    ...shared,
    entryPoints: [resolve(pkgRoot, 'mcp/bin.ts')],
    outfile: resolve(OUTDIR, 'mcp.mjs'),
    banner: { js: '#!/usr/bin/env node' },
});

// 2. The worker_threads body (loaded by path; no shebang).
await esbuild.build({
    ...shared,
    entryPoints: [resolve(pkgRoot, 'runtime/worker-main.node.ts')],
    outfile: resolve(OUTDIR, 'node-worker.mjs'),
});

console.log(
    `\n[sandbox-mcp] wrote dist/mcp.mjs + dist/node-worker.mjs → ${OUTDIR}`,
);
