/**
 * R1 — Worker body. The code that runs INSIDE the dedicated Web Worker.
 *
 * ─── Why this file is structured the way it is (the lib clash) ──────────────
 * A browser Worker uses the `WebWorker` lib (`self`, `postMessage`, `onmessage`
 * as a worker-global), whereas `browser-runner.ts` runs on the main thread and
 * uses the `DOM` lib (`Worker`, `window`). Those two libs DISAGREE on the type
 * of `self`/`postMessage`, so a single tsconfig that `include`s both files with
 * `lib: [..., "DOM"]` cannot also pull in `WebWorker` cleanly.
 *
 * Resolution (chosen): keep ALL of the worker logic in a plain, lib-agnostic
 * function — `runSnippetInWorker(env, msg)` — that takes its host capabilities
 * as an injected `WorkerEnv` and returns a structured `ResultMessage`. It never
 * names `self` or `postMessage`. The ONE place that must touch the worker
 * global, `installWorkerEntry`, takes a tiny typed `WorkerGlobal` handle
 * (declared locally here, NOT via the WebWorker lib) and wires the message pump.
 *
 * Net effect:
 *   - The no-install `tsc` (DOM lib) stays green: this file pulls in neither the
 *     `WebWorker` lib nor any browser-only global.
 *   - Production builds the real worker bundle by calling `installWorkerEntry`
 *     with the actual `self` (a one-line shim the bundler emits) and a real
 *     `WorkerEnv` made from the B1 stitch build + S5 fetch shim + B1 process/
 *     crypto shims.
 *   - The TEST drives `runSnippetInWorker` directly (and through a fake worker)
 *     with injected fakes — no DOM, no Worker, no installed deps required.
 *
 * The execution model (SANDBOX §5 step 2–4, SEC-30/34/35/36):
 *   - The snippet is wrapped in an async IIFE so top-level `await` works and the
 *     final expression value is captured.
 *   - It runs via `new Function(...names, body)` with ONLY the allow-listed
 *     scope names bound as parameters. Host globals (`window`, `document`,
 *     `globalThis.fetch`, …) are NOT passed in; the worker bundle itself must be
 *     built so those aren't ambiently reachable (the runner asserts this).
 *   - `console.*` is captured in order; it is NEVER forwarded to the host.
 *   - A snippet throw/reject is reported as `error` on the result; the main
 *     thread classifies timeout/abort/internal — see worker-protocol.ts.
 */

import type {
    RunMessage,
    ResultMessage,
    ProgressMessage,
    WireLog,
    WireNotice,
} from './worker-protocol';
import type { LogLevel, LogEntry, RunEvent } from '../component/runner';

/* -------------------------------------------------------------------------- */
/*  Injected worker environment (the allow-listed scope, SEC-34)              */
/* -------------------------------------------------------------------------- */

/**
 * Everything the worker body is allowed to expose to a snippet. In production
 * these are the bundled B1 `stitch-browser` exports, the S5 `fetch` shim, and
 * the B1 `process` / Web-Crypto shims. In tests they are fakes. NOTHING here is
 * the host's real network, fs, env, or `window` (SEC-30/31/32).
 */
export interface WorkerEnv {
    /**
     * The browser `stitch` build exports (B1 `stitch-browser.ts`), bound into
     * the snippet scope as `stitch` plus its named exports under a single
     * namespace object. Provided as a record so the worker can spread the names
     * the snippet expects (`stitch`, `bearer`, `keychain`, …).
     */
    stitchBuild: Record<string, unknown>;
    /**
     * The S5 simulator fetch shim — the snippet's ONLY `fetch`. No real socket
     * is reachable (SEC-01..04).
     */
    fetch: (input: unknown, init?: unknown) => Promise<unknown>;
    /**
     * The B1 `process` shim: `{ env:{}, platform:'browser', versions:{} }`.
     * Bound as the snippet's `process` so core's `process.env.*` reads resolve
     * to safe defaults. MUST NOT carry `STITCH_TRACE_CONSOLE` or a `stderr`
     * (B1 blocker #1/#4).
     */
    process: { env: Record<string, string | undefined>; platform: string; versions: Record<string, string> };
    /**
     * Web Crypto (`crypto.randomUUID` / `getRandomValues`) — backs the B1
     * `node:crypto` alias and the engine write hot path (B1 blocker #2). In a
     * real Worker this is the platform `crypto`; in tests, a fake.
     */
    crypto: unknown;
    /**
     * Drains the B1 shim-notice buffer (`shims/notices.ts#drainNotices`). Called
     * once after the run; result → `RunResult.notices` (SANDBOX §5.7, SEC-33).
     */
    drainNotices: () => WireNotice[];
    /**
     * OPTIONAL progressive observation seam (A1, Wave 4 — additive). When the
     * runner wants incremental events, it hands the worker body a `ProgressSink`
     * and the body forwards it here so env-side producers (the S5 sim `fetch`'s
     * stream chunks, completed `stitch()` traces, and shim notices as they fire)
     * can emit `RunEvent`s IN REAL ORDER. Returns a teardown the body calls when
     * the run settles. PURE observation: it must NOT change anything the env
     * later reports via `drainNotices()` / the snippet's resolved value, so a run
     * with no sink (or an env that ignores this hook) is byte-for-byte unchanged.
     *
     * `console.*` `log` events are emitted by the worker body itself (it owns the
     * capturing console), so an env need only wire chunk/trace/notice here.
     */
    bindProgress?: (sink: ProgressSink) => (() => void) | void;
}

/**
 * The progress callback an env may invoke to surface chunk/trace/notice events
 * during a run (A1). The worker body owns it, fans `log` events in itself, and
 * relays every event to the main thread as a `progress` message. Guarded so a
 * producer throwing inside `emit` can never derail the snippet (best-effort).
 */
export type ProgressSink = (event: RunEvent) => void;

/* -------------------------------------------------------------------------- */
/*  Console capture (SEC-35: ordered, never leaked to host)                   */
/* -------------------------------------------------------------------------- */

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * Build a capturing `console` object plus the log buffer it fills. The captured
 * console is what the snippet sees — it writes into `logs`, never to the host
 * console (which, inside a real Worker, would surface in the page devtools).
 */
function makeCapturingConsole(
    startedAt: () => number,
    onLog?: (entry: LogEntry) => void,
): {
    console: Record<LogLevel, (...args: unknown[]) => void> & Record<string, unknown>;
    logs: WireLog[];
} {
    const logs: WireLog[] = [];
    const sink = (level: LogLevel) => (...args: unknown[]): void => {
        const entry: WireLog = { level, args: args.map(safeClone), at: startedAt() };
        logs.push(entry);
        // Progressive observation (A1): forward this line as a `log` event the
        // instant it's captured, BEFORE the run settles. The buffered `logs`
        // array is still the source of truth for the final result — this is a
        // pure side-emit. A throwing sink must not drop the captured line.
        if (onLog) {
            try {
                onLog({ level: entry.level, args: entry.args, at: entry.at });
            } catch {
                /* swallow — host-side observation must never break capture */
            }
        }
    };
    const console = {} as Record<LogLevel, (...args: unknown[]) => void> &
        Record<string, unknown>;
    for (const level of LEVELS) {
        console[level] = sink(level);
    }
    // `console.trace`/`table`/`dir`/`group*` etc. map onto 'log' so a snippet
    // calling them doesn't blow up and doesn't reach the host console.
    const aliasToLog = ['trace', 'table', 'dir', 'group', 'groupEnd', 'groupCollapsed', 'count', 'assert'];
    for (const name of aliasToLog) {
        console[name] = sink('log');
    }
    return { console, logs };
}

/**
 * Best-effort make a console arg / return value structured-cloneable so it can
 * cross `postMessage`. Primitives pass through; objects are JSON round-tripped;
 * anything that can't (functions, cyclic, symbols) becomes its `String()` form.
 * This keeps the worker from crashing on an un-cloneable log arg (SEC-35/39).
 */
export function safeClone(value: unknown): unknown {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') {
        return value;
    }
    if (t === 'bigint') return `${value as bigint}n`;
    if (t === 'function' || t === 'symbol') return String(value);
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        try {
            return String(value);
        } catch {
            return '[unserialisable]';
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Snippet execution (SANDBOX §5 step 3: async IIFE + top-level await)       */
/* -------------------------------------------------------------------------- */

/**
 * Execute one transpiled snippet against the injected `env`. Resolves a fully
 * structured `ResultMessage`:
 *   - `logs`    — captured console, in order, never leaked (SEC-35).
 *   - `notices` — drained shim notices (SEC-33).
 *   - `value`   — the final awaited value if cloneable.
 *   - `error`   — populated iff the SNIPPET threw/rejected (SEC-39a). Timeout /
 *                 abort / engine failures are NOT decided here.
 *
 * NEVER throws: a snippet throw is caught and reported as `error`. An internal
 * failure building the function still resolves with `error` (the main thread
 * maps a missing/abnormal result to `reason:'internal'`).
 */
export async function runSnippetInWorker(
    env: WorkerEnv,
    msg: RunMessage,
    onProgress?: ProgressSink,
): Promise<ResultMessage> {
    const t0 = Date.now();

    // A1: wrap the host sink so a throwing onEvent/relay can never derail the
    // snippet, and so a `log` emitted by the console capture and a chunk/trace/
    // notice emitted by the env both funnel through ONE ordered relay.
    const emit: ProgressSink | undefined = onProgress
        ? (event: RunEvent): void => {
              try {
                  onProgress(event);
              } catch {
                  /* swallow — observation must never break the run */
              }
          }
        : undefined;

    // Let the env wire its chunk/trace/notice producers to the progress relay
    // (optional + best-effort). Returns a teardown we run once the snippet ends.
    let unbindProgress: (() => void) | void = undefined;
    if (emit && env.bindProgress) {
        try {
            unbindProgress = env.bindProgress(emit);
        } catch {
            unbindProgress = undefined;
        }
    }

    const { console, logs } = makeCapturingConsole(
        () => Date.now() - t0,
        emit ? (entry: LogEntry) => emit({ type: 'log', entry }) : undefined,
    );

    // Build the allow-listed scope (SEC-34). These are the ONLY names a snippet
    // can reach by identifier; everything else is whatever the worker bundle's
    // own (locked-down) global scope provides — never the host's.
    const scope: Record<string, unknown> = {
        // The whole stitch build, name by name (stitch, bearer, keychain, …).
        ...env.stitchBuild,
        // Hard overrides — these win even if a same-named export existed.
        console,
        fetch: env.fetch,
        process: env.process,
        crypto: env.crypto,
        // Deny ambient authority by shadowing the usual escape hatches with
        // `undefined` parameters (SEC-30/31). A snippet referencing them gets
        // `undefined`, not the host object.
        window: undefined,
        self: undefined,
        globalThis: undefined,
        document: undefined,
        importScripts: undefined,
        XMLHttpRequest: undefined,
        WebSocket: undefined,
        EventSource: undefined,
        require: undefined,
    };

    // `extraScopeNames` lets the runner request additional snippet-visible names
    // that the worker already holds in `env.stitchBuild`; values are never sent
    // over the wire (worker-protocol.ts). Unknown names resolve to `undefined`.
    for (const name of msg.extraScopeNames) {
        if (!(name in scope)) scope[name] = env.stitchBuild[name];
    }

    const names = Object.keys(scope);
    const values = names.map((n) => scope[n]);

    // Async IIFE wrapper: top-level await works, and the final expression's
    // value is returned. We use AsyncFunction (via constructor) so we don't need
    // `eval`; the body is the transpiled snippet.
    const AsyncFunction = Object.getPrototypeOf(async function () {})
        .constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

    let runner: (...a: unknown[]) => Promise<unknown>;
    try {
        runner = new AsyncFunction(
            ...names,
            // `"use strict"` so an undeclared assignment throws instead of
            // leaking onto the function's caller scope.
            `"use strict";\nreturn (async () => {\n${msg.js}\n})();`,
        );
    } catch (buildErr) {
        // A failure to even construct the function is an engine/internal-ish
        // problem, but it is reported as a snippet error here; the main thread
        // still gets a renderable result. (Most commonly this never fires
        // because transpile already validated syntax.)
        teardownProgress(unbindProgress);
        return {
            type: 'result',
            logs,
            notices: drainSafely(env),
            error: toWireError(buildErr),
        };
    }

    try {
        const value = await runner(...values);
        teardownProgress(unbindProgress);
        return {
            type: 'result',
            logs,
            notices: drainSafely(env),
            value: safeClone(value),
        };
    } catch (runErr) {
        teardownProgress(unbindProgress);
        return {
            type: 'result',
            logs,
            notices: drainSafely(env),
            error: toWireError(runErr),
        };
    }
}

/** Run the env's progress teardown once, best-effort (A1). */
function teardownProgress(unbind: (() => void) | void): void {
    if (typeof unbind === 'function') {
        try {
            unbind();
        } catch {
            /* ignore — teardown is best-effort */
        }
    }
}

function drainSafely(env: WorkerEnv): WireNotice[] {
    try {
        return env.drainNotices();
    } catch {
        return [];
    }
}

function toWireError(err: unknown): { name: string; message: string; stack?: string } {
    if (err instanceof Error) {
        return { name: err.name || 'Error', message: err.message, stack: err.stack };
    }
    return { name: 'Error', message: String(err) };
}

/* -------------------------------------------------------------------------- */
/*  Worker-global wiring (the only WebWorker-touching surface)                */
/* -------------------------------------------------------------------------- */

/**
 * Minimal local view of the worker global. Declared HERE instead of pulling in
 * the `WebWorker` lib so the no-install `tsc` (DOM lib) stays green — see the
 * file header. The real worker bundle passes its actual `self`.
 */
export interface WorkerGlobal {
    onmessage: ((ev: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
}

/**
 * Wire the worker message pump: on the single `run` message, execute and post
 * back the structured result. Production calls this once with the real `self`
 * and a real `WorkerEnv`; the fake-worker test harness calls `runSnippetInWorker`
 * directly (or installs this onto a fake global).
 */
export function installWorkerEntry(global: WorkerGlobal, env: WorkerEnv): void {
    global.onmessage = (ev: { data: unknown }): void => {
        const data = ev.data as RunMessage | undefined;
        if (!data || data.type !== 'run') return;
        // A1: relay every progressive event back to the main thread AS IT HAPPENS
        // as a `progress` message (structured-cloneable). This is the wire half of
        // the §8 "forward chunks via postMessage as they arrive" amendment. Posting
        // is best-effort and never throws into the producer; the terminal `result`
        // message is still posted exactly once below, unchanged.
        const onProgress: ProgressSink = (event: RunEvent): void => {
            try {
                const progress: ProgressMessage = { type: 'progress', event };
                global.postMessage(progress);
            } catch {
                /* swallow — a failed progress post must not break the run */
            }
        };
        // Resolve and post; runSnippetInWorker never rejects, but guard anyway
        // so a defect can't leave the main thread hanging (it has its own
        // timeout, which would then fire as `internal`/`timeout`).
        runSnippetInWorker(env, data, onProgress).then(
            (result) => global.postMessage(result),
            (fatal) => {
                const result: ResultMessage = {
                    type: 'result',
                    logs: [],
                    notices: [],
                    error: toWireError(fatal),
                };
                global.postMessage(result);
            },
        );
    };
}
