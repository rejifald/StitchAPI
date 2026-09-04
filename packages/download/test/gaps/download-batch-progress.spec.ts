// Pins P8/P17 at the batch API: aggregate progress + ETA across N concurrent streams, correct under a
// KNOWN byte schedule and driven by the injected Clock (`manualClock`) so the rate/ETA MATH is
// deterministic with ZERO wall-clock. Core's ceiling spec DEFERRED this as "a batch-level roll-up, not a
// property of a single download()". A stalled sibling plateaus its own term but never corrupts the
// aggregate; a failed/cancelled item's partial bytes are discarded (P9).
import { downloadAll } from '../../src';
import type { BatchProgress, DownloadResult, ItemResult } from '../../src';
import { ProgressAggregator } from '../../src/progress';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { manualClock } from 'stitchapi/testing';

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

const okValue = (r: ItemResult): DownloadResult => {
    if (r.status !== 'fulfilled')
        throw new Error(`expected fulfilled but got ${r.status}`);
    return r.value;
};

test('aggregate loaded/total/rate/ETA are EXACT under a known byte schedule (manualClock)', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);

    // Two 1000-byte streams. First bytes at t=0 (loaded > 0 sets the ETA baseline).
    agg.item('a', { loaded: 100, total: 1000 });
    agg.item('b', { loaded: 100, total: 1000 });
    await clock.advance(1000); // one second of virtual time, by hand (advance() is async)
    agg.item('a', { loaded: 600, total: 1000 });
    agg.item('b', { loaded: 400, total: 1000 });

    const s = agg.snapshot(2);
    expect(s.loaded).toBe(1000); // 600 + 400
    expect(s.total).toBe(2000); // 1000 + 1000
    expect(s.count).toBe(2);
    expect(s.completed).toBe(0);
    // 1000 bytes in 1000ms → 1000 B/s; remaining 1000 bytes → ETA exactly 1000ms. No wall-clock.
    expect(s.throughput).toBe(1000);
    expect(s.eta).toBe(1000);
});

test('a stalled sibling plateaus its own term; a dropped item discards its partial bytes', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);
    agg.item('fast', { loaded: 500, total: 1000 });
    agg.item('stall', { loaded: 200, total: 1000 });
    await clock.advance(1000);
    agg.item('fast', { loaded: 1000, total: 1000 }); // 'stall' never reports again — frozen at 200

    const s = agg.snapshot(2);
    expect(s.loaded).toBe(1200); // 1000 + 200 — the stall contributes ONLY what it truly pulled
    expect(s.total).toBe(2000);

    // fast fulfils; stall times out and is dropped → its 200 partial bytes vanish from the aggregate.
    agg.fulfilled('fast', 1000, 1000);
    agg.dropped('stall');
    const s2 = agg.snapshot(2);
    expect(s2.loaded).toBe(1000); // only fast's final bytes; the stall's partial is discarded
    expect(s2.completed).toBe(2);
});

test('an indeterminate (chunked) item makes the aggregate total + ETA undefined, rate still known', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);
    agg.item('chunked', { loaded: 50 }); // no total (chunked / no Content-Length)
    await clock.advance(500);

    const s = agg.snapshot(1);
    expect(s.loaded).toBe(50);
    expect(s.total).toBeUndefined();
    expect(s.eta).toBeUndefined(); // no total ⇒ no ETA…
    expect(s.throughput).toBe(100); // …but the rate is still known: 50 bytes in 0.5s = 100 B/s
});

test('downloadAll rolls per-item progress into a correct aggregate across concurrent streams', async () => {
    const sizes: Record<string, number> = {
        '/p0': 300,
        '/p1': 500,
        '/p2': 700,
    };
    for (const [p, n] of Object.entries(sizes))
        server.route('GET', p, {
            statuses: [200],
            rawBody: 'x'.repeat(n),
            chunkBytes: 100,
            chunkDelay: 5,
        });

    let last: BatchProgress | undefined;
    const results = await downloadAll(
        Object.keys(sizes).map((p) => ({ path: p })),
        {
            concurrency: 3,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
            onProgress: (p) => {
                last = p;
            },
        },
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(last).toBeDefined();
    // The final aggregate accounts for every byte and every item — a truthful roll-up of N streams.
    expect(last!.completed).toBe(3);
    expect(last!.count).toBe(3);
    expect(last!.loaded).toBe(300 + 500 + 700);
    // Sanity: the fulfilled blobs are the exact sizes we streamed.
    expect(okValue(results[0]!).blob.size).toBe(300);
    expect(okValue(results[2]!).blob.size).toBe(700);
});
