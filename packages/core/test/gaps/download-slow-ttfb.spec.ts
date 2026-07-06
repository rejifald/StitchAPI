// Pins: a slow TIME-TO-FIRST-BYTE (the server accepts the request, then delays the status line +
// headers) rides the SAME engine `timeout` as everything else — the per-attempt timeout wraps the
// whole transport, TTFB included (engine.ts:681). So:
//   (a) TTFB > timeout → the call REJECTS (the timeout fires before any response arrives);
//   (b) TTFB < timeout → the call RESOLVES (a slow start is tolerated, not a fault).
// There is no separate "connect"/"first-byte" timeout — `TimeoutOptions` is `{ total, perAttempt }`,
// both wall-clock. This pins that a slow start is only fatal once it eats the wall-clock budget, and
// needs no `src/` change.
//
// EMPIRICAL FINDING (Node 24 undici): case (a) rejects with the engine's timeout/abort error
// (asserted loosely below); case (b) resolves with the full body once the delayed headers arrive.
//
// Real-timer, LOOSE bounds (a socket test): delays and timeouts are milliseconds apart but chosen
// with wide margins so scheduler jitter can't flip the outcome. `ttfbDelayMs` holds the socket open
// during the wait; teardown force-destroys any lingering socket (mock-server tracks live sockets),
// so the suite exits.
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

// (a) A TTFB delay LONGER than the timeout: the timeout fires before any byte arrives → reject.
test('a slow TTFB longer than the timeout rejects (TTFB rides the same timeout)', async () => {
    server.route('GET', '/slow-headers', {
        statuses: [200],
        rawBody: 'a complete body that the client never gets to see',
        ttfbDelayMs: 400, // headers held for 400ms…
    });

    const getSlow = download({
        baseUrl: server.url,
        path: '/slow-headers',
        timeout: 150, // …but the budget is only 150ms → the timeout wins
        retry: { attempts: 1 },
    });

    const started = Date.now();
    await expect(getSlow()).rejects.toThrow(/timeout|timed out|abort|aborted/i);
    expect(Date.now() - started).toBeLessThan(5000); // never hangs
});

// (b) A TTFB delay SHORTER than the timeout: the (slightly late) headers + body arrive in budget →
// resolve. Proves a slow start is tolerated, not treated as a fault.
test('a slow TTFB shorter than the timeout resolves (a slow start is tolerated)', async () => {
    const payload = 'the-late-but-complete-body';
    server.route('GET', '/slow-ok', {
        statuses: [200],
        rawBody: payload,
        ttfbDelayMs: 120, // a 120ms slow start…
        headers: { 'content-disposition': 'attachment; filename=late.bin' },
    });

    const getSlowOk = download({
        baseUrl: server.url,
        path: '/slow-ok',
        timeout: 2000, // …well within a 2s budget → resolves
        retry: { attempts: 1 },
    });

    const out = await getSlowOk();
    expect(out.filename).toBe('late.bin');
    expect(new TextDecoder().decode(await out.blob.arrayBuffer())).toBe(
        payload,
    );
});
