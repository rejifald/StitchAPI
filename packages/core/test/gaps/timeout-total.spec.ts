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
        retry: { attempts: 5, on: [503], backoff: 'fixed', baseMs: 300 },
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

// ── B. total is enforced even when perAttempt is also set ───────────────────
// The documented example shape sets BOTH. Today perAttempt wins outright
// (perAttempt ?? total) and total is read nowhere: five 350ms per-attempt
// aborts plus 4×50ms backoff ≈ 1950ms. With total honored, the call must die
// at ~400ms.
test('timeout.total is enforced alongside timeout.perAttempt across retries', async () => {
    server.route('GET', '/glacial', {
        delayMs: 5000,
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/glacial',
        retry: { attempts: 5, backoff: 'fixed', baseMs: 50 },
        timeout: { total: 400, perAttempt: 350 },
    });

    const { err, elapsed } = await rejectionOf(call());

    expect(err).toBeDefined();
    expect(err?.message ?? '').toMatch(/timed?\s?out|timeout/i);
    // total: 400 must bound the whole call — not 5 × perAttempt + backoffs.
    expect(elapsed).toBeLessThan(1500);
}, 10000);
