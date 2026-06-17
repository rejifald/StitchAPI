import { expect, test } from '@playwright/test';

/**
 * SEC-36 / SEC-37 (SANDBOX-SECURITY-CHECKLIST §6 "No state bleed") — two consecutive
 * runs share no state: a value set on `globalThis` in run 1 is absent in run 2 (SEC-36),
 * and module/singleton state inside the injected `stitch` build (e.g. an in-memory
 * `memoryStore`) does not persist across runs (SEC-37). In the browser tier the runner
 * achieves this by spawning **a fresh Worker per run**.
 *
 * ─── Driving level: option (b), aligned to how the runner ACTUALLY isolates ──────
 * The isolation guarantee is "a fresh Worker per run" — literally what the production
 * runner's factory does: `makeBrowserWorkerRunner({ workerFactory: () => new Worker(
 * '/sandbox/sandbox-worker.mjs', { type:'module' }) })` calls the factory on every
 * `run()`. A trivial "two different workers don't share state" test would be vacuous
 * (of course they don't). So each test proves it the way the runner enforces it AND
 * proves the test is non-vacuous with a POSITIVE CONTROL:
 *
 *   - Control (same worker, reused): run 1 stashes state, run 2 on the SAME worker
 *     reads it back → PRESENT. This shows the worker genuinely carries scope/module
 *     state across runs when reused — so the absence below is meaningful, not trivial.
 *   - Proof (fresh worker per run, the runner's lifecycle): run 1 stashes, run 2 on a
 *     FRESH `new Worker(WORKER_URL)` reads → ABSENT. This is exactly the per-run
 *     lifecycle `makeBrowserWorkerRunner`'s `workerFactory` produces.
 *
 * Driving the real production worker bundle via its `{type:'run', js}` protocol keeps
 * this UI-independent and faithful to the shipped artifact (mirrors sandbox-trace.spec).
 *
 * Reaching the worker global from a snippet: `worker-entry.ts` shadows `globalThis`/
 * `self`/`window` to `undefined` PARAMETERS in the snippet scope, so the indirect-eval
 * idiom `(0, eval)('this')` is used to obtain the true worker global (indirect eval runs
 * in the global lexical environment, where `this` is the global object; the worker CSP
 * grants `'unsafe-eval'`). The shadowed identifiers stay `undefined` — proving the
 * snippet can't reach the global by name — while the test still anchors its bleed probe
 * to the real global to demonstrate the fresh-worker reset.
 */

const WORKER_URL = '/sandbox/sandbox-worker.mjs';

test.describe('playground sandbox state isolation (SEC-36/37)', () => {
    test('no globalThis bleed across runs — fresh worker per run resets it (SEC-36)', async ({
        page,
    }) => {
        await page.goto('/playground');

        const outcome = await page.evaluate(async (workerUrl) => {
            // Run one snippet against a worker, resolve its RunResult `value`.
            const runOn = (worker: Worker, js: string): Promise<unknown> =>
                new Promise((resolve, reject) => {
                    const t = setTimeout(
                        () => reject(new Error('worker run timed out')),
                        15000,
                    );
                    worker.onmessage = (ev: MessageEvent) => {
                        const d = ev.data as {
                            type: string;
                            value?: unknown;
                            error?: { message: string };
                        };
                        if (d.type === 'result') {
                            clearTimeout(t);
                            if (d.error)
                                reject(
                                    new Error(
                                        'snippet error: ' + d.error.message,
                                    ),
                                );
                            else resolve(d.value);
                        }
                        // progress messages are ignored
                    };
                    worker.onerror = (e: ErrorEvent) =>
                        reject(new Error(e.message || 'worker error'));
                    worker.postMessage({
                        type: 'run',
                        js,
                        extraScopeNames: [],
                    });
                });

            // First confirm the snippet truly cannot reach the global BY NAME
            // (globalThis/self/window are shadowed to undefined in scope) — the
            // precondition that makes the bleed test about the worker boundary.
            const w0 = new Worker(workerUrl, { type: 'module' });
            const byNameReach = await runOn(
                w0,
                `return [typeof globalThis, typeof self, typeof window].join(',');`,
            );
            w0.terminate();

            const STASH = `(0, eval)('this').__bleed = 'x'; return 'set';`;
            const READ = `var g = (0, eval)('this'); return (g && g.__bleed) ? 'BLED' : 'clean';`;

            // CONTROL — same worker reused: run 2 must SEE run 1's globalThis write.
            const shared = new Worker(workerUrl, { type: 'module' });
            await runOn(shared, STASH);
            const controlRead = await runOn(shared, READ);
            shared.terminate();

            // PROOF — fresh worker per run (the runner's lifecycle): run 2 is clean.
            const w1 = new Worker(workerUrl, { type: 'module' });
            await runOn(w1, STASH);
            w1.terminate(); // the runner terminates the worker after each run
            const w2 = new Worker(workerUrl, { type: 'module' });
            const freshRead = await runOn(w2, READ);
            w2.terminate();

            return { byNameReach, controlRead, freshRead };
        }, WORKER_URL);

        // Precondition: the snippet cannot name the global (SEC-30 shadowing holds).
        expect(
            outcome.byNameReach,
            'globalThis/self/window are undefined by name in snippet scope',
        ).toBe('undefined,undefined,undefined');
        // The control proves the vector is real: a reused worker carries the global.
        expect(
            outcome.controlRead,
            'control: a reused worker DOES carry a globalThis write (test is non-vacuous)',
        ).toBe('BLED');
        // SEC-36: a fresh worker per run starts with a clean globalThis.
        expect(
            outcome.freshRead,
            'SEC-36: no globalThis bleed — fresh worker per run resets globalThis',
        ).toBe('clean');
    });

    test('no module/singleton (memoryStore) bleed across runs — fresh scope per run (SEC-37)', async ({
        page,
    }) => {
        await page.goto('/playground');

        const outcome = await page.evaluate(async (workerUrl) => {
            const runOn = (worker: Worker, js: string): Promise<unknown> =>
                new Promise((resolve, reject) => {
                    const t = setTimeout(
                        () => reject(new Error('worker run timed out')),
                        15000,
                    );
                    worker.onmessage = (ev: MessageEvent) => {
                        const d = ev.data as {
                            type: string;
                            value?: unknown;
                            error?: { message: string };
                        };
                        if (d.type === 'result') {
                            clearTimeout(t);
                            if (d.error)
                                reject(
                                    new Error(
                                        'snippet error: ' + d.error.message,
                                    ),
                                );
                            else resolve(d.value);
                        }
                    };
                    worker.onerror = (e: ErrorEvent) =>
                        reject(new Error(e.message || 'worker error'));
                    worker.postMessage({
                        type: 'run',
                        js,
                        extraScopeNames: [],
                    });
                });

            // Use the injected `memoryStore` surface (SANDBOX §6 SEC-37 names it):
            // pin ONE store instance to the worker module scope so a REUSED worker
            // carries it but a FRESH worker (fresh module evaluation) does not. The
            // store is the singleton; the worker boundary is what resets it.
            const STASH = `
                var g = (0, eval)('this');
                g.__jar = g.__jar || memoryStore();
                await g.__jar.set('session', 'abc123');
                return await g.__jar.get('session');
            `;
            const READ = `
                var g = (0, eval)('this');
                if (!g.__jar) return 'EMPTY';            // fresh worker → no singleton
                var v = await g.__jar.get('session');
                return v === undefined ? 'EMPTY' : v;     // reused worker → carries value
            `;

            // CONTROL — same worker reused: the singleton store keeps the session.
            const shared = new Worker(workerUrl, { type: 'module' });
            const stashed = await runOn(shared, STASH);
            const controlRead = await runOn(shared, READ);
            shared.terminate();

            // PROOF — fresh worker per run: the singleton (and its data) is gone.
            const w1 = new Worker(workerUrl, { type: 'module' });
            await runOn(w1, STASH);
            w1.terminate();
            const w2 = new Worker(workerUrl, { type: 'module' });
            const freshRead = await runOn(w2, READ);
            w2.terminate();

            return { stashed, controlRead, freshRead };
        }, WORKER_URL);

        // Sanity: run 1 actually wrote+read its own session value.
        expect(
            outcome.stashed,
            'run 1 wrote and read its memoryStore session',
        ).toBe('abc123');
        // Control proves the vector is real: a reused worker's singleton store persists.
        expect(
            outcome.controlRead,
            'control: a reused worker keeps the memoryStore singleton (non-vacuous)',
        ).toBe('abc123');
        // SEC-37: a fresh worker per run starts with an empty store (no singleton bleed).
        expect(
            outcome.freshRead,
            'SEC-37: no memoryStore/singleton bleed — fresh scope per run',
        ).toBe('EMPTY');
    });
});
