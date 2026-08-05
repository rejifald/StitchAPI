// Pins docs/GAP-AUDIT.md §1.1: timeout.total must be a wall-clock budget across all attempts, backoff and throttle waits
import { stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-timeout-total-${process.pid}.jsonl`,
);

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

// Await a stitch call that is expected to reject; return the error and the wall-clock ms.
async function rejectionOf(call: PromiseLike<unknown>): Promise<{
    err: (Error & { status?: number }) | undefined;
    elapsed: number;
}> {
    const t0 = Date.now();
    const err = await Promise.resolve(call).then(
        () => undefined,
        (e: unknown) => e as Error & { status?: number },
    );
    return { err, elapsed: Date.now() - t0 };
}

// ── A. total caps backoff waits, not just the in-flight request ─────────────
// Route always 503s instantly; fixed 300ms backoff between 5 attempts would take
// ~1200ms of pure waiting. A total budget of 400ms must cut that short and
// surface a timeout — today `total` only ever feeds the per-attempt abort
// (engine.ts attemptLoop), so the call grinds through every backoff sleep and
// rejects with HTTP 503 after ~1200ms.
test('timeout.total caps the whole retry/backoff loop, not just one attempt', async () => {
    server.route('GET', '/always-503', {
        statuses: [503],
        body: { error: 'unavailable' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/always-503',
        retry: {
            attempts: 5,
            on: [503],
            backoff: { curve: 'fixed', base: 300 },
        },
        timeout: { total: 400 },
    });

    const { err, elapsed } = await rejectionOf(call());

    expect(err).toBeDefined();
    // Wall clock: the 400ms total budget must dominate the ~1200ms of remaining
    // fixed backoff (CI-safe upper bound well below the backoff total).
    expect(elapsed).toBeLessThan(1100);
    // And the rejection must say WHY: the total budget ran out.
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
}, 10000);

// ── B. total is enforced even when each is also set ─────────────────────────
// The documented example shape sets BOTH. The original bug had `each` win
// outright (`each ?? total`), leaving total read nowhere: five 350ms per-attempt
// aborts plus 4×50ms backoff ≈ 1950ms. The two are independent budgets now —
// each attempt is clamped to min(each, remaining total) — so the call must die
// at ~400ms.
test('timeout.total is enforced alongside timeout.each across retries', async () => {
    server.route('GET', '/glacial', {
        delay: 5000,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/glacial',
        retry: { attempts: 5, backoff: { curve: 'fixed', base: 50 } },
        timeout: { total: 400, each: 350 },
    });

    const { err, elapsed } = await rejectionOf(call());

    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    // total: 400 must bound the whole call — not 5 × each + backoffs.
    expect(elapsed).toBeLessThan(1500);
}, 10000);

// ── C. total caps a throttle/rate wait, not just request + backoff ──────────
// `throttle.rate` paces successive acquires for a key: the first call is granted
// immediately and arms the limiter's next-grant clock, so the next call must wait
// ~1000ms for its rate slot. That wait is part of the call and must count against
// `total` — a 300ms budget has to cut a call stuck behind the limiter short rather
// than let it block for the full rate spacing (acquireWithin, engine.ts).
test('timeout.total caps a throttle (rate) wait', async () => {
    server.route('GET', '/rate-limited', { body: { ok: true } }); // instant 200
    const call = stitch({
        baseUrl: server.url,
        path: '/rate-limited',
        throttle: { rate: '1/s' }, // 1000ms minimum spacing between grants
        timeout: { total: 300 },
    });

    // First call grants immediately (reserving the next grant ~1s out); the runtime
    // — and its limiter state — is reused by the second call.
    await call();
    // Second call is stuck behind the ~1000ms rate spacing; the 300ms budget must
    // abort the throttle wait and surface a timeout.
    const { err, elapsed } = await rejectionOf(call());

    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    expect(elapsed).toBeLessThan(900); // budget (300) ≪ rate spacing (1000)
}, 10000);

// ── D. total spans a paginated call, capping the page loop ──────────────────
// Pagination follows pages until `next` returns undefined; each page is a full
// request, and every page's time (here a 150ms server delay) draws down one shared
// budget. With `next` always advancing, only `total` can stop the loop — a 400ms
// budget must cut it to a few pages instead of grinding through `max` (50) pages.
test('timeout.total bounds a paginated call across pages', async () => {
    server.route('GET', '/feed', {
        delay: 150, // each page costs ~150ms
        body: (i: number) => ({ items: [i], cursor: i + 1 }),
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/feed',
        paginate: {
            items: (v) => (v as { items: unknown[] }).items,
            next: (body) => ({
                query: { cursor: String((body as { cursor: number }).cursor) },
            }),
            pages: 50,
        },
        timeout: { total: 400 },
    });

    const { err, elapsed } = await rejectionOf(call());

    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    // 50 pages × 150ms ≈ 7.5s unbounded; the 400ms total must stop it far sooner.
    expect(elapsed).toBeLessThan(2000);
}, 10000);

// ── E. total bounds executeRaw (the raw login path) ─────────────────────────
// `executeRaw` (exposed as `stitch.__raw`, used by cookieSession to read Set-Cookie
// from a login stitch) drives the same attempt loop and must honour `total` too —
// otherwise a hung login would block the whole session setup. A glacial endpoint
// under a 300ms total must reject promptly, not hang for the server's 5s.
test('timeout.total bounds executeRaw', async () => {
    server.route('GET', '/raw-glacial', { delay: 5000, body: { ok: true } });
    const call = stitch({
        baseUrl: server.url,
        path: '/raw-glacial',
        timeout: { total: 300 },
    }) as unknown as { __raw: (input?: unknown) => Promise<unknown> };

    const { err, elapsed } = await rejectionOf(call.__raw());

    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    expect(elapsed).toBeLessThan(2000); // the 300ms budget, not the 5s server delay
}, 10000);
