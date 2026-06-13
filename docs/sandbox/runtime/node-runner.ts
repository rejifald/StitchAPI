/**
 * Server-side sandbox runner (Node) — the headless counterpart of the browser
 * `PlaygroundClient`. Runs a transpiled snippet in a fresh `node:worker_threads`
 * worker against the fake-API sim, returning the same structured `RunResult`.
 *
 * Reuses the env-agnostic `makeBrowserWorkerRunner` (transpile on the main
 * thread, timeout/abort/no-bleed via worker `terminate()`); the worker body is
 * the bundled `dist/node-worker.mjs` (`worker-main.node.ts`). This is the
 * `ThreadWorker` pattern proven by `browser-runner.test.ts`, productionized.
 */
import type { CodeRunner, RunRequest, RunResult } from '../component/runner';
import { type WorkerLike, makeBrowserWorkerRunner } from './browser-runner';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorkerImpl } from 'node:worker_threads';

/** `dist/node-worker.mjs` sits beside this module's bundle (`dist/mcp.mjs`). */
const NODE_WORKER_URL = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'node-worker.mjs',
);

/**
 * Wrap a `node:worker_threads` Worker as the runner's `WorkerLike`. `terminate()`
 * is a real thread kill — the timeout/abort kill switch (SEC-20/24/25).
 */
class ThreadWorker implements WorkerLike {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    private readonly w: ThreadWorkerImpl;
    constructor(url: string) {
        this.w = new ThreadWorkerImpl(url);
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

/** Default hard cap for an agent-submitted snippet (overridable per call). */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 5_000;

// A module singleton; each run spawns a FRESH worker (no cross-run state bleed).
const runner: CodeRunner = makeBrowserWorkerRunner({
    workerFactory: () => new ThreadWorker(NODE_WORKER_URL),
    defaultTimeoutMs: SANDBOX_DEFAULT_TIMEOUT_MS,
});

export interface RunInSandboxOptions {
    /** Hard time limit (ms); the worker is terminated past it. */
    timeoutMs?: number;
    /** Cooperative cancellation. */
    signal?: AbortSignal;
}

/**
 * Transpile + run `code` in a `worker_threads` sandbox against the sim. Never
 * rejects for snippet errors — those land in `RunResult.error` (the CodeRunner
 * contract); only an unrecoverable harness bug rejects.
 */
export function runInSandbox(
    code: string,
    opts: RunInSandboxOptions = {},
): Promise<RunResult> {
    const req: RunRequest = { code };
    if (opts.timeoutMs !== undefined) req.timeoutMs = opts.timeoutMs;
    if (opts.signal !== undefined) req.signal = opts.signal;
    return runner.run(req);
}
