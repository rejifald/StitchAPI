// Pins P2/P3 (download-test-rig-spec §2.8): `throttle.pool` decides whether a batch of INDEPENDENT
// download() stitches shares ONE concurrency budget or keeps N private ones — the difference the batch
// layer relies on to bound a whole host.
//
//   • pool:'host'   → all stitches hitting the same host share one budget (resilience.ts `hostStates`,
//                     keyed by URL host). N downloads, budget k ⇒ at most k open on the wire.
//   • pool:'stitch' → each stitch owns its budget (closure-local). N downloads each called once ⇒ each
//                     admits its own call ⇒ more than k open at once.
//
// Proven by the mock server's overlap COUNT (`maxOpen`), NOT a wall-clock gap — so, unlike the old
// rate-pooling test, this can't inherit a real-timer flake (a count is a hard limiter invariant; a
// slow runner only ever makes fewer overlap, never more). `ttfbDelayMs` holds every admitted slot open
// together so the peak is observable. Real-timer, LOOSE bounds; held sockets destroyed at teardown.
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

test('pool:"host" shares one budget (≤k open) while pool:"stitch" keeps independent budgets (>k open)', async () => {
    const K = 2;
    const N = 5;
    const paths = Array.from({ length: N }, (_, i) => `/f-${i}`);
    const route = (): void => {
        for (const p of paths)
            server.route('GET', p, {
                statuses: [200],
                rawBody: `body${p}`,
                ttfbDelayMs: 150, // hold admitted slots open together to observe the peak overlap
                // `Connection: close` so the client keeps NO keep-alive socket: the mid-test
                // `server.reset()` (below) force-destroys live sockets, and a kept-alive one would be
                // reused stale in phase 2 → a spurious ECONNRESET ("fetch failed", the spec's N12
                // stale-keep-alive hazard). Closing per response sidesteps it without weakening the
                // overlap measurement (concurrent requests still open concurrent fresh sockets).
                headers: { connection: 'close' },
            });
    };
    const fire = (pool: 'host' | 'stitch'): Promise<unknown[]> =>
        Promise.all(
            paths.map((p) =>
                download({
                    baseUrl: server.url,
                    path: p,
                    throttle: { concurrency: K, pool },
                    retry: { attempts: 1 },
                })(),
            ),
        );

    // Phase 1 — host pooling: the whole host is capped at K regardless of how many stitches there are.
    route();
    await fire('host');
    const hostMax = server.maxOpen();

    // Reset the probe (and routes) and repeat with stitch-local pooling.
    server.reset();
    route();
    await fire('stitch');
    const stitchMax = server.maxOpen();

    // The contrast is the whole point: one shared host budget vs. N independent ones.
    expect(hostMax).toBeLessThanOrEqual(K); // shared → never more than K on the wire
    expect(stitchMax).toBeGreaterThan(K); // independent → the host cap does NOT bind across stitches
    expect(stitchMax).toBeGreaterThan(hostMax); // measurably different, as documented
});
