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
        retry: { attempts: 3, on: [503], baseMs: 5 },
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
        retry: { attempts: 3, on: [503], baseMs: 5 },
    });

    await expect(call()).rejects.toMatchObject({ status: 503 });
    expect(server.callCount('/down')).toBe(3);
});

// ── 3. Respects Retry-After ────────────────────────────────────────────────
test('honors the Retry-After header instead of the short backoff', async () => {
    server.route('GET', '/limited', {
        statuses: [429, 200],
        retryAfter: 1,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/limited',
        retry: { attempts: 2, on: [429], respectRetryAfter: true, baseMs: 5 },
    });

    const t0 = Date.now();
    await expect(call()).resolves.toEqual({ ok: true });
    const elapsed = Date.now() - t0;

    // Retry-After: 1 (second) must dominate the 5ms backoff.
    expect(elapsed).toBeGreaterThanOrEqual(900);
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
    expect(throttled.some((e) => (e.waitedMs ?? 0) > 0)).toBe(true);
});

// ── 5. Throttle concurrency cap ────────────────────────────────────────────
test('throttle concurrency:1 serializes concurrent calls', async () => {
    server.route('GET', '/serial', { delayMs: 60, body: { ok: true } });
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
    server.route('GET', '/slow', { delayMs: 200, body: { ok: true } });
    const call = stitch({
        baseUrl: server.url,
        path: '/slow',
        timeout: { total: 50 },
    });

    const t0 = Date.now();
    await expect(call()).rejects.toBeDefined();
    const elapsed = Date.now() - t0;

    // Aborted near the 50ms deadline, not after the full 200ms server delay.
    expect(elapsed).toBeLessThan(180);
});
