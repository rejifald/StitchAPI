/**
 * Worker bundle entry — the module that becomes the running playground Web Worker.
 *
 * This is the production wiring that `browser-runner.ts`'s `browserWorkerRunner`
 * deliberately left to "the docs app's bundler" (its default `workerFactory` is a
 * throwing stub). esbuild (`build-sandbox-worker.mjs`) bundles THIS file —
 * together with the B1 `stitch-browser` build, the S5 sandbox-sim fetch shim, and
 * the Node-built-in shims — into one self-contained, Node-free ESM Worker the docs
 * app serves at `/sandbox/sandbox-worker.mjs` and instantiates with
 *   `new Worker('/sandbox/sandbox-worker.mjs', { type: 'module' })`.
 *
 * Its only job: assemble the allow-listed {@link WorkerEnv} (SEC-30/34 — the
 * snippet's ONLY `fetch` is the sim shim, no host network/globals reachable) and
 * hand it to {@link installWorkerEntry}, which wires the run/result/progress pump.
 *
 * Type-checking: bundled by esbuild, which only erases types. Its shared modules
 * (worker-entry, the runner contract, the sandbox-sim adapter) are type-checked by
 * the docs app's `check:types`; the B1 `stitch-browser` surface by
 * `tsconfig.browser.json`. This thin glue is validated by the bundle succeeding
 * plus the end-to-end browser run.
 */
import { createFetchShim } from '../../../packages/sandbox-sim/src/adapters/browser';
import { allHandlers } from '../../../packages/sandbox-sim/src/handlers';
import type { SimKnobs } from '../contracts/sim';
import { hardenWorkerGlobal } from './harden-worker-global';
import { browserProcess } from './shims/process';
import * as stitchBuild from './stitch-browser';
import { createTraceCollector } from './trace-collector';
import {
    type WorkerEnv,
    type WorkerGlobal,
    installWorkerEntry,
} from './worker-entry';

// Same deal for the runtime-schema pair the blog's `compile(JsonSchema.adapt(...))`
// snippet needs: `@stitchapi/json-schema` is a pure wrapper (it takes the engine as an
// argument — no Node) and `ajv` is pure JS. Bundled so `import { JsonSchema } from
// '@stitchapi/json-schema'` and `import Ajv from 'ajv'` resolve via __stitchImport.
import * as jsonSchema from '@stitchapi/json-schema';
import * as ajv from 'ajv';
// Bundled so a snippet's `import { z } from 'zod'` resolves (via __stitchImport).
// zod is pure JS / browser-safe; esbuild bundles it into the Worker (no runtime
// module loader exists here — SEC-31).
import * as zod from 'zod';

// Baseline knobs for the current run (the "Response knobs" panel). Mutated by
// `env.applyKnobs` before each run; the shim reads it on every request so a
// configured knob shapes the whole run. URL-explicit knobs still win (dispatch).
let currentKnobs: SimKnobs | undefined;

// SEC-01/04/30/34 — harden the worker's REAL global BEFORE any snippet can run,
// so the `Function('return this')()` escape (which bypasses worker-entry's
// parameter shadowing) reaches only inert `undefined`s, not a live `WebSocket` /
// `XMLHttpRequest` / `EventSource` / `importScripts` / `navigator.sendBeacon`.
// Runs before the sim-`fetch` shim install below and never touches `fetch`.
hardenWorkerGlobal();

// The sandbox-sim dispatch shim — the only `fetch` reachable in this Worker. No
// real socket is ever opened; an unknown route returns the sandbox-404 (SEC-01..04).
const simFetch = createFetchShim(allHandlers, () => currentKnobs);

// Replace the Worker's GLOBAL `fetch` so the bundled `stitch` core routes through
// the simulator too — not just snippet-level `fetch(...)`. Core resolves `fetch`
// at call time and the snippet only runs after this module has fully evaluated, so
// the override is always in effect before any stitch fires. This is what makes
// "no real network" real: the sole reachable fetch IS the sim shim.
(globalThis as { fetch?: unknown }).fetch = simFetch;

// A2: wrap the build's `stitch` so each call a snippet makes surfaces as a
// StitchTraceEntry, and expose the matching `bindProgress` hook so those entries
// flow to the result/DAG. Other build exports pass through untouched.
const traceCollector = createTraceCollector(
    stitchBuild.stitch as unknown as (config: unknown) => unknown,
);

const env: WorkerEnv = {
    // The whole B1 stitch build, exposed name-by-name into the snippet scope,
    // with the traced `stitch` overriding the raw re-export.
    stitchBuild: {
        ...stitchBuild,
        stitch: traceCollector.stitch,
    } as unknown as Record<string, unknown>,
    // Modules a snippet may `import` beyond 'stitchapi' (rebound via __stitchImport).
    modules: { zod, '@stitchapi/json-schema': jsonSchema, ajv },
    // The snippet's `fetch` (cast: createFetchShim is precisely `fetch`-typed,
    // WorkerEnv.fetch is the loose (unknown, unknown) wire shape).
    fetch: simFetch as unknown as WorkerEnv['fetch'],
    // `process` for the snippet scope (Workers have none) — bound as the snippet's
    // `process` so its `process.env.*` reads resolve to `{}`. Core needs no shim: it
    // reads the guarded `globalThis.process?.env` seam, absent here → safe defaults.
    process: browserProcess,
    // Web Crypto for the snippet scope (its `globalThis` is shadowed in worker-entry).
    // Core uses the real `globalThis.crypto` directly (engine write path / otlp ids).
    crypto: (globalThis as { crypto?: unknown }).crypto,
    // Drain the B1 shim-notice buffer after each run → RunResult.notices (SEC-33).
    // The shims' RunNotice is structurally identical to the wire WireNotice.
    drainNotices: stitchBuild.drainNotices,
    // Install the run's baseline knobs so `simFetch` applies them to every call.
    applyKnobs: (knobs) => {
        currentKnobs = knobs;
    },
    // Bind the run's progress sink so traced `stitch` calls reach the DAG (A2).
    bindProgress: traceCollector.bindProgress,
};

// `self` is the Worker global; the only WebWorker-touching line in the build.
installWorkerEntry(self as unknown as WorkerGlobal, env);
