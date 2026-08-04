import { stitch } from '../src';
import type { StitchEvent } from '../src/types';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-resilience-${process.pid}.jsonl`,
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

// Drain a stitch's event stream into an array (and let it run to completion).
async function collect(s: {
    stream(): AsyncGenerator<StitchEvent>;
}): Promise<StitchEvent[]> {
    const events: StitchEvent[] = [];
    for await (const ev of s.stream()) events.push(ev);
    return events;
}

// ── 1. Retry then succeed ──────────────────────────────────────────────────
test('retries on 503 then succeeds, reporting attempts and retry progress', async () => {
    server.route('GET', '/flaky', {
        statuses: [503, 503, 200],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/flaky',
        retry: { attempts: 3, on: [503], backoff: { base: 5 } },
    });

    const events = await collect(call());

    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect(result).toMatchObject({ type: 'result', attempts: 3 });

    const retryProgress = events.filter(
        (e) => e.type === 'progress' && e.phase === 'retry',
    );
    expect(retryProgress.length).toBeGreaterThanOrEqual(2);

    // The await sugar resolves to the unwrapped value.
    await expect(call()).resolves.toEqual({ ok: true });
});

// ── 2. Retry exhausted → error ─────────────────────────────────────────────
test('rejects with status 503 after exhausting all retry attempts', async () => {
    server.route('GET', '/down', {
        statuses: [503, 503, 503],
        body: { error: 'unavailable' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/down',
        retry: { attempts: 3, on: [503], backoff: { base: 5 } },
    });

    await expect(call()).rejects.toMatchObject({ status: 503 });
    expect(server.callCount('/down')).toBe(3);
});

// ── 3. Respects Retry-After BY DEFAULT ─────────────────────────────────────
// `retry.respect` defaults ON, so this config never names it. The 5ms backoff is what a
// non-respecting engine would wait, which is what makes the elapsed assertion discriminating.
test('honors the Retry-After header with no opt-in, over the short backoff', async () => {
    server.route('GET', '/limited', {
        statuses: [429, 200],
        retryAfterSeconds: 1,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/limited',
        retry: { attempts: 2, on: [429], backoff: { base: 5 } },
    });

    const t0 = Date.now();
    await expect(call()).resolves.toEqual({ ok: true });
    const elapsed = Date.now() - t0;

    // Retry-After: 1 (second) must dominate the 5ms backoff.
    expect(elapsed).toBeGreaterThanOrEqual(900);
}, 15000);

// ── 3b. `respect: false` forces the computed curve ─────────────────────────
test('respect:false ignores Retry-After and uses the computed backoff', async () => {
    server.route('GET', '/limited-off', {
        statuses: [429, 200],
        retryAfterSeconds: 1,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/limited-off',
        retry: {
            attempts: 2,
            on: [429],
            respect: false,
            backoff: { curve: 'fixed', base: 5 },
        },
    });

    const t0 = Date.now();
    await expect(call()).resolves.toEqual({ ok: true });
    const elapsed = Date.now() - t0;

    // The 5ms fixed backoff wins — nowhere near the 1s the server asked for.
    expect(elapsed).toBeLessThan(500);
    expect(server.callCount('/limited-off')).toBe(2);
}, 15000);

// ── 3c. `timeout.total` is the bound on a long Retry-After ─────────────────
// There is no ceiling ON the honored wait by design (one patience budget, not two). A server
// asking for 30s does not park the call for 30s when the caller declared a total budget — the
// shared deadline cuts the sleep short and fails with the timeout, not a 30s stall.
test('timeout.total bounds a long Retry-After instead of waiting it out', async () => {
    server.route('GET', '/parked', {
        statuses: [429, 200],
        retryAfterSeconds: 30,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/parked',
        retry: { attempts: 2, on: [429], backoff: { base: 5 } },
        timeout: { total: '300ms' },
    });

    const t0 = Date.now();
    await expect(call()).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3_000); // NOT the 30s the server asked for
    expect(server.callCount('/parked')).toBe(1); // never got to the second attempt
}, 15000);

// ── 4. Throttle rate spacing ───────────────────────────────────────────────
test('throttle rate spaces sequential calls and emits throttled progress', async () => {
    server.route('GET', '/rate', { body: { ok: true } });
    // 20/s -> 50ms minimum spacing between successive acquires.
    const call = stitch({
        baseUrl: server.url,
        path: '/rate',
        throttle: { rate: '20/s' },
    });

    const allEvents: StitchEvent[] = [];
    const t0 = Date.now();
    // Three SEQUENTIAL calls on the SAME stitch instance so the limiter state carries over.
    for (let i = 0; i < 3; i++) {
        for await (const ev of call().stream()) allEvents.push(ev);
    }
    const elapsed = Date.now() - t0;

    // Two 50ms gaps between three calls -> ~100ms minimum.
    expect(elapsed).toBeGreaterThanOrEqual(90);

    const throttled = allEvents.filter(
        (e): e is Extract<StitchEvent, { type: 'progress' }> =>
            e.type === 'progress' && e.phase === 'throttled',
    );
    expect(throttled.length).toBeGreaterThanOrEqual(1);
    expect(throttled.some((e) => (e.waited ?? 0) > 0)).toBe(true);
});

// ── 5. Throttle concurrency cap ────────────────────────────────────────────
test('throttle concurrency:1 serializes concurrent calls', async () => {
    server.route('GET', '/serial', { delay: 60, body: { ok: true } });
    const call = stitch({
        baseUrl: server.url,
        path: '/serial',
        throttle: { concurrency: 1 },
    });

    const t0 = Date.now();
    await Promise.all([call(), call()]);
    const elapsed = Date.now() - t0;

    // Serialized: ~60ms + ~60ms. Parallel would be ~60ms; require well above that.
    expect(elapsed).toBeGreaterThanOrEqual(110);
});

// ── 6. Timeout aborts ──────────────────────────────────────────────────────
test('timeout aborts a slow request instead of waiting it out', async () => {
    // The route answers only after 2s — 40× the timeout budget. That ratio, not a tight absolute
    // margin, is what separates "aborted at the deadline" from "waited the server out". A loaded
    // runner (parallel vitest workers, a concurrent build) stalls the event loop and pushes the
    // measured elapsed up by however long the stall lasted; the old shape (200ms delay, ceiling
    // 180) reddened at a ~160ms stall, which is an ordinary amount of noise — measured elapsed 206
    // on a failing run. Widening the delay buys the ceiling room: this shape survives a ~950ms
    // stall. Don't narrow the gap between `delay`, `total` and the ceiling below.
    server.route('GET', '/slow', { delay: 2000, body: { ok: true } });
    const call = stitch({
        baseUrl: server.url,
        path: '/slow',
        timeout: { total: 50 },
    });

    const t0 = Date.now();
    const err = await call().then(
        () => undefined,
        (e: unknown) => e as Error,
    );
    const elapsed = Date.now() - t0;

    // The call must fail, and fail *because the budget ran out* — not with some other error, and
    // certainly not resolve with the body a non-aborting timeout would have waited around for.
    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    // And it must give up promptly rather than rejecting only once the response lands. The
    // ceiling is deliberately loose — 20× the 50ms budget, still 2× under the server's 2s delay —
    // so scheduling noise can't red it while a timeout that stopped aborting still can.
    expect(elapsed).toBeLessThan(1000);
});
