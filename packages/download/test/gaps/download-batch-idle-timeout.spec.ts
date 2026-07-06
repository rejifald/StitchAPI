// Pins THE FINDING core's download-slow-vs-stall.spec surfaced (no idle/forward-progress timeout in the
// engine — TimeoutOptions is all wall-clock) + P9, at the batch layer. `idleTimeout` resets on every
// onProgress chunk, so a DEAD stall is aborted (retryable IDLE_TIMEOUT) while a slow-but-progressing
// sibling SURVIVES — the distinction the wall-clock timeout cannot make. And a stalled item under
// concurrency times out ALONE: siblings finish with intact blobs.
//
// Real-timer, LOOSE bounds (a socket test): the idle timer runs on the default `systemClock`; the stall
// hold and chunk cadence are set with wide margins vs the idle window. Held sockets are force-destroyed
// at teardown.
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

const okValue = (r: ItemResult): DownloadResult => {
    if (r.status !== 'fulfilled')
        throw new Error(`expected fulfilled but got ${r.status}`);
    return r.value;
};
const asRejected = (
    r: ItemResult,
): Extract<ItemResult, { status: 'rejected' }> => {
    if (r.status !== 'rejected')
        throw new Error(`expected rejected but got ${r.status}`);
    return r;
};

test('a dead stall trips the idle timeout and is cut ALONE — siblings finish with intact blobs', async () => {
    server.route('GET', '/well-0', {
        statuses: [200],
        rawBody: 'well-0-body',
        ttfbDelayMs: 30,
    });
    server.route('GET', '/stalls', {
        statuses: [200],
        rawBody: 'x'.repeat(64),
        declaredLength: 64, // advertise 64…
        stallAfterBytes: 8, // …write 8, then hold the socket open forever
    });
    server.route('GET', '/well-1', {
        statuses: [200],
        rawBody: 'well-1-body',
        ttfbDelayMs: 30,
    });
    server.route('GET', '/well-2', {
        statuses: [200],
        rawBody: 'well-2-body',
        ttfbDelayMs: 30,
    });

    // The stall sits second → admitted in the first wave (K=2) alongside a healthy item; it then pins
    // one slot until its idle timeout while the other slot drains the rest.
    const results = await downloadAll(
        [
            { path: '/well-0' },
            { path: '/stalls' },
            { path: '/well-1' },
            { path: '/well-2' },
        ],
        {
            concurrency: 2,
            idleTimeout: 200,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
        },
    );

    expect(results.map((r) => r.status)).toEqual([
        'fulfilled', // well-0
        'rejected', // stalls → idle timeout
        'fulfilled', // well-1
        'fulfilled', // well-2
    ]);

    // The stall was cut by the IDLE timer (retryable), not resolved as a partial Blob.
    const stall = asRejected(results[1]!);
    expect(stall.code).toBe('IDLE_TIMEOUT');
    expect(stall.retryable).toBe(true);

    // Siblings' bytes are COMPLETE and uncorrupted — the stall did not distort their result.
    expect(await blobText(okValue(results[0]!).blob)).toBe('well-0-body');
    expect(await blobText(okValue(results[2]!).blob)).toBe('well-1-body');
    expect(await blobText(okValue(results[3]!).blob)).toBe('well-2-body');
});

test('a slow-but-alive stream SURVIVES an idle timeout that a dead stall trips', async () => {
    // slow: 60 bytes as 6 × 10-byte chunks, 40ms apart (~240ms streaming). Each gap (40ms) is well under
    // the 120ms idle window, so the timer keeps resetting and the item FINISHES.
    server.route('GET', '/slow', {
        statuses: [200],
        rawBody: 'x'.repeat(60),
        chunkBytes: 10,
        chunkDelayMs: 40,
    });
    // stall: write 8, then hold forever → no progress for > 120ms → trips.
    server.route('GET', '/stall', {
        statuses: [200],
        rawBody: 'y'.repeat(64),
        declaredLength: 64,
        stallAfterBytes: 8,
    });

    const results = await downloadAll([{ path: '/slow' }, { path: '/stall' }], {
        concurrency: 2,
        idleTimeout: 120,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    // slow-but-alive survived (bytes kept arriving); the dead stall tripped the same idle window.
    expect(results[0]!.status).toBe('fulfilled');
    expect(await blobText(okValue(results[0]!).blob)).toBe('x'.repeat(60));
    const stall = asRejected(results[1]!);
    expect(stall.code).toBe('IDLE_TIMEOUT');
});
