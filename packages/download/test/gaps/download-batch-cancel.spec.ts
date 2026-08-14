// Pins P10/P11/P12/P13 at the batch layer — the cancellation surface core's download-concurrency-
// stall-isolation.spec explicitly DEFERRED ("properties of a batch controller's AbortSignal wiring, not
// of a single download() call"):
//   • cancel ONE in-flight → only it aborts; its slot returns to the FIFO queue (P10).
//   • cancel a QUEUED item → frees no slot, never hits the wire, doesn't skip the next (P11).
//   • CANCEL-ALL → every in-flight aborts, the queue drains (P12), and the pooled `pool:'host'` budget
//     is left CLEAN — a later batch to the same host isn't starved (P13).
//
// Real-timer, LOOSE bounds (a socket test): a long `ttfbDelay` holds the "in-flight" item so the
// cancel lands while it is genuinely active; no wall-clock duration is asserted. Held sockets are
// force-destroyed at teardown.
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
const byId = (results: ItemResult[]): Map<ItemResult['id'], ItemResult> =>
    new Map(results.map((r) => [r.id, r]));

test('cancel ONE in-flight item — only it aborts; its slot returns to the queue for the next item (P10)', async () => {
    // concurrency 1: A is admitted (in-flight, held long), B & C queued. Cancelling A frees its slot.
    server.route('GET', '/a', {
        statuses: [200],
        rawBody: 'a-body',
        ttfbDelay: 2000,
    });
    server.route('GET', '/b', { statuses: [200], rawBody: 'b-body' });
    server.route('GET', '/c', { statuses: [200], rawBody: 'c-body' });

    const started: string[] = [];
    const batch = downloadAll(
        [
            { path: '/a', id: 'a' },
            { path: '/b', id: 'b' },
            { path: '/c', id: 'c' },
        ],
        {
            concurrency: 1,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
            onItemStart: (id) => {
                started.push(id as string);
            },
        },
    );

    // A is active synchronously; cancel it. Its slot returns to FIFO → B (then C) run.
    batch.cancel('a');
    const map = byId(await batch);

    expect(map.get('a')!.status).toBe('cancelled');
    expect(map.get('b')!.status).toBe('fulfilled');
    expect(map.get('c')!.status).toBe('fulfilled');
    // B & C could only START once A's slot freed (concurrency 1) → proof the slot returned to the queue.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(await blobText(okValue(map.get('b')!).blob)).toBe('b-body');
});

test('cancel a QUEUED item — frees no slot, never hits the wire, does not skip the next (P11)', async () => {
    // concurrency 1: A in-flight (finishes normally), B queued (cancelled), C queued (must still run).
    server.route('GET', '/a', {
        statuses: [200],
        rawBody: 'a-body',
        ttfbDelay: 60,
    });
    server.route('GET', '/b', { statuses: [200], rawBody: 'b-body' });
    server.route('GET', '/c', { statuses: [200], rawBody: 'c-body' });

    const started: string[] = [];
    const batch = downloadAll(
        [
            { path: '/a', id: 'a' },
            { path: '/b', id: 'b' },
            { path: '/c', id: 'c' },
        ],
        {
            concurrency: 1,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
            onItemStart: (id) => {
                started.push(id as string);
            },
        },
    );

    // B is queued (A holds the only slot). Cancel B while it is still queued.
    batch.cancel('b');
    const map = byId(await batch);

    expect(map.get('a')!.status).toBe('fulfilled');
    expect(map.get('b')!.status).toBe('cancelled');
    expect(map.get('c')!.status).toBe('fulfilled'); // C was NOT skipped
    // B never started; A then C ran (B dropped from the queue without consuming a slot).
    expect(started).toEqual(['a', 'c']);
    expect(server.callCount('/b')).toBe(0);
});

test('CANCEL-ALL aborts every in-flight + drains the queue; the host pool is left clean (P12/P13)', async () => {
    for (const p of ['/x0', '/x1', '/x2', '/x3'])
        server.route('GET', p, {
            statuses: [200],
            rawBody: `body${p}`,
            ttfbDelay: 500, // all hold, so 2 are in-flight and 2 are queued when we cancel
        });

    const batch = downloadAll(
        ['/x0', '/x1', '/x2', '/x3'].map((p) => ({ path: p })),
        {
            concurrency: 2,
            defaults: {
                baseUrl: server.url,
                throttle: { concurrency: 2, pool: 'host' },
                retry: { attempts: 1 },
            },
        },
    );

    batch.cancel();
    const results = await batch;
    // Every item cancelled (2 in-flight aborted + 2 queued drained), promptly — no hang.
    expect(results.every((r) => r.status === 'cancelled')).toBe(true);

    // P13: a FRESH batch to the same host reaches full concurrency (2 open on the wire) — the engine's
    // pool:'host' budget was released on abort, not leaked. reset() gives the probe a clean baseline
    // (and, per the M5 fix, leaves idle keep-alive sockets alive so the next request isn't a stale one).
    server.reset();
    for (const p of ['/y0', '/y1', '/y2', '/y3'])
        server.route('GET', p, {
            statuses: [200],
            rawBody: `body${p}`,
            ttfbDelay: 120,
        });

    const results2 = await downloadAll(
        ['/y0', '/y1', '/y2', '/y3'].map((p) => ({ path: p })),
        {
            concurrency: 2,
            defaults: {
                baseUrl: server.url,
                throttle: { concurrency: 2, pool: 'host' },
                retry: { attempts: 1 },
            },
        },
    );
    expect(results2.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.maxOpen()).toBe(2); // reached full concurrency → the pool budget was left clean
});
