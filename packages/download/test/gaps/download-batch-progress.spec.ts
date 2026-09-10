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

// ---- #456: the rate/ETA track RECENT throughput, not the since-first-byte average ----------
// The old math was `loaded / (now - firstByteAt)` — one overall average over the whole batch's
// lifetime. It is wrong in BOTH directions, and both are pinned here: a slow head keeps dragging
// the ETA up long after the batch recovered, and a fast head keeps it optimistic long after the
// batch stalled. Both cases below FAIL against that average and pass against the decayed rate.

test('a slow head stops inflating the ETA once the batch is streaming fast again (#456)', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);

    // A 20-second crawl off the line: 20 bytes of a 100_000-byte item.
    agg.item('a', { loaded: 10, total: 100_000 });
    await clock.advance(20_000);
    agg.item('a', { loaded: 20, total: 100_000 });
    agg.snapshot(1);

    // …then it recovers to a healthy 20 kB/s for four seconds.
    for (const loaded of [20_000, 40_000, 60_000, 80_000]) {
        await clock.advance(1000);
        agg.item('a', { loaded, total: 100_000 });
        agg.snapshot(1);
    }

    const s = agg.snapshot(1);
    // Overall average: 80_000 B over 24_000 ms = 3333 B/s → a ~6-second ETA for the last 20 kB,
    // three times too long, because the dead first 20 s is still in the denominator. The decayed
    // rate has all but forgotten the crawl and reads the live 20 kB/s.
    expect(s.throughput!).toBeGreaterThan(10_000);
    expect(s.eta!).toBeLessThan(2000);
});

test('a fast head stops hiding a stalled tail — the ETA reflects the stall (#456)', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);

    // Half of a 10_000-byte item lands in the first second: 5 kB/s.
    agg.item('a', { loaded: 1, total: 10_000 });
    await clock.advance(1000);
    agg.item('a', { loaded: 5000, total: 10_000 });
    const fast = agg.snapshot(1);
    expect(fast.throughput).toBe(5000); // first sample: 5000 B in 1000 ms, exactly
    expect(fast.eta).toBe(1000); // 5000 B left at 5 kB/s

    // Then it crawls: 50 bytes per ten seconds, twice.
    for (const loaded of [5050, 5100]) {
        await clock.advance(10_000);
        agg.item('a', { loaded, total: 10_000 });
        agg.snapshot(1);
    }

    const s = agg.snapshot(1);
    // Overall average: 5100 B over 21_000 ms = 243 B/s → a ~20-second ETA, still carrying the fast
    // first second. Recent throughput is 5 B/s, so the true wait is minutes, not seconds.
    expect(s.throughput!).toBeLessThan(50);
    expect(s.eta!).toBeGreaterThan(100_000);
});

test('an idle stretch with no new bytes decays the rate with no chunk to report (#456)', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);
    agg.item('a', { loaded: 4000, total: 10_000 });
    await clock.advance(1000);
    agg.item('a', { loaded: 5000, total: 10_000 }); // the last chunk of a healthy first second
    const before = agg.snapshot(1);

    // Nothing arrives for a minute. `snapshot()` is the only caller — a stall reports no chunks,
    // so polling the handle is exactly how a caller learns the transfer has gone quiet.
    await clock.advance(60_000);
    const after = agg.snapshot(1);

    expect(after.throughput!).toBeLessThan(before.throughput!);
    expect(after.eta!).toBeGreaterThan(before.eta!);
});

test('repeated snapshots at one instant are idempotent — polling cannot skew the rate (#456)', async () => {
    const clock = manualClock(0);
    const agg = new ProgressAggregator(clock);
    agg.item('a', { loaded: 1000, total: 4000 });
    await clock.advance(1000);
    agg.item('a', { loaded: 2000, total: 4000 });

    const first = agg.snapshot(1);
    expect(first.throughput).toBe(2000);
    for (let i = 0; i < 5; i += 1) {
        const again = agg.snapshot(1);
        expect(again.throughput).toBe(first.throughput);
        expect(again.eta).toBe(first.eta);
    }
});

test('a dropped item costs the rate exactly what a stalled one does — nothing (#456)', async () => {
    // Same byte schedule twice: 'b' is dropped in one run and merely goes quiet in the other. The
    // drop cuts 1000 bytes out of `loaded`, and that cliff must NOT be charged against the interval
    // as if 'a' had gone backwards — 'a' pulled its 1000 bytes either way, so the rate is the same.
    const run = (dropB: boolean) => {
        const clock = manualClock(0);
        const agg = new ProgressAggregator(clock);
        agg.item('a', { loaded: 1000, total: 4000 });
        agg.item('b', { loaded: 1000, total: 4000 });
        return { clock, agg, dropB };
    };

    const runs = [run(true), run(false)];
    const rates: number[] = [];
    const loads: number[] = [];
    for (const { clock, agg, dropB } of runs) {
        await clock.advance(1000);
        expect(agg.snapshot(2).throughput).toBe(2000); // 2000 B in 1000 ms, both runs

        if (dropB) agg.dropped('b'); // 1000 partial bytes leave the aggregate
        await clock.advance(1000);
        agg.item('a', { loaded: 2000, total: 4000 }); // 'a' pulls 1000 more in both runs

        const s = agg.snapshot(2);
        rates.push(s.throughput!);
        loads.push(s.loaded);
    }

    expect(loads).toEqual([2000, 3000]); // the drop DOES discard its partial bytes from `loaded`…
    expect(rates[0]).toBe(rates[1]); // …but it must not be mistaken for negative throughput
    expect(rates[0]!).toBeGreaterThan(0);
});
