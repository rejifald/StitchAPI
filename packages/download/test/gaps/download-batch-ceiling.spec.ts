// Pins P1/P6/P14 (download-test-rig-spec §2.8) at the @stitchapi/download BATCH layer: the batch's own
// FIFO scheduler holds the wire to ≤ `concurrency` requests open at once (P1) AND admits queued items in
// strict ENQUEUE ORDER as slots free (P6/P14). Core's download-concurrency-ceiling.spec explicitly
// DEFERRED proving per-item order to this package ("proving per-item order needs the batch API's stable
// item identity + start events, which don't exist yet") — `onItemStart` is that event.
//
// Real-timer, LOOSE bounds (a socket test): each route holds its admitted slot with `ttfbDelayMs` so the
// K requests overlap on the wire long enough for the server's `maxOpen` probe to see the peak; no
// wall-clock gap is asserted, only a COUNT + an order. Held sockets are force-destroyed at teardown.
import { downloadAll } from '../../src';
import type { DownloadResult, ItemResult } from '../../src';
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

// Narrow to the fulfilled arm by THROWING (not a conditional `expect`, which the lint forbids).
const okValue = (r: ItemResult): DownloadResult => {
    if (r.status !== 'fulfilled')
        throw new Error(`expected fulfilled but got ${r.status}`);
    return r.value;
};

test('the batch caps the wire at `concurrency` and admits queued items in FIFO order', async () => {
    const K = 2;
    const N = 6;
    const paths = Array.from({ length: N }, (_, i) => `/file-${i}`);
    for (const p of paths)
        server.route('GET', p, {
            statuses: [200],
            rawBody: `body${p}`,
            ttfbDelayMs: 120, // hold each admitted slot open long enough to observe the peak overlap
        });

    const started: number[] = [];
    const batch = downloadAll(
        paths.map((p) => ({ path: p })),
        {
            concurrency: K,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
            onItemStart: (id) => {
                started.push(id as number);
            },
        },
    );
    const results = await batch;

    // THE CEILING: never more than K requests open on the wire at any instant (the server's own probe),
    // and genuinely SATURATED (the peak reached K) so "≤ K" isn't passing vacuously at 1.
    expect(server.maxOpen()).toBeLessThanOrEqual(K);
    expect(server.maxOpen()).toBe(K);

    // FIFO ADMISSION: the six items started in strict enqueue order 0..5 — no queue-jumping. (Ids
    // default to the enqueue index when an item carries no explicit id / url.)
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    // Every file downloaded completely; the cap PACES work, it never drops it.
    expect(results).toHaveLength(N);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    for (let i = 0; i < N; i++)
        expect(await blobText(okValue(results[i]!).blob)).toBe(
            `body${paths[i]!}`,
        );
    expect(server.callCount()).toBe(N);
});
