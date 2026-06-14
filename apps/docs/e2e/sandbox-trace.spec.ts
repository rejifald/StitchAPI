import { expect, test } from '@playwright/test';

/**
 * A2 end-to-end — the REAL worker bundle produces a stitch trace from a REAL run
 * (RELEASE.md → Go/no-go gate #3: "the Mermaid DAG renders from a real run's
 * trace"). This drives the actual `/sandbox/sandbox-worker.mjs` (worker-main →
 * trace-collector → stitch-browser → sandbox-sim) in a real browser, bypassing
 * the playground chrome so it proves the data pipeline, not the UI.
 */

test.describe('playground sandbox trace', () => {
    test('a real stitch run yields a trace entry (progress + final result)', async ({
        page,
    }) => {
        await page.goto('/playground');

        const outcome = await page.evaluate(async () => {
            // Run a plain-JS snippet (the worker does not transpile) that makes a
            // real stitch call against the in-Worker sandbox simulator.
            const js =
                "const r = await stitch('https://demo.stitchapi.dev/users/2')(); return r;";
            const worker = new Worker('/sandbox/sandbox-worker.mjs', {
                type: 'module',
            });
            const progressTraceIds: string[] = [];
            try {
                return await new Promise<{
                    finalTrace: unknown;
                    sawProgressTrace: boolean;
                }>((resolve, reject) => {
                    const timer = setTimeout(
                        () => reject(new Error('worker run timed out')),
                        15000,
                    );
                    worker.onmessage = (ev: MessageEvent) => {
                        const d = ev.data as {
                            type: string;
                            event?: { type: string; entry?: { id: string } };
                            trace?: unknown;
                        };
                        if (
                            d.type === 'progress' &&
                            d.event?.type === 'trace'
                        ) {
                            progressTraceIds.push(d.event.entry?.id ?? '');
                            return;
                        }
                        if (d.type === 'result') {
                            clearTimeout(timer);
                            resolve({
                                finalTrace: d.trace,
                                sawProgressTrace: progressTraceIds.length > 0,
                            });
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
            } finally {
                worker.terminate();
            }
        });

        // The progressive trace event fired during the run (incremental DAG).
        expect(
            outcome.sawProgressTrace,
            'a {type:"trace"} progress event should fire during the run',
        ).toBe(true);

        // The final result carries the structured trace → RunResult.trace → DAG.
        const trace = outcome.finalTrace as
            | Array<{
                  id: string;
                  request: { method: string; url: string };
                  response?: { status: number; ok: boolean };
              }>
            | undefined;
        expect(
            Array.isArray(trace) && trace.length >= 1,
            'trace populated',
        ).toBe(true);
        const entry = trace![0];
        expect(entry.request.method).toBe('GET');
        expect(entry.request.url).toContain('users/2');
        // A response (or error) was recorded — the call actually completed.
        expect(
            entry.response !== undefined || 'error' in entry,
            'entry has a response or error outcome',
        ).toBe(true);
    });
});
