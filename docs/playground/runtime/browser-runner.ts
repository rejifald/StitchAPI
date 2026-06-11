/**
 * R1 — Browser Web Worker runner (the security-critical execution core).
 *
 * Implements the FROZEN `CodeRunner` contract (../component/runner.ts) for the
 * browser tier (SANDBOX §5). Untrusted snippet code is isolated in a dedicated
 * Web Worker, killed on `timeoutMs` via `worker.terminate()`, cancelled on
 * `signal`, denied all real egress (its only `fetch` is the S5 sim shim), and
 * never allowed to leak to the host `console` or bleed state between runs.
 *
 * ─── Pipeline (SANDBOX §5, mapped to the security checklist) ────────────────
 *   1. Transpile via R2 (`transpile()`); a transpile error resolves a
 *      `RunResult{error:{phase:'transpile'}}` and NEVER throws (SEC-39b).
 *   2. Spawn a dedicated Worker (via the injected factory) whose scope holds the
 *      B1 stitch build, a capturing `console`, the S5 fetch shim as `fetch`, and
 *      the B1 `process`/Web-Crypto shims — NO host `window`/`globalThis`
 *      reachable (SEC-30/31/32/34). The worker body lives in worker-entry.ts.
 *   3. The worker wraps the snippet in an async IIFE (top-level await), resolves
 *      the final value (SANDBOX §5.3).
 *   4. `console.*` is captured IN ORDER into `RunResult.logs`, never leaked to
 *      the host console (SEC-35).
 *   5. B1 `drainNotices()` → `RunResult.notices` (SEC-33).
 *   6. `timeoutMs` is enforced by the MAIN thread: on expiry → `terminate()` →
 *      `reason:'timeout'` (SEC-20/24). `signal` abort → `terminate()` →
 *      `reason:'abort'` (SEC-25). A snippet throw → `reason:'throw'` (SEC-39a).
 *      An engine failure (spawn failed, malformed message) → `reason:'internal'`
 *      (SEC-39d). Every class RESOLVES a renderable RunResult; `run()` rejects
 *      only for an unrecoverable harness bug (SEC-39d, contract anchor).
 *   7. `dispose()` tears down any live worker + listeners.
 *
 * ─── Dependency injection (Node-testable without a browser / installed deps) ─
 * The real deps (sucrase, the bundled stitch-browser, a DOM Worker) are not in
 * this worktree, so the runner is built around two injectables:
 *   - `transpileFn` — the R2 `transpile` (default) or a fake.
 *   - `workerFactory` — produces a `WorkerLike` per run. Production passes a
 *     factory that does `new Worker(bundleUrl, { type:'module' })`; the test
 *     passes a factory backed by `node:worker_threads` (or a same-process fake)
 *     so terminate-on-timeout, abort, ordered capture, throw-containment, and
 *     no-state-bleed are MECHANICALLY proven without a browser.
 * The exported `browserWorkerRunner` is the production-shaped instance; tests
 * build their own via `makeBrowserWorkerRunner({ transpileFn, workerFactory })`.
 */

import type {
    CodeRunner,
    RunRequest,
    RunResult,
    RunError,
    RunNotice,
    LogEntry,
} from '../component/runner';
import { transpile as defaultTranspile } from './transpile';
import type {
    RunMessage,
    ResultMessage,
    WireLog,
    WireNotice,
    WireError,
} from './worker-protocol';

/* -------------------------------------------------------------------------- */
/*  Worker abstraction (the injection seam)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The subset of the DOM `Worker` the runner uses. A real `Worker` satisfies
 * this structurally; the test's `node:worker_threads`-backed fake implements it
 * directly. Keeping it to this surface is what lets the runner be driven without
 * a browser (and keeps the type independent of which `lib` is configured).
 */
export interface WorkerLike {
    postMessage(message: unknown): void;
    /** Hard-kill the execution context — the SEC-20/21/25 kill switch. */
    terminate(): void;
    /** Receives the worker's single `ResultMessage`. */
    onmessage: ((ev: { data: unknown }) => void) | null;
    /** Surfaces a worker-level failure (spawn/parse/uncaught) → `internal`. */
    onerror: ((err: unknown) => void) | null;
}

/** Produces a fresh worker for one run. A fresh worker per run is what gives
 * SEC-36/37 (no global/singleton bleed) for free — there is no pooled, dirty
 * scope to leak across runs. */
export type WorkerFactory = () => WorkerLike;

export interface BrowserRunnerDeps {
    /** R2 transpile (or a fake). Defaults to the real `transpile`. */
    transpileFn?: typeof defaultTranspile;
    /** Required: how to spawn the per-run worker (real `Worker` or a fake). */
    workerFactory: WorkerFactory;
    /** Hard cap used when `RunRequest.timeoutMs` is omitted (SEC-22). */
    defaultTimeoutMs?: number;
}

/** Sane non-infinite default cap when the caller omits `timeoutMs` (SEC-22). */
export const DEFAULT_TIMEOUT_MS = 5_000;

/* -------------------------------------------------------------------------- */
/*  The runner                                                                 */
/* -------------------------------------------------------------------------- */

class BrowserWorkerRunner implements CodeRunner {
    readonly id = 'browser-worker';

    private readonly transpileFn: typeof defaultTranspile;
    private readonly workerFactory: WorkerFactory;
    private readonly defaultTimeoutMs: number;

    /** The worker currently in flight, so `dispose()` can tear it down. */
    private active: WorkerLike | null = null;

    constructor(deps: BrowserRunnerDeps) {
        this.transpileFn = deps.transpileFn ?? defaultTranspile;
        this.workerFactory = deps.workerFactory;
        this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    async run(req: RunRequest): Promise<RunResult> {
        const startedAt = Date.now();
        const since = () => Date.now() - startedAt;

        /* -- already aborted before we start ------------------------------- */
        if (req.signal?.aborted) {
            return errorResult(since(), abortError());
        }

        /* -- 1. transpile (R2) — never throws for snippet syntax errors ---- */
        let js: string;
        try {
            const t = await this.transpileFn(req.code);
            if ('error' in t) {
                // phase:'transpile' already set by R2.
                return { logs: [], durationMs: since(), error: t.error };
            }
            js = t.js;
        } catch (loadErr) {
            // Transpiler failed to LOAD (engine/internal) — still resolve.
            return errorResult(since(), internalError(loadErr, 'transpile'));
        }

        /* -- 2. spawn the worker ------------------------------------------- */
        let worker: WorkerLike;
        try {
            worker = this.workerFactory();
        } catch (spawnErr) {
            return errorResult(since(), internalError(spawnErr, 'runtime'));
        }
        this.active = worker;

        /* -- 3-6. run, race timeout/abort, map the result ------------------ */
        return await this.execute(worker, js, req, startedAt, since);
    }

    private execute(
        worker: WorkerLike,
        js: string,
        req: RunRequest,
        startedAt: number,
        since: () => number,
    ): Promise<RunResult> {
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

        return new Promise<RunResult>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;

            /** Tear down EVERYTHING exactly once, then resolve. The teardown is
             * what makes timeout/abort a hard kill (SEC-20/21/25) and prevents
             * a late worker message from re-resolving (SEC-39 containment). */
            const finish = (result: RunResult): void => {
                if (settled) return;
                settled = true;
                if (timer !== undefined) clearTimeout(timer);
                if (onAbort && req.signal) {
                    req.signal.removeEventListener('abort', onAbort);
                }
                worker.onmessage = null;
                worker.onerror = null;
                // Always terminate: on success this is a clean teardown; on
                // timeout/abort it is the kill switch. Terminating an already
                // finished worker is a no-op.
                try {
                    worker.terminate();
                } catch {
                    /* ignore — best-effort teardown */
                }
                if (this.active === worker) this.active = null;
                resolve(result);
            };

            /* -- 6a. timeout: terminate → reason:'timeout' (SEC-20/24) ----- */
            timer = setTimeout(() => {
                finish(errorResult(since(), timeoutError(timeoutMs)));
            }, timeoutMs);

            /* -- 6b. abort: terminate → reason:'abort' (SEC-25) ------------ */
            if (req.signal) {
                onAbort = () => finish(errorResult(since(), abortError()));
                req.signal.addEventListener('abort', onAbort, { once: true });
            }

            /* -- worker result: snippet success or throw (SEC-39a) --------- */
            worker.onmessage = (ev: { data: unknown }) => {
                const data = ev.data as ResultMessage | undefined;
                if (!data || data.type !== 'result') {
                    // Malformed message from the worker = engine failure.
                    finish(errorResult(since(), internalError(
                        new Error('worker returned a malformed result message'),
                        'runtime',
                    )));
                    return;
                }
                finish(mapResult(data, since()));
            };

            /* -- worker-level error: spawn/parse/uncaught → internal ------- */
            worker.onerror = (err: unknown) => {
                finish(errorResult(since(), internalError(err, 'runtime')));
            };

            /* -- kick off the run ------------------------------------------ */
            const msg: RunMessage = {
                type: 'run',
                js,
                extraScopeNames: req.scope ? Object.keys(req.scope) : [],
            };
            try {
                worker.postMessage(msg);
            } catch (postErr) {
                finish(errorResult(since(), internalError(postErr, 'runtime')));
            }
        });
    }

    dispose(): void {
        if (this.active) {
            this.active.onmessage = null;
            this.active.onerror = null;
            try {
                this.active.terminate();
            } catch {
                /* ignore */
            }
            this.active = null;
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Result mapping (worker wire → RunResult)                                   */
/* -------------------------------------------------------------------------- */

function mapResult(msg: ResultMessage, durationMs: number): RunResult {
    const logs = msg.logs.map(toLogEntry);
    const notices = msg.notices.map(toNotice);
    if (msg.error) {
        // The snippet itself threw/rejected → reason:'throw' (SEC-39a).
        return {
            logs,
            durationMs,
            notices: notices.length ? notices : undefined,
            error: throwError(msg.error),
        };
    }
    return {
        logs,
        durationMs,
        value: msg.value,
        notices: notices.length ? notices : undefined,
    };
}

function toLogEntry(l: WireLog): LogEntry {
    return { level: l.level, args: l.args, at: l.at };
}

function toNotice(n: WireNotice): RunNotice {
    return { kind: n.kind, surface: n.surface, message: n.message };
}

/* -------------------------------------------------------------------------- */
/*  RunError constructors — one per `reason` so the UI/tests can discriminate  */
/* -------------------------------------------------------------------------- */

function throwError(e: WireError): RunError {
    return {
        name: e.name || 'Error',
        message: e.message,
        stack: e.stack,
        phase: 'runtime',
        reason: 'throw',
    };
}

function timeoutError(timeoutMs: number): RunError {
    return {
        name: 'Timeout',
        message: `Snippet exceeded the ${timeoutMs}ms time limit and was terminated.`,
        phase: 'runtime',
        reason: 'timeout',
    };
}

function abortError(): RunError {
    return {
        name: 'AbortError',
        message: 'Run was cancelled.',
        phase: 'runtime',
        reason: 'abort',
    };
}

function internalError(err: unknown, phase: 'transpile' | 'runtime'): RunError {
    const base = err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { name: 'InternalError', message: String(err) };
    return { ...base, phase, reason: 'internal' };
}

function errorResult(durationMs: number, error: RunError): RunResult {
    return { logs: [], durationMs, error };
}

/* -------------------------------------------------------------------------- */
/*  Public factory + production instance                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build a browser-worker runner with injected deps. Tests use this with a fake
 * `workerFactory` and (optionally) a fake `transpileFn`.
 */
export function makeBrowserWorkerRunner(deps: BrowserRunnerDeps): CodeRunner {
    return new BrowserWorkerRunner(deps);
}

/**
 * Production instance (id `'browser-worker'`).
 *
 * The default `workerFactory` is intentionally a STUB that throws: the real
 * bundled worker URL (the B1 `stitch-browser` build wired into worker-entry.ts)
 * is produced by the docs app's bundler, which is not present in this worktree.
 * The app constructs the live runner via `makeBrowserWorkerRunner({ workerFactory:
 * () => wrapDomWorker(new Worker(bundleUrl, { type:'module' })) })`. Until then,
 * invoking this instance resolves a clean `reason:'internal'` RunResult (it does
 * NOT throw at module load) — the contract's always-resolve guarantee (SEC-39d).
 */
export const browserWorkerRunner: CodeRunner = makeBrowserWorkerRunner({
    workerFactory: () => {
        throw new Error(
            'browserWorkerRunner: no Worker bundle wired. Construct the live ' +
                'runner with makeBrowserWorkerRunner({ workerFactory }) in the docs app, ' +
                'pointing at the bundled stitch-browser worker URL (B1).',
        );
    },
});
