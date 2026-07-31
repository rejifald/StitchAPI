#!/usr/bin/env node

/**
 * B1 — browser `stitch` build script (standalone dev/probe build of the call API).
 *
 * An esbuild ESM bundle of `stitch-browser.ts`. One knob:
 *
 *   alias `stitchapi` → packages/core/src/index.ts so the bundle resolves WITHOUT
 *   `pnpm install` (zod is unused in the reachable graph — B1-SPIKE §1). In an
 *   installed workspace, drop the alias or point it at the published entry.
 *
 * No node:* or process shims are needed: core is browser-isomorphic since GAP-AUDIT §1.5
 * (PR #102) — no static `node:*` imports, no bare `process`; it reaches optional Node
 * facilities via `globalThis.process?.getBuiltinModule(...)` / `globalThis.crypto`,
 * which are absent in a Worker (→ safe no-op defaults). The old `node:crypto|fs|path`
 * aliases and the `process` define are gone. `sideEffects:false` on packages/core
 * drops cli/serve/mcp/registry (B1-SPIKE §3).
 *
 * This script is a dev/probe convenience — it emits to /tmp (NEVER committed) and is
 * not wired into any build; production builds the Worker via build-sandbox-worker.mjs.
 *
 * Output: an ESM bundle. By default to /tmp. Override with
 *   OUT=/path/to/bundle.mjs  and  CORE=/path/to/packages/core/src/index.ts
 *
 * Usage:
 *   node docs/sandbox/runtime/build-stitch-browser.mjs
 *   OUT=/tmp/stitch-browser.mjs node docs/sandbox/runtime/build-stitch-browser.mjs
 *
 * esbuild is resolved from node_modules if present, else via ESBUILD=/abs/path
 * (the spike's no-install method).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const ENTRY = resolve(__dirname, 'stitch-browser.ts');
const OUT = process.env.OUT ?? '/tmp/b1-out/stitch-browser.mjs';
const CORE =
    process.env.CORE ?? resolve(repoRoot, 'packages/core/src/index.ts');
// The auth surface is its own entry (ADR 0021); `stitchapi` aliases to a FILE, so
// `stitchapi/auth` cannot resolve underneath it and needs its own alias.
const CORE_AUTH = CORE.replace(/index\.ts$/, 'auth.ts');

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
    // Resolve `stitchapi` to the core source so the bundle builds without a publish/
    // install step. Core is browser-isomorphic (GAP-AUDIT §1.5) — no node:* or process
    // shims required.
    alias: {
        stitchapi: CORE,
        'stitchapi/auth': CORE_AUTH,
    },
    metafile: true,
    logLevel: 'info',
});

void result;
console.log(`\n[B1] wrote ESM bundle → ${OUT}`);
