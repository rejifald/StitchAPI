/**
 * Node worker entry — the `node:worker_threads` body for the SERVER-side sandbox.
 *
 * The Node counterpart of `worker-main.ts` (browser). Same execution core
 * (`installWorkerEntry` / `runSnippetInWorker`), but:
 *   - binds the REAL `stitchapi` (Node-native — no B1 shims needed), and
 *   - routes ALL `fetch` through the sandbox-sim NODE adapter (global override),
 *     so a snippet's `stitch()` calls hit the fake API, never the real network.
 *
 * `worker_threads` gives lifecycle isolation (terminate-on-timeout, abort, no
 * cross-run global bleed). It is NOT a host-isolation boundary — a snippet can
 * still reach Node via the `Function` constructor / dynamic `import()`. That is
 * acceptable ONLY for the LOCAL/TRUSTED MCP server; a public, untrusted surface
 * needs the deferred isolated-vm tier (SANDBOX-STATUS §5.3).
 *
 * Bundled to `dist/node-worker.mjs` by `build-sandbox-mcp.mjs` (esbuild, platform
 * node) and spawned by `node-runner.ts` via `new Worker(url)`.
 */
import { createFetchShim } from '../../../packages/sandbox-sim/src/adapters/node';
import { allHandlers } from '../../../packages/sandbox-sim/src/handlers';
import type { SimKnobs } from '../contracts/sim';
import {
    type WorkerEnv,
    type WorkerGlobal,
    installWorkerEntry,
} from './worker-entry';

import { parentPort } from 'node:worker_threads';
import * as stitchBuild from 'stitchapi';
// Bundled so a snippet's `import { z } from 'zod'` resolves (via __stitchImport).
import * as zod from 'zod';

// Baseline knobs for the current run, mutated by `env.applyKnobs`; the shim
// reads it on every request. URL-explicit knobs still win (see dispatch).
let currentKnobs: SimKnobs | undefined;

// The sandbox-sim dispatch shim — the only `fetch` reachable from a snippet. No
// real socket is opened; an unknown route returns the sandbox-404 (SEC-01..04).
const simFetch = createFetchShim(allHandlers, () => currentKnobs);

// Route the bundled `stitch` core through the sim too (it calls the bare global
// `fetch`), not just snippet-level `fetch(...)`. This is what guarantees the
// server sandbox makes no real network egress.
(globalThis as { fetch?: unknown }).fetch = simFetch;

const env: WorkerEnv = {
    // The whole real `stitchapi` surface, exposed name-by-name into the snippet.
    stitchBuild: stitchBuild as unknown as Record<string, unknown>,
    // Modules a snippet may `import` beyond 'stitchapi' (rebound via __stitchImport).
    modules: { zod },
    fetch: simFetch as unknown as WorkerEnv['fetch'],
    // A clean `process` shadow for the snippet scope (no host env leakage). Core
    // itself still reads the real `process` in its own module scope.
    process: { env: {}, platform: 'node-sandbox', versions: {} },
    crypto: (globalThis as { crypto?: unknown }).crypto,
    // The real `stitchapi` has no browser shim-notice buffer.
    drainNotices: () => [],
    // Install the run's baseline knobs so `simFetch` applies them to every call.
    applyKnobs: (knobs) => {
        currentKnobs = knobs;
    },
};

if (!parentPort) {
    throw new Error(
        'worker-main.node must run as a node:worker_threads worker (no parentPort).',
    );
}

// Bridge the worker_threads port to the WorkerGlobal contract installWorkerEntry
// expects: deliver each message as `{ data }`, post results back through the port.
// (Explicit `on('message')` rather than relying on MessagePort.onmessage compat.)
const port = parentPort;
const workerGlobal: WorkerGlobal = {
    onmessage: null,
    postMessage: (message: unknown) => port.postMessage(message),
};
port.on('message', (data: unknown) => workerGlobal.onmessage?.({ data }));
installWorkerEntry(workerGlobal, env);
