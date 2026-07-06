// Pins P9 (download-test-rig-spec §2.8): under concurrency, ONE stalled download must time out ALONE
// without taking its siblings down — the others complete with their bytes intact. Composes the M2
// `stallAfterBytes` injector (a socket held open mid-body, which undici waits on forever) with a
// per-call `timeout` (the only cure — there is no idle/forward-progress timeout; see
// download-slow-vs-stall.spec.ts). The stalled item holds one slot of the shared budget until its
// timeout fires; the other slot keeps draining healthy siblings, which succeed and carry complete,
// uncorrupted blobs. This is the batch-level "one dead stream doesn't corrupt the rest" guarantee, at
// the raw download()+throttle layer.
//
// Real-timer, LOOSE bounds (a socket test): the stall's 250ms timeout is the only real duration that
// matters; healthy items are fast, and the suite closes well under a generous ceiling. The held stall
// socket is force-destroyed at teardown (the server tracks live sockets), so the suite exits.
//
// Deferred (needs the unbuilt @stitchapi/download batch API's cancellation surface): cancel-ONE
// in-flight → only that item aborts, its slot returns to the queue (P10); cancel a QUEUED item → frees
// no slot, doesn't skip the next (P11); CANCEL-ALL → every in-flight aborts, the queue drains, and the
// shared `pool:'host'` state is left clean for a later batch (P12/P13). Those are properties of a batch
// controller's AbortSignal wiring, not of a single download() call — pinned when that API exists.
import { download } from '../../src/download';
import type { DownloadResult } from '../../src/download';
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

// The stalled item sits SECOND so it is admitted in the first wave (K=2) alongside a healthy one — it
// then pins one slot for the whole timeout while the other slot drains the rest.
const ITEMS = [
    { path: '/well-0', kind: 'ok' as const },
    { path: '/stalls', kind: 'stall' as const },
    { path: '/well-1', kind: 'ok' as const },
    { path: '/well-2', kind: 'ok' as const },
];

test('a stalled item under concurrency times out ALONE — siblings finish with intact blobs', async () => {
    for (const it of ITEMS) {
        if (it.kind === 'ok')
            server.route('GET', it.path, {
                statuses: [200],
                rawBody: `well-body${it.path}`,
                ttfbDelayMs: 40, // brief hold so healthy items genuinely overlap the stall under the gate
            });
        else
            server.route('GET', it.path, {
                statuses: [200],
                rawBody:
                    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
                declaredLength: 64, // advertise 64…
                stallAfterBytes: 8, // …write 8, then hold the socket open forever
            });
    }

    const calls = ITEMS.map((it) =>
        download({
            baseUrl: server.url,
            path: it.path,
            throttle: { concurrency: 2, pool: 'host' },
            // The timeout is scoped to the STALLED item alone. `timeout.total` counts throttle-queue
            // wait against the budget (engine.ts), so putting a 250ms timeout on the healthy siblings
            // too would let the stall's held slot push a queued sibling over its OWN deadline — the
            // very cross-contamination this test proves does NOT happen. Healthy items carry no
            // timeout: they simply wait for a slot and complete.
            ...(it.kind === 'stall' ? { timeout: 250 } : {}),
            retry: { attempts: 1 },
        }),
    );

    const settled = await Promise.allSettled(calls.map((c) => c()));

    // The stalled item (index 1) rejects on its own timeout; every sibling fulfils.
    expect(settled.map((s) => s.status)).toEqual([
        'fulfilled', // well-0
        'rejected', // stalls → timeout
        'fulfilled', // well-1
        'fulfilled', // well-2
    ]);

    // The stall was cut by the TIMEOUT (an abort), not resolved as a partial Blob.
    const stallErr = (settled[1] as PromiseRejectedResult).reason as Error;
    expect(stallErr).toBeInstanceOf(Error);
    expect(stallErr.message).toMatch(/timeout|timed out|abort|aborted/i);

    // Siblings' bytes are COMPLETE and uncorrupted — the stall did not distort their result.
    for (const i of [0, 2, 3]) {
        const r = settled[i] as PromiseFulfilledResult<DownloadResult>;
        expect(await blobText(r.value.blob)).toBe(`well-body${ITEMS[i]!.path}`);
    }
});
