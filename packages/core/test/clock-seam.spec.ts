// ADR 0010 — the injectable Clock. A `manualClock()` injected as `clock` makes retry backoff,
// throttle pacing, and the per-attempt timeout deterministic with zero real waiting: `advance(ms)`
// drives them. Verified against the REAL engine via the published mock adapter.
import { seam, stitch } from '../src';
import { manualClock, mockAdapter } from '../src/testing';
import type { Adapter } from '../src/types';

describe('manualClock drives retry backoff (ADR 0010)', () => {
    test('each backoff elapses only when the clock is advanced', async () => {
        const clock = manualClock();
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { status: 503 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: {
                attempts: 3,
                on: [503],
                backoff: 'fixed',
                baseDelay: 10_000,
            },
            clock,
        });

        const p = call.safe();

        await clock.advance(0); // run the first attempt
        expect(api.callCount()).toBe(1);

        await clock.advance(10_000); // fire the backoff → 2nd attempt
        expect(api.callCount()).toBe(2);

        await clock.advance(10_000); // fire the backoff → 3rd attempt (200)
        const res = await p;

        expect(res.ok).toBe(true);
        expect(res.data).toEqual({ ok: true });
        expect(api.callCount()).toBe(3);
        expect(clock.pending()).toBe(0);
    });

    test('without advancing, a pending backoff never resolves', async () => {
        const clock = manualClock();
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: {
                attempts: 2,
                on: [503],
                backoff: 'fixed',
                baseDelay: 10_000,
            },
            clock,
        });

        const p = call.safe();
        await clock.advance(0); // first attempt only — backoff is armed but not elapsed

        expect(api.callCount()).toBe(1);
        expect(clock.pending()).toBe(1); // the backoff sleep is waiting

        await clock.advance(10_000);
        await p;
        expect(api.callCount()).toBe(2);
    });
});

describe('manualClock drives throttle rate spacing (ADR 0010)', () => {
    test('a second call is paced by the rate budget, released on advance', async () => {
        const clock = manualClock();
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const call = stitch({
            url: 'https://api.test/x',
            adapter: api,
            throttle: { rate: '2/s' }, // 500ms between grants
            clock,
        });

        const a = call.safe();
        const b = call.safe();

        await clock.advance(0); // first grant is immediate; second is paced
        expect(api.callCount()).toBe(1);

        await clock.advance(500); // release the second grant
        await Promise.all([a, b]);
        expect(api.callCount()).toBe(2);
    });

    // A seam builds its SHARED bucket from the raw authoring fragment, before `compose` normalizes
    // any member — so the rate-string shorthand has to be expanded on that path too. Miss it and
    // the bucket is built with an undefined rate: both members would fire at `advance(0)`.
    test('a seam-level `throttle: "2/s"` shorthand paces two DIFFERENT members on one bucket', async () => {
        const clock = manualClock();
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const shared = seam({
            baseUrl: 'https://api.test',
            adapter: api,
            throttle: '2/s', // ≡ { rate: '2/s' } — 500ms between grants
            clock,
        });
        const x = shared.stitch('/x');
        const y = shared.stitch('/y');

        const a = x.safe();
        const b = y.safe();

        await clock.advance(0); // the seam pools one bucket, so the second member is paced
        expect(api.callCount()).toBe(1);

        await clock.advance(500);
        await Promise.all([a, b]);
        expect(api.callCount()).toBe(2);
    });
});

describe('manualClock drives the per-attempt timeout (ADR 0010)', () => {
    test('the timeout fires on advance, aborting the in-flight request', async () => {
        const clock = manualClock();
        // A transport that hangs until its signal aborts — so only the timeout can end it.
        const hangs: Adapter = (req) =>
            new Promise((_resolve, reject) => {
                req.signal?.addEventListener(
                    'abort',
                    () => {
                        reject(new Error('aborted'));
                    },
                    { once: true },
                );
            });
        const call = stitch({
            url: 'https://api.test/slow',
            adapter: hangs,
            timeout: { perAttempt: 1000 },
            clock,
        });

        const p = call.safe();
        await clock.advance(0); // reach the adapter; arm the timeout
        await clock.advance(1000); // fire it

        const res = await p;
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
    });
});
