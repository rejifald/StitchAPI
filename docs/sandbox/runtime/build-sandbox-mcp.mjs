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
 * NO process define), and alias `stitchapi` → packages/core/src so the bundle
 * resolves WITHOUT a build:core. `@babel/standalone` (transpile's never-taken
 * load-failure fallback) is marked external so esbuild doesn't try to resolve it.
 *
 * Usage:  pnpm --filter @stitchapi/sandbox run build:mcp
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const pkgRoot = resolve(__dirname, '..'); // docs/sandbox

const OUTDIR = process.env.OUT ?? resolve(pkgRoot, 'dist');
const CORE =
    process.env.CORE ?? resolve(repoRoot, 'packages/core/src/index.ts');

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
    alias: { stitchapi: CORE },
    // transpile.ts prefers sucrase (bundled) and only dynamically imports
    // @babel/standalone if sucrase fails to LOAD — never on this path. Keep it
    // external so the build doesn't require the heavy Babel bundle.
    external: ['@babel/standalone'],
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
