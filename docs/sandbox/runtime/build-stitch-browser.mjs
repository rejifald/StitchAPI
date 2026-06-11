#!/usr/bin/env node

/**
 * B1 — browser `stitch` build script.
 *
 * Reproduces the spike's working approach (B1-SPIKE §4, §6): an esbuild ESM bundle
 * of `stitch-browser.ts` with three knobs, all proven in the spike:
 *
 *   1. alias the 3 reachable Node built-ins → the hand-written browser shims:
 *        node:crypto → ./shims/node-crypto.ts   (Web Crypto randomUUID/randomBytes)
 *        node:fs     → ./shims/node-fs.ts        (no-op writes, existsSync→false)
 *        node:path   → ./shims/node-path.ts      (regex dirname)
 *   2. alias `stitchapi` → packages/core/src/index.ts so the bundle resolves
 *      WITHOUT `pnpm install` (zod is unused in the reachable graph — B1-SPIKE §1).
 *   3. define `process` → the browser process value (./shims/process.ts), so every
 *      runtime `process.env.*` read inlines to `{}` and the bundle has ZERO
 *      residual `process.env` references. (R1 may alternatively inject a `process`
 *      global into the Worker scope — see B1-README. We bake it in here.)
 *
 * `sideEffects:false` on packages/core drops cli/serve/mcp/registry (B1-SPIKE §3).
 *
 * Output: an ESM bundle. By default to /tmp (NEVER committed). Override with
 *   OUT=/path/to/bundle.mjs  and  CORE=/path/to/packages/core/src/index.ts
 *
 * Usage:
 *   node docs/sandbox/runtime/build-stitch-browser.mjs
 *   OUT=/tmp/stitch-browser.mjs node docs/sandbox/runtime/build-stitch-browser.mjs
 *
 * esbuild is resolved from node_modules if present, else via `npx -y esbuild`
 * (the spike used npx; this script prefers the JS API but the equivalent CLI is
 * documented in B1-README).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const ENTRY = resolve(__dirname, 'stitch-browser.ts');
const OUT = process.env.OUT ?? '/tmp/b1-out/stitch-browser.mjs';
const CORE =
    process.env.CORE ?? resolve(repoRoot, 'packages/core/src/index.ts');

/** The browser `process` literal that `define:process` inlines. Mirrors
 *  shims/process.ts (kept here as a literal because `--define` needs a value,
 *  not a module reference). */
const PROCESS_DEFINE = JSON.stringify({
    env: {},
    platform: 'browser',
    versions: {},
});

async function loadEsbuild() {
    // Prefer a workspace-resolvable `esbuild`. If unresolvable (e.g. deps not
    // installed — the spike's constraint), fall back to ESBUILD=/abs/path/to/esbuild
    // (a checkout in /tmp). See B1-README for the npx CLI equivalent.
    try {
        return await import('esbuild');
    } catch {
        const fromEnv = process.env.ESBUILD;
        if (fromEnv) {
            try {
                return await import(fromEnv);
            } catch (e) {
                console.error(`Could not import ESBUILD=${fromEnv}: ${e}`);
            }
        }
        console.error(
            'esbuild not found. Install it in the workspace, set ESBUILD=/abs/path ' +
                'to an esbuild build, or run the CLI equivalent in B1-README.md.',
        );
        process.exit(2);
    }
}

const esbuild = await loadEsbuild();

const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: OUT,
    sourcemap: false,
    // Knob 1 + 2: redirect the 3 node built-ins to shims, and core to its source.
    alias: {
        'node:crypto': resolve(__dirname, 'shims/node-crypto.ts'),
        'node:fs': resolve(__dirname, 'shims/node-fs.ts'),
        'node:path': resolve(__dirname, 'shims/node-path.ts'),
        stitchapi: CORE,
    },
    // Knob 3: inline `process` so no `process.env` survives. We also point the
    // injected identifier at the shim module for any bare `process` reference.
    define: {
        process: PROCESS_DEFINE,
    },
    metafile: true,
    logLevel: 'info',
});

void result;
console.log(`\n[B1] wrote ESM bundle → ${OUT}`);
