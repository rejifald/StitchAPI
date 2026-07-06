// Pins: a `download` caught in a redirect LOOP must REJECT — bounded, never a hang.
//
// A route that 302s to itself forever would spin an uncapped follower. fetchAdapter's manual-follow
// loop caps at MAX_REDIRECTS (~20, matching the platform default) and, once the cap is hit, returns
// the LAST 3xx response instead of following again. That 30x then flows into `download`'s M1
// `interpret`, which accepts only a complete 200/204 — so the capped loop surfaces as a
// `download:`-interpret REJECT (an HTTP 30x message), NOT a hang and NOT a silently-accepted Blob.
// This pins that composition end-to-end over a real socket; no `src/` change is involved.
//
// Real-timer, loose bounds (a socket test): the assertion is a wide wall-clock ceiling proving the
// call returns promptly (bounded hops, each a local round-trip), plus a bounded hop count from the
// server's own call log. The server is closed in afterAll.
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

test('a self-redirect loop is bounded and REJECTS (the capped 30x fails interpret) — never hangs', async () => {
    // Every GET /loop answers 302 → /loop again: an infinite chain if uncapped.
    server.route('GET', '/loop', {
        statuses: [302],
        redirectTo: '/loop',
    });

    const getLooping = download({
        baseUrl: server.url,
        path: '/loop',
        retry: { attempts: 1 }, // don't let a retry re-run the whole loop
    });

    const started = Date.now();
    // The capped loop yields a 30x; interpret rejects it as a non-200/204 body. The message is the
    // download surface's "expected a complete body (200/204) but got HTTP 30x".
    await expect(getLooping()).rejects.toThrow(/30\d|complete body|download/i);
    // Bounded wall-clock: the whole capped chain of local round-trips finishes well under the ceiling.
    expect(Date.now() - started).toBeLessThan(10000);

    // Bounded hop count: the initial request + at most MAX_REDIRECTS (~20) follows. The loop stopped;
    // it did not spin. (> 1 proves it actually followed at least one redirect.)
    const hops = server.callCount('/loop');
    expect(hops).toBeGreaterThan(1);
    expect(hops).toBeLessThanOrEqual(21);
});
