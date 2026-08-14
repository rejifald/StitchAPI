// Pins P1 (download-test-rig-spec §2.8): under a shared host throttle, no more than `k` download
// requests are OPEN ON THE WIRE at any instant. Asserted from the mock server's own concurrency probe
// (`maxOpen`) — ACTUAL on-the-wire overlap, not "we decided to be concurrent". This is the ceiling the
// future @stitchapi/download batch layer stands on: it sequences a caller's LIST, but the per-request
// admission cap is core `throttle`, and it must genuinely bound the wire.
//
// N INDEPENDENT download() stitches (a batch of distinct files) share ONE host-keyed concurrency
// budget via `throttle: { concurrency: k, pool: 'host' }` — P2, the cross-instance pooling substrate
// (resilience.ts `hostStates`, keyed by URL host). Each route holds its response with `ttfbDelay` so
// the k admitted slots stay open together long enough to observe the peak.
//
// Real-timer, LOOSE bounds (a socket test): the hold (150ms) is wide vs. loopback dispatch jitter
// (two near-simultaneous fetches land sub-ms apart), so the k concurrent slots reliably overlap; no
// exact timing is asserted, only a COUNT. Held sockets are force-destroyed at teardown (the server
// tracks live sockets), so the suite exits.
//
// Deferred (needs the unbuilt @stitchapi/download batch orchestrator, NOT raw download()+throttle):
//   • FIFO admission ORDER — that queued items (k+1)…N start in enqueue order as slots free (P6). The
//     limiter serves concurrency waiters FIFO, but PROVING per-item order needs the batch API's stable
//     item identity + start events, which don't exist yet.
//   • Aggregate progress / ETA across the N concurrent streams (P8) — a batch-level roll-up, not a
//     property of a single download().
// Here we pin only the wire CEILING + host pooling those features are built on.
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

const blobText = async (b: Blob): Promise<string> =>
    new TextDecoder().decode(await b.arrayBuffer());

test('≤ k download requests are open on the wire at once under a shared host throttle', async () => {
    const K = 2;
    const N = 6;
    const paths = Array.from({ length: N }, (_, i) => `/file-${i}`);
    for (const p of paths)
        server.route('GET', p, {
            statuses: [200],
            rawBody: `contents-of${p}`,
            ttfbDelay: 150, // hold each admitted slot open long enough to observe the overlap
        });

    // N INDEPENDENT download stitches (distinct files), all sharing one host-keyed budget of K.
    const calls = paths.map((p) =>
        download({
            baseUrl: server.url,
            path: p,
            throttle: { concurrency: K, pool: 'host' },
            retry: { attempts: 1 },
        }),
    );

    // `Promise.all` subscribes to every cold StitchResult in the same tick → all N are launched
    // concurrently; the throttle, not the test, decides how many actually reach the wire.
    const results = await Promise.all(calls.map((c) => c()));

    // THE CEILING: the server never saw more than K requests open on the wire at any instant.
    expect(server.maxOpen()).toBeLessThanOrEqual(K);
    // …and the budget was genuinely SATURATED (real concurrency, not accidental serialization) — else
    // "≤ K" would pass vacuously at 1. With N > K and a 150ms hold, the peak must reach K.
    expect(server.maxOpen()).toBe(K);
    // Every file still downloaded correctly and completely — the cap PACES work, it never drops it.
    expect(results).toHaveLength(N);
    for (let i = 0; i < N; i++)
        expect(await blobText(results[i]!.blob)).toBe(
            `contents-of${paths[i]!}`,
        );
    // Sanity: all N requests actually reached the server (nothing was silently dropped by the gate).
    expect(server.callCount()).toBe(N);
    // The probe also records a per-request arrival timestamp, in receipt order (the observable the
    // future batch layer's ETA/progress math will read); one per request, monotonically non-decreasing.
    const ts = server.arrivals();
    expect(ts).toHaveLength(N);
    for (let i = 1; i < ts.length; i++)
        expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
});
