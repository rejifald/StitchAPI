// Pins (THE FINDING): a HEALTHY-but-slow download — one whose bytes keep arriving, just slowly — is
// killed by the SAME wall-clock `timeout` as a dead stall. The engine's `TimeoutOptions` is
// `{ total, perAttempt }`, BOTH wall-clock (types.ts:317); there is NO idle / forward-progress /
// no-bytes-for-N-ms timeout. So once total elapsed exceeds the budget, the call rejects even though
// the transfer was making steady forward progress the whole time — indistinguishable, to the engine,
// from a socket that stalled at byte 0.
//
// This test proves the body was HEALTHY (progressing), not stalled, by threading an `onProgress`
// callback: it records a strictly-increasing `loaded` across several chunks BEFORE the timeout
// reject. A stall (download-stall.spec.ts) would show `loaded` frozen; here it climbs, then the call
// still fails — that is the finding.
//
// DESIGN FINDING, NOT A BUG TO FIX NOW: this motivates an IDLE / forward-progress timeout — one that
// resets its countdown on each `onProgress` chunk, so a slow-but-progressing transfer is allowed to
// continue while only a genuine no-bytes stall trips it. The engine lacks that today (only wall-clock
// total/perAttempt). A future `@stitchapi/download` should add an idle-timeout option layered on the
// `onProgress` byte stream. No `src/` change is made here — this pins present behavior and documents
// the gap.
//
// Real-timer, LOOSE bounds (a socket test): chunk cadence (120ms × 8 = ~960ms of streaming) is set
// well above the 400ms budget so the timeout reliably fires mid-stream after a few progress ticks,
// with wide margins against scheduler jitter. `chunkDelayMs` streams a real chunked body; teardown
// force-destroys any lingering socket (mock-server tracks live sockets), so the suite exits.
import { download } from '../../src/download';
import type { AdapterProgress } from '../../src/types';
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

// 64 bytes streamed as 8 chunks of 8 bytes, 120ms apart (~960ms total) — a steady trickle. A 400ms
// budget cuts it after ~3 chunks. The body is HEALTHY (bytes flowing), yet the wall-clock timeout
// kills it anyway; `onProgress` proves the progress was real before the reject.
test('a healthy-but-slow (steadily progressing) download is killed by the same wall-clock timeout as a stall', async () => {
    server.route('GET', '/trickle', {
        statuses: [200],
        rawBody:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
        chunkBytes: 8, // 8 bytes per chunk…
        chunkDelayMs: 120, // …every 120ms → ~960ms to stream the whole body
    });

    const seen: AdapterProgress[] = [];
    const getTrickle = download({
        baseUrl: server.url,
        path: '/trickle',
        timeout: 400, // ≡ { total: 400 } — wall-clock; no idle/progress timeout exists
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getTrickle({
        onProgress: (p) => {
            seen.push(p);
        },
    }).then(
        () => {
            throw new Error(
                'slow-but-progressing download unexpectedly resolved',
            );
        },
        (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    // It REJECTED (the wall-clock budget fired), promptly, and cut by the timeout — not resolved.
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(5000);
    expect((err as Error).message).toMatch(/timeout|timed out|abort|aborted/i);

    // …and it was HEALTHY, not stalled: progress fired and `loaded` climbed across chunks BEFORE the
    // reject. This is the evidence that a *progressing* transfer — not a dead one — was killed by the
    // wall-clock timeout, which is exactly the finding an idle/forward-progress timeout would fix.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((p) => p.phase === 'download')).toBe(true);
    const loaded = seen.map((p) => p.loaded);
    const lastLoaded = loaded[loaded.length - 1] ?? 0;
    const firstLoaded = loaded[0] ?? 0;
    expect(lastLoaded).toBeGreaterThan(firstLoaded); // strictly increasing → real forward progress
    // Non-decreasing throughout (a chunked read only ever adds bytes).
    for (let i = 1; i < loaded.length; i++)
        expect(loaded[i]!).toBeGreaterThanOrEqual(loaded[i - 1]!);
});
