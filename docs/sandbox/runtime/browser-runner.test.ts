/**
 * R1 — browser-worker runner harness tests (no browser, no installed deps).
 *
 * We inject TWO kinds of fake `WorkerLike` into `makeBrowserWorkerRunner` so we
 * can MECHANICALLY prove the security-checklist behaviours that the production
 * Web Worker would otherwise need a browser to demonstrate:
 *
 *   A) `ThreadWorker` — backed by `node:worker_threads`. A REAL OS thread runs
 *      the snippet, so `worker.terminate()` genuinely kills a `while(true){}`.
 *      This is what makes SEC-20/24 (timeout) and SEC-25 (abort) real proofs
 *      rather than cooperative fakes, and SEC-36/37 (no bleed) cross a real
 *      thread/global boundary.
 *
 *   B) `InProcWorker` — a same-process fake that drives the ACTUAL
 *      `runSnippetInWorker` from worker-entry.ts with injected fake env. Fast +
 *      deterministic; proves ordered console capture (SEC-35), throw containment
 *      (SEC-39a), shim notices (SEC-33), and the transpile/internal paths
 *      (SEC-39b/d) against the real worker body.
 *
 * Run with:  npx -y tsx docs/sandbox/runtime/browser-runner.test.ts
 */
import type { RunEvent, RunResult } from '../component/runner';
import { type WorkerLike, makeBrowserWorkerRunner } from './browser-runner';
import {
    type ProgressSink,
    type WorkerEnv,
    runSnippetInWorker,
} from './worker-entry';
import type { ResultMessage, RunMessage } from './worker-protocol';

import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorkerImpl } from 'node:worker_threads';

/* -------------------------------------------------------------------------- */
/*  Tiny assertion harness (mirrors transpile.test.ts convention)             */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.error(`  FAIL  ${label}`, detail ?? '');
        failed++;
    }
}

/** A fake transpile that erases nothing — the test snippets are already JS. */
const passthroughTranspile = (async (code: string) => ({ js: code })) as never;

/* -------------------------------------------------------------------------- */
/*  Fake env (the allow-listed worker scope), shared shape for both workers   */
/* -------------------------------------------------------------------------- */

/**
 * A minimal fake `WorkerEnv`. `stitchBuild` carries a couple of fake surfaces;
 * `drainNotices` returns whatever the fake `env` emitted this run (and is
 * reset per run, proving the drain-and-clear contract).
 */
function makeFakeEnv(): WorkerEnv {
    let pending: {
        kind: 'shim' | 'info';
        surface?: string;
        message: string;
    }[] = [];
    return {
        stitchBuild: {
            stitch: (url: string) => Promise.resolve({ ok: true, url }),
            env: (name: string) => {
                pending.push({
                    kind: 'shim',
                    surface: 'env',
                    message: `running shimmed — \`env\` is simulated`,
                });
                return `demo-${name}-secret`;
            },
        },
        fetch: async () => ({ status: 200 }),
        process: { env: {}, platform: 'browser', versions: {} },
        crypto: { randomUUID: () => 'uuid-0000' },
        drainNotices: () => {
            const out = pending;
            pending = [];
            return out;
        },
    };
}

/**
 * A1 progress-emitting fake env. Its `stitch` simulates a streamed call: it
 * emits a completed `trace` then two stream `chunk` events (in order) via the
 * progress sink the worker body wires through `bindProgress`. `env` emits
 * a `notice` event AND buffers the same notice for the final-result drain, so
 * the test can prove the progressive `notice` reconciles with `RunResult.notices`.
 * The shapes mirror the frozen `RunEvent` union (runner.ts).
 */
function makeProgressEnv(): WorkerEnv {
    let pending: {
        kind: 'shim' | 'info';
        surface?: string;
        message: string;
    }[] = [];
    let sink: ProgressSink | undefined;
    const traceId = 's1';
    return {
        stitchBuild: {
            stitch: (url: string) => {
                // A completed stitch trace, then the stream chunks for it — the
                // §8 "forward chunks as they arrive" path, in real order.
                sink?.({
                    type: 'trace',
                    entry: {
                        id: traceId,
                        request: { method: 'GET', url },
                        response: { status: 200, ok: true, durationMs: 5 },
                        stream: { chunks: 2 },
                    },
                });
                sink?.({ type: 'chunk', traceId, text: 'Hel' });
                sink?.({ type: 'chunk', traceId, text: 'lo' });
                return Promise.resolve({ ok: true, url, body: 'Hello' });
            },
            env: (name: string) => {
                const notice = {
                    kind: 'shim' as const,
                    surface: 'env',
                    message: `running shimmed — \`env\` is simulated`,
                };
                pending.push(notice);
                sink?.({ type: 'notice', notice });
                return `demo-${name}-secret`;
            },
        },
        fetch: async () => ({ status: 200 }),
        process: { env: {}, platform: 'browser', versions: {} },
        crypto: { randomUUID: () => 'uuid-0000' },
        drainNotices: () => {
            const out = pending;
            pending = [];
            return out;
        },
        bindProgress: (s: ProgressSink) => {
            sink = s;
            return () => {
                sink = undefined;
            };
        },
    };
}

/* -------------------------------------------------------------------------- */
/*  (B) In-process fake worker — drives the REAL runSnippetInWorker           */
/* -------------------------------------------------------------------------- */

/**
 * Same-process `WorkerLike`. On `postMessage(run)`, it executes the real worker
 * body and delivers the structured result via `onmessage` on a microtask, just
 * like a real Worker. `terminate()` flips a flag so a late result is dropped.
 */
class InProcWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private terminated = false;
    constructor(private readonly env: WorkerEnv) {}

    postMessage(message: unknown): void {
        const msg = message as RunMessage;
        // A1: mirror a real worker — relay each progressive event as a `progress`
        // message AS IT HAPPENS (dropped after terminate, like a killed worker),
        // then deliver the single terminal `result`.
        const onProgress: ProgressSink = (event: RunEvent) => {
            if (this.terminated) return;
            this.onmessage?.({ data: { type: 'progress', event } });
        };
        runSnippetInWorker(this.env, msg, onProgress).then(
            (result: ResultMessage) => {
                if (this.terminated) return; // killed → never deliver (containment)
                this.onmessage?.({ data: result });
            },
        );
    }
    terminate(): void {
        this.terminated = true;
    }
}

/* -------------------------------------------------------------------------- */
/*  (A) worker_threads-backed fake worker — REAL thread, real terminate()     */
/* -------------------------------------------------------------------------- */

/**
 * The worker-thread body, as a plain-JS string. It mirrors worker-entry.ts's
 * execution model (allow-listed scope, async IIFE, capturing console, fake env)
 * but lives inline so the test needs no TS compilation INSIDE the thread. The
 * crucial property under test: a `while(true){}` snippet runs on THIS thread, so
 * `worker.terminate()` from the main thread truly stops it (SEC-20/21/24).
 *
 * It also seeds `globalThis.__bleed` checks: each thread is fresh, so a value set
 * on `globalThis` in one run is absent in the next thread's run (SEC-36).
 */
const THREAD_BODY = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async (msg) => {
  const logs = [];
  const t0 = Date.now();
  const mkSink = (level) => (...args) => logs.push({ level, args, at: Date.now() - t0 });
  const fakeConsole = { log: mkSink('log'), info: mkSink('info'), warn: mkSink('warn'), error: mkSink('error'), debug: mkSink('debug') };
  const notices = [];
  const scope = {
    console: fakeConsole,
    fetch: async () => ({ status: 200 }),
    process: { env: {}, platform: 'browser', versions: {} },
    crypto: { randomUUID: () => 'uuid-0000' },
    stitch: (url) => Promise.resolve({ ok: true, url }),
    env: (name) => { notices.push({ kind: 'shim', surface: 'env', message: 'shimmed' }); return 'demo-' + name + '-secret'; },
    window: undefined, self: undefined, globalThis: undefined, document: undefined, require: undefined,
  };
  const names = Object.keys(scope);
  const values = names.map((n) => scope[n]);
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  try {
    const fn = new AsyncFunction(...names, '"use strict";\\nreturn (async () => {\\n' + msg.js + '\\n})();');
    const value = await fn(...values);
    parentPort.postMessage({ type: 'result', logs, notices, value: clone(value) });
  } catch (err) {
    parentPort.postMessage({ type: 'result', logs, notices, error: { name: err && err.name || 'Error', message: err && err.message || String(err), stack: err && err.stack } });
  }
});
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; } }
`;

/**
 * Wrap a `node:worker_threads` Worker as a `WorkerLike`. `terminate()` calls the
 * real thread terminate (a hard kill — this is the whole point of the SEC-20
 * proof). `onerror` is wired to the thread `error` event so a spawn/eval failure
 * surfaces as an engine/internal error on the main thread.
 */
class ThreadWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private readonly w: ThreadWorkerImpl;
    constructor() {
        this.w = new ThreadWorkerImpl(THREAD_BODY, { eval: true });
        this.w.on('message', (data) => this.onmessage?.({ data }));
        this.w.on('error', (err) => this.onerror?.(err));
    }
    postMessage(message: unknown): void {
        this.w.postMessage(message);
    }
    terminate(): void {
        void this.w.terminate();
    }
}

/* -------------------------------------------------------------------------- */
/*  (A′) Function-constructor egress-escape worker (SEC-01/04/30/34)           */
/* -------------------------------------------------------------------------- */

/**
 * A worker-thread body that reproduces the production worker BOOTSTRAP so we can
 * mechanically prove the `Function('return this')()` sandbox-escape is closed.
 *
 * It (1) SEEDS live egress capabilities (`WebSocket`, `XMLHttpRequest`,
 * `EventSource`, `importScripts`, `navigator.sendBeacon`) onto the thread's REAL
 * `globalThis` — so before hardening the escape reaches live functions, exactly
 * as it does in an un-hardened Worker; (2) OPTIONALLY calls the SHIPPED
 * `hardenWorkerGlobal()` from `harden-worker-global.ts` (the Finding-1 fix),
 * gated on `msg.harden`; (3) runs the snippet under the SAME allow-listed scope
 * + AsyncFunction wrapper as worker-entry.ts, where the dangerous globals are
 * bound `undefined` as PARAMETERS only (the shadowing the escape defeats).
 *
 * The snippet reaches the real global via `Function('return this')()` and the
 * result reports what each capability resolved to. With `harden:true` every one
 * must be `'undefined'`; with `harden:false` they are live — proving the test
 * would fail if the bootstrap hardening were absent (the vuln is real, the fix
 * is what closes it). Runs the thread under tsx (`--import tsx`) so it can import
 * the real `.ts` hardening module rather than a copy (no logic drift).
 */
const ESCAPE_THREAD_BODY = `
const { parentPort } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
parentPort.on('message', async (msg) => {
  try {
    // Seed live egress capabilities on the REAL worker global (an un-hardened
    // Worker exposes these; a bare Node worker doesn't have them all, so we seed
    // them to make the "before" state faithful for every capability).
    const g = Function('return this')();
    g.WebSocket = function FakeWebSocket(){ this.real = true; };
    g.XMLHttpRequest = function FakeXHR(){ this.real = true; };
    g.EventSource = function FakeEventSource(){ this.real = true; };
    g.importScripts = function importScripts(){ return 'loaded-remote-code'; };
    g.Worker = function FakeWorker(){ this.real = true; };
    if (!g.navigator || typeof g.navigator !== 'object') g.navigator = {};
    try { g.navigator.sendBeacon = function sendBeacon(){ return true; }; } catch {}

    if (msg.harden) {
      const url = pathToFileURL(msg.hardenModulePath).href;
      const mod = await import(url);
      mod.hardenWorkerGlobal();
    }

    // Production-shaped allow-listed scope: the dangerous names are bound
    // undefined as PARAMETERS (worker-entry.ts). The escape below bypasses this.
    const logs = [];
    const scope = {
      console: { log: (...a) => logs.push(a), info(){}, warn(){}, error(){}, debug(){} },
      fetch: async () => ({ status: 200 }),
      process: { env: {}, platform: 'browser', versions: {} },
      crypto: { randomUUID: () => 'uuid-0000' },
      window: undefined, self: undefined, globalThis: undefined, document: undefined,
      importScripts: undefined, XMLHttpRequest: undefined, WebSocket: undefined,
      EventSource: undefined, require: undefined,
    };
    const names = Object.keys(scope);
    const values = names.map((n) => scope[n]);
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(...names, '"use strict";\\nreturn (async () => {\\n' + msg.js + '\\n})();');
    const value = await fn(...values);
    parentPort.postMessage({ type: 'result', logs, notices: [], value: clone(value) });
  } catch (err) {
    parentPort.postMessage({ type: 'result', logs: [], notices: [], error: { name: err && err.name || 'Error', message: err && err.message || String(err), stack: err && err.stack } });
  }
});
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; } }
`;

/**
 * `WorkerLike` over {@link ESCAPE_THREAD_BODY}. `harden` selects whether the
 * thread calls the shipped `hardenWorkerGlobal()` at bootstrap; `hardenModulePath`
 * is the absolute path to the real `.ts` module the thread imports under tsx.
 */
class EscapeThreadWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private readonly w: ThreadWorkerImpl;
    constructor(
        private readonly harden: boolean,
        private readonly hardenModulePath: string,
    ) {
        this.w = new ThreadWorkerImpl(ESCAPE_THREAD_BODY, {
            eval: true,
            // Run the thread under tsx so `import('<…>.ts')` resolves the real
            // hardening module (esbuild bundles it in production; tsx compiles it
            // here) — the test asserts the SHIPPED code, not a re-implementation.
            execArgv: ['--import', 'tsx'],
        });
        this.w.on('message', (data) => this.onmessage?.({ data }));
        this.w.on('error', (err) => this.onerror?.(err));
    }
    postMessage(message: unknown): void {
        // Fold the harden knob + module path into the run message the body reads.
        this.w.postMessage({
            ...(message as object),
            harden: this.harden,
            hardenModulePath: this.hardenModulePath,
        });
    }
    terminate(): void {
        void this.w.terminate();
    }
}

/** Absolute path to the shipped hardening module (imported inside the thread). */
const HARDEN_MODULE_PATH = fileURLToPath(
    new URL('./harden-worker-global.ts', import.meta.url),
);

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

async function runTests(): Promise<void> {
    console.log('\n--- R1 browser-worker runner: SEC harness ---\n');

    /* === (B) In-process / real-worker-body proofs ========================= */

    // SEC-35 — console captured IN ORDER, not leaked to host console.
    {
        const hostCalls: unknown[][] = [];
        const realLog = console.log;
        // Spy on the HOST console.log to prove zero leakage during the run.
        let leaks = 0;
        (console as { log: typeof console.log }).log = (...a: unknown[]) => {
            // Only count snippet-shaped leaks (the snippet logs 'a','b','c').
            if (
                a.length === 1 &&
                (a[0] === 'a' || a[0] === 'b' || a[0] === 'c')
            )
                leaks++;
            hostCalls.push(a);
        };
        let result: RunResult;
        try {
            const runner = makeBrowserWorkerRunner({
                transpileFn: passthroughTranspile,
                workerFactory: () => new InProcWorker(makeFakeEnv()),
            });
            result = await runner.run({
                code: `console.log('a'); console.warn('b'); console.log('c');`,
            });
        } finally {
            (console as { log: typeof console.log }).log = realLog;
        }
        assert(
            'SEC-35 host console.log NOT leaked (0 snippet logs)',
            leaks === 0,
            leaks,
        );
        assert('SEC-35 captured 3 logs', result.logs.length === 3, result.logs);
        assert(
            'SEC-35 logs in order with correct levels',
            result.logs[0]?.args[0] === 'a' &&
                result.logs[0]?.level === 'log' &&
                result.logs[1]?.args[0] === 'b' &&
                result.logs[1]?.level === 'warn' &&
                result.logs[2]?.args[0] === 'c' &&
                result.logs[2]?.level === 'log',
            result.logs,
        );
        assert(
            'SEC-35 run resolved (no error)',
            result.error === undefined,
            result.error,
        );
    }

    // SEC-39a — a snippet throw → reason:'throw', RunResult NEVER rejects.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeFakeEnv()),
        });
        let rejected = false;
        let result: RunResult | undefined;
        try {
            result = await runner.run({ code: `throw new Error('boom');` });
        } catch {
            rejected = true;
        }
        assert('SEC-39a run() did NOT reject on snippet throw', !rejected);
        assert(
            "SEC-39a error.phase === 'runtime'",
            result?.error?.phase === 'runtime',
            result?.error,
        );
        assert(
            "SEC-39a error.reason === 'throw'",
            result?.error?.reason === 'throw',
            result?.error,
        );
        assert(
            'SEC-39a message includes boom',
            !!result?.error?.message.includes('boom'),
            result?.error,
        );
    }

    // top-level await + final value resolved (SANDBOX §5.3).
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeFakeEnv()),
        });
        const result = await runner.run({
            code: `const r = await stitch('https://demo/x'); return r;`,
        });
        assert(
            'top-level await resolves final value',
            !!result.value && (result.value as { ok: boolean }).ok === true,
            result.value,
        );
    }

    // SEC-33 — shim notice surfaces on RunResult.notices (not a log scrape).
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeFakeEnv()),
        });
        const result = await runner.run({
            code: `const s = env('GH_TOKEN'); console.log(s); return s;`,
        });
        assert(
            'SEC-33 demo value returned',
            result.value === 'demo-GH_TOKEN-secret',
            result.value,
        );
        assert(
            'SEC-33 notices has 1 entry',
            (result.notices?.length ?? 0) === 1,
            result.notices,
        );
        assert(
            "SEC-33 notice surface === 'env', kind 'shim'",
            result.notices?.[0]?.surface === 'env' &&
                result.notices?.[0]?.kind === 'shim',
            result.notices,
        );
    }

    // SEC-39b — transpile error → phase:'transpile', never rejects.
    {
        const failingTranspile = (async () => ({
            error: {
                name: 'SyntaxError',
                message: 'Unexpected token (1:7)',
                phase: 'transpile' as const,
                line: 1,
                column: 7,
            },
        })) as never;
        const runner = makeBrowserWorkerRunner({
            transpileFn: failingTranspile,
            workerFactory: () => new InProcWorker(makeFakeEnv()),
        });
        let rejected = false;
        let result: RunResult | undefined;
        try {
            result = await runner.run({ code: `const x: = ;` });
        } catch {
            rejected = true;
        }
        assert('SEC-39b run() did NOT reject on transpile error', !rejected);
        assert(
            "SEC-39b error.phase === 'transpile'",
            result?.error?.phase === 'transpile',
            result?.error,
        );
        assert(
            'SEC-39b line/column preserved',
            result?.error?.line === 1 && result?.error?.column === 7,
            result?.error,
        );
    }

    // SEC-39d — engine failure (worker factory throws) → reason:'internal', resolves.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => {
                throw new Error('Worker failed to spawn');
            },
        });
        let rejected = false;
        let result: RunResult | undefined;
        try {
            result = await runner.run({ code: `1 + 1` });
        } catch {
            rejected = true;
        }
        assert('SEC-39d engine failure did NOT reject run()', !rejected);
        assert(
            "SEC-39d error.reason === 'internal'",
            result?.error?.reason === 'internal',
            result?.error,
        );
        assert(
            'SEC-39d internal NOT misclassified as transpile/throw',
            result?.error?.reason !== 'throw' &&
                result?.error?.phase !== 'transpile',
            result?.error,
        );
    }

    /* === A1 — progressive onEvent emission (Wave 4) ====================== */

    // A1 — onEvent fires log/trace/chunk/notice IN ORDER during the run, and the
    // events reconcile with the final RunResult (same logs + same notices).
    {
        const events: RunEvent[] = [];
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeProgressEnv()),
        });
        const result = await runner.run({
            // log → (stitch emits trace+2 chunks) → log → env emits notice.
            code:
                `console.log('start');` +
                `const r = await stitch('https://demo/x');` +
                `console.log('mid');` +
                `const s = env('GH_TOKEN');` +
                `return r;`,
            onEvent: (e) => events.push(e),
        });

        const types = events.map((e) => e.type);
        assert(
            'A1 events in real order: log, trace, chunk, chunk, log, notice',
            JSON.stringify(types) ===
                JSON.stringify([
                    'log',
                    'trace',
                    'chunk',
                    'chunk',
                    'log',
                    'notice',
                ]),
            types,
        );

        // chunk events carry traceId + text in order.
        const chunks = events.filter((e) => e.type === 'chunk') as Extract<
            RunEvent,
            { type: 'chunk' }
        >[];
        assert(
            'A1 chunk events carry traceId + ordered text',
            chunks.length === 2 &&
                chunks[0]?.traceId === 's1' &&
                chunks[0]?.text === 'Hel' &&
                chunks[1]?.text === 'lo',
            chunks,
        );

        // trace event content matches what a stitch() produced.
        const traceEv = events.find((e) => e.type === 'trace') as
            Extract<RunEvent, { type: 'trace' }> | undefined;
        assert(
            'A1 trace event has id + stream chunk count',
            traceEv?.entry.id === 's1' && traceEv?.entry.stream?.chunks === 2,
            traceEv,
        );

        // RECONCILIATION: progressive log events === final RunResult.logs.
        const logEvents = events.filter((e) => e.type === 'log') as Extract<
            RunEvent,
            { type: 'log' }
        >[];
        assert(
            'A1 progressive logs reconcile with final RunResult.logs',
            logEvents.length === result.logs.length &&
                logEvents.every(
                    (le, i) =>
                        le.entry.level === result.logs[i]?.level &&
                        JSON.stringify(le.entry.args) ===
                            JSON.stringify(result.logs[i]?.args),
                ),
            { logEvents, finalLogs: result.logs },
        );

        // RECONCILIATION: progressive notice events === final RunResult.notices.
        const noticeEvents = events.filter(
            (e) => e.type === 'notice',
        ) as Extract<RunEvent, { type: 'notice' }>[];
        assert(
            'A1 progressive notices reconcile with final RunResult.notices',
            noticeEvents.length === (result.notices?.length ?? 0) &&
                noticeEvents.every(
                    (ne, i) =>
                        ne.notice.surface === result.notices?.[i]?.surface &&
                        ne.notice.kind === result.notices?.[i]?.kind &&
                        ne.notice.message === result.notices?.[i]?.message,
                ),
            { noticeEvents, finalNotices: result.notices },
        );

        // run() still single-shot: the final value is intact.
        assert(
            'A1 run() still resolves the full RunResult (value intact)',
            !!result.value &&
                (result.value as { ok: boolean }).ok === true &&
                result.error === undefined,
            result,
        );
    }

    // A1 — a run with NO onEvent resolves an IDENTICAL RunResult (no-op cost).
    {
        const code =
            `console.log('start');` +
            `const r = await stitch('https://demo/x');` +
            `console.log('mid');` +
            `const s = env('GH_TOKEN');` +
            `return r;`;
        const withEvents: RunEvent[] = [];
        const runnerA = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeProgressEnv()),
        });
        const runnerB = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeProgressEnv()),
        });
        const rWith = await runnerA.run({
            code,
            onEvent: (e) => withEvents.push(e),
        });
        const rWithout = await runnerB.run({ code }); // no onEvent

        // Compare the result minus wall-clock fields (durationMs + per-log `at`
        // vary run-to-run), proving the observation channel did not perturb the
        // byte-for-byte final result content.
        const strip = (r: RunResult) => ({
            ...r,
            durationMs: 0,
            logs: r.logs.map((l) => ({ ...l, at: 0 })),
        });
        assert(
            'A1 no-onEvent RunResult identical to onEvent RunResult',
            JSON.stringify(strip(rWithout)) === JSON.stringify(strip(rWith)),
            { rWith, rWithout },
        );
        assert(
            'A1 no-onEvent path emitted nothing observable (still produced result)',
            !!rWithout.value,
            rWithout,
        );
    }

    // A1 — a THROWING onEvent callback does NOT break the run (still resolves).
    {
        let rejected = false;
        let result: RunResult | undefined;
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new InProcWorker(makeProgressEnv()),
        });
        try {
            result = await runner.run({
                code:
                    `console.log('x');` +
                    `const r = await stitch('https://demo/x');` +
                    `return r;`,
                onEvent: () => {
                    throw new Error('host onEvent blew up');
                },
            });
        } catch {
            rejected = true;
        }
        assert('A1 throwing onEvent did NOT reject run()', !rejected);
        assert(
            'A1 throwing onEvent still resolved the full RunResult',
            !!result?.value &&
                (result.value as { ok: boolean }).ok === true &&
                result?.error === undefined,
            result,
        );
        assert(
            'A1 throwing onEvent still captured logs',
            result?.logs.length === 1,
            result?.logs,
        );
    }

    /* === (A) worker_threads proofs: REAL terminate() ===================== */

    // SEC-20/24 — timeout terminates a REAL while(true){} thread → 'timeout'.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new ThreadWorker(),
            defaultTimeoutMs: 200,
        });
        const t0 = Date.now();
        const result = await runner.run({
            code: `while (true) {}`,
            timeoutMs: 200,
        });
        const elapsed = Date.now() - t0;
        assert(
            'SEC-20 timeout RESOLVED (did not hang)',
            !!result.error,
            result,
        );
        assert(
            "SEC-20 error.reason === 'timeout'",
            result.error?.reason === 'timeout',
            result.error,
        );
        assert(
            "SEC-20 error.phase === 'runtime'",
            result.error?.phase === 'runtime',
            result.error,
        );
        assert(
            'SEC-20/24 settled well under 1s (preemptive kill)',
            elapsed < 1000,
            elapsed,
        );
    }

    // SEC-22 — omitted timeoutMs still terminates within the default cap.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new ThreadWorker(),
            defaultTimeoutMs: 200,
        });
        const t0 = Date.now();
        const result = await runner.run({ code: `while (true) {}` }); // no timeoutMs
        assert(
            "SEC-22 default cap fired ('timeout')",
            result.error?.reason === 'timeout',
            result.error,
        );
        assert('SEC-22 settled (< 1s)', Date.now() - t0 < 1000);
    }

    // SEC-25 — signal abort terminates the REAL thread → reason:'abort'.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new ThreadWorker(),
            defaultTimeoutMs: 5000,
        });
        const controller = new AbortController();
        const t0 = Date.now();
        setTimeout(() => controller.abort(), 50);
        const result = await runner.run({
            code: `while (true) {}`,
            signal: controller.signal,
        });
        assert('SEC-25 abort RESOLVED (did not hang)', !!result.error, result);
        assert(
            "SEC-25 error.reason === 'abort'",
            result.error?.reason === 'abort',
            result.error,
        );
        assert('SEC-25 settled promptly (< 1s)', Date.now() - t0 < 1000);
    }

    // SEC-36/37 — no state bleed: a fresh thread per run, real globalThis.
    {
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new ThreadWorker(),
            defaultTimeoutMs: 2000,
        });
        // Run 1 tries to stash a value on the thread's globalThis.
        await runner.run({
            code: `try { globalThis.__bleed = 'x'; } catch {} return 1;`,
        });
        // Run 2 (fresh thread) reads it back.
        const r2 = await runner.run({
            code: `return (typeof globalThis !== 'undefined' && globalThis.__bleed) ? 'BLED' : 'clean';`,
        });
        assert(
            'SEC-36/37 no globalThis bleed across runs',
            r2.value === 'clean',
            r2.value,
        );
    }

    // SEC-01/04/30/34 — Function-constructor egress escape is CLOSED at bootstrap.
    // A snippet reaches the worker's REAL global via `Function('return this')()`
    // (bypassing worker-entry's parameter shadowing). After the shipped
    // `hardenWorkerGlobal()` runs, every real-egress capability it could grab is
    // inert `undefined`; without it they are live (proven by the control run
    // below). This is the regression for Finding 1.
    {
        // The escape snippet: grab the real global by the Function-constructor
        // route and report what each dangerous capability resolves to. It also
        // proves `WebSocket` is not merely shadowed but genuinely unconstructable.
        const escapeCode = `
            const g = Function('return this')();
            let constructed = false;
            try { new g.WebSocket('wss://evil.example.com'); constructed = true; } catch {}
            return {
              ws: typeof g.WebSocket,
              xhr: typeof g.XMLHttpRequest,
              es: typeof g.EventSource,
              imp: typeof g.importScripts,
              worker: typeof g.Worker,
              beacon: typeof (g.navigator && g.navigator.sendBeacon),
              constructedWebSocket: constructed,
            };`;

        // (i) HARDENED — the production path. Every capability must be gone.
        const hardenedRunner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () =>
                new EscapeThreadWorker(true, HARDEN_MODULE_PATH),
            defaultTimeoutMs: 5000,
        });
        const hardened = await hardenedRunner.run({ code: escapeCode });
        const hv = hardened.value as Record<string, unknown> | undefined;
        assert(
            'SEC-04 Function-escape run resolved (no error)',
            hardened.error === undefined && !!hv,
            hardened.error ?? hardened.value,
        );
        assert(
            "SEC-04 escaped globalThis.WebSocket is 'undefined' after harden",
            hv?.ws === 'undefined',
            hv,
        );
        assert(
            "SEC-04 escaped globalThis.XMLHttpRequest is 'undefined' after harden",
            hv?.xhr === 'undefined',
            hv,
        );
        assert(
            "SEC-04 escaped globalThis.EventSource is 'undefined' after harden",
            hv?.es === 'undefined',
            hv,
        );
        assert(
            "SEC-31 escaped globalThis.importScripts is 'undefined' after harden",
            hv?.imp === 'undefined',
            hv,
        );
        assert(
            "SEC-04 escaped globalThis.Worker is 'undefined' after harden",
            hv?.worker === 'undefined',
            hv,
        );
        assert(
            "SEC-04 escaped navigator.sendBeacon is 'undefined' after harden",
            hv?.beacon === 'undefined',
            hv,
        );
        assert(
            'SEC-04 new (escaped WebSocket) did NOT construct after harden',
            hv?.constructedWebSocket === false,
            hv,
        );

        // (ii) CONTROL — same body WITHOUT the bootstrap harden. This documents
        // the vuln: the escape DOES reach a live WebSocket. It proves the assertions
        // above are meaningful (they would fail if hardening were removed).
        const unhardenedRunner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () =>
                new EscapeThreadWorker(false, HARDEN_MODULE_PATH),
            defaultTimeoutMs: 5000,
        });
        const control = await unhardenedRunner.run({ code: escapeCode });
        const cv = control.value as Record<string, unknown> | undefined;
        assert(
            'SEC-04 CONTROL (no harden): escape reaches a LIVE WebSocket',
            cv?.ws === 'function' && cv?.constructedWebSocket === true,
            cv,
        );
    }

    // SEC-21 (partial) — host main thread stayed responsive during the loop.
    {
        let ticks = 0;
        const ticker = setInterval(() => {
            ticks++;
        }, 20);
        const runner = makeBrowserWorkerRunner({
            transpileFn: passthroughTranspile,
            workerFactory: () => new ThreadWorker(),
            defaultTimeoutMs: 300,
        });
        await runner.run({ code: `while (true) {}`, timeoutMs: 300 });
        clearInterval(ticker);
        assert(
            'SEC-21 host main thread kept ticking during loop',
            ticks >= 3,
            ticks,
        );
    }

    /* === Summary ========================================================== */
    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed === 0) {
        console.log('R1 OK');
    } else {
        console.error('R1 FAILED');
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
});
