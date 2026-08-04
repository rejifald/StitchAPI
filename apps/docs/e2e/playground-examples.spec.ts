import { PLAYGROUND_EXAMPLES } from '../app/(home)/playground/playground-examples';

import { expect, test } from '@playwright/test';
import { PLAYGROUND_SURFACE_NAMES } from '@stitchapi/sandbox/runtime/playground-surface';

/**
 * Playground preset regression guard — BROWSER tier.
 *
 * The presets are the first thing a visitor runs, so "the shipped example still
 * executes" is a contract. This drives the real page: click each example tab,
 * press Run, and fail if the output panel shows an error — the full production
 * path (CodeMirror seed → dispatchRunner → transpile → `/sandbox/sandbox-worker.mjs`
 * → sandbox-sim), which is exactly what a visitor gets.
 *
 * The second test asserts the whole `PLAYGROUND_SURFACE_NAMES` allow-list is
 * bound in the snippet scope. Running the presets only covers the names those
 * three snippets touch, and the failure mode is a re-export that silently
 * resolves to nothing (see docs/sandbox/runtime/playground-surface.ts for why
 * esbuild can't catch it) — so any name in the surface is at risk, not just the
 * ones an example happens to use.
 *
 * The node tier gets the same two checks against ITS bundle in
 * docs/sandbox/tests/playground-examples.test.ts. The two Workers are built from
 * different entries (worker-main.ts → stitch-browser.ts vs worker-main.node.ts),
 * so neither run substitutes for the other.
 */

/** The Complete tour retries a deliberately flaky route — give runs headroom. */
const RUN_TIMEOUT_MS = 25_000;

test.describe('playground examples', () => {
    for (const example of PLAYGROUND_EXAMPLES) {
        test(`the '${example.id}' preset runs without an error`, async ({
            page,
        }) => {
            await page.goto('/playground');

            // Switching tabs remounts <StitchPlayground> with this preset's code.
            await page.getByRole('tab', { name: example.label }).click();
            await page
                .getByRole('button', { name: 'Run', exact: true })
                .click();

            const stopButton = page.getByRole('button', { name: 'Stop' });
            const errorBlock = page.locator('.stitch-playground__error');
            // PlaygroundClient renders the log stream through <ConsoleEditor>, so
            // the whole stream is one block — present iff the run logged anything.
            const logs = page.locator('.stitch-playground__logs-editor');

            // Wait for the run to SETTLE before asserting anything, so a green
            // result can't come from checking before the run started. "Not
            // showing Stop" alone is true in the frame between the click and
            // React re-rendering, hence the second half: settled means the run
            // also left something behind — logs, or the error block (which only
            // renders from the final reconciled result).
            await expect
                .poll(
                    async () => {
                        if ((await stopButton.count()) > 0) return false;
                        return (
                            (await logs.count()) > 0 ||
                            (await errorBlock.count()) > 0
                        );
                    },
                    {
                        timeout: RUN_TIMEOUT_MS,
                        message: `preset '${example.id}' never finished`,
                    },
                )
                .toBe(true);

            // Assert on the error TEXT, not its absence, so a failure says why
            // the preset broke ("ReferenceError: bearer is not defined").
            const errorText =
                (await errorBlock.count()) > 0
                    ? await errorBlock.innerText()
                    : null;
            expect(
                errorText,
                `preset '${example.id}' errored in the playground`,
            ).toBeNull();
            expect(
                await logs.count(),
                `preset '${example.id}' produced no console output`,
            ).toBeGreaterThan(0);
        });
    }

    test('every surface name is bound in the snippet scope', async ({
        page,
    }) => {
        await page.goto('/playground');

        // Drive the real worker bundle directly — the scope is bound as function
        // parameters inside it, so `typeof <name>` is the only way to see what a
        // snippet sees. The worker does not transpile (the main thread does), so
        // the probe is already-runnable JS.
        const surface = await page.evaluate(
            async (names: readonly string[]) => {
                const js = `return { ${names
                    .map((name) => `${name}: typeof ${name}`)
                    .join(', ')} };`;
                const worker = new Worker('/sandbox/sandbox-worker.mjs', {
                    type: 'module',
                });
                try {
                    return await new Promise<Record<string, string>>(
                        (resolve, reject) => {
                            const timer = setTimeout(
                                () =>
                                    reject(new Error('worker probe timed out')),
                                15_000,
                            );
                            worker.onmessage = (ev: MessageEvent) => {
                                const d = ev.data as {
                                    type: string;
                                    value?: unknown;
                                    error?: { message: string };
                                };
                                if (d.type !== 'result') return; // progress event
                                clearTimeout(timer);
                                if (d.error)
                                    reject(
                                        new Error(
                                            `probe threw: ${d.error.message}`,
                                        ),
                                    );
                                else
                                    resolve(
                                        (d.value ?? {}) as Record<
                                            string,
                                            string
                                        >,
                                    );
                            };
                            worker.onerror = (e: ErrorEvent) =>
                                reject(new Error(e.message || 'worker error'));
                            worker.postMessage({
                                type: 'run',
                                js,
                                extraScopeNames: [],
                            });
                        },
                    );
                } finally {
                    worker.terminate();
                }
            },
            PLAYGROUND_SURFACE_NAMES as readonly string[],
        );

        const missing = PLAYGROUND_SURFACE_NAMES.filter(
            (name) => surface[name] !== 'function',
        ).map((name) => `${name} (${surface[name] ?? 'undefined'})`);

        expect(
            missing,
            'names re-exported by stitch-browser.ts that resolved to nothing — ' +
                'the source module no longer exports them',
        ).toEqual([]);
    });
});
