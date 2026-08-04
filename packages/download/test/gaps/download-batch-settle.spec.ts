// Pins P4 at the batch API: downloadAll SETTLES PER ITEM — one bad URL (a 404, or a mid-body RST) never
// fails the others, and the returned promise NEVER rejects (unlike `Promise.all`, which would collapse
// on the first reject). Core's download-concurrency-partial-failure.spec proved this on the raw
// download()+throttle substrate and DEFERRED making it the batch API's contract. Results come back in
// ENQUEUE ORDER; each failure carries a classification.
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

// A mixed batch: good / 404 / good / RST / good — failures interleaved with successes, all sharing one
// budget of 2, so isolation must survive real concurrency (not just a serial run).
const ITEMS = [
    { path: '/ok-0', kind: 'ok' },
    { path: '/bad-404', kind: 'notfound' },
    { path: '/ok-1', kind: 'ok' },
    { path: '/bad-rst', kind: 'reset' },
    { path: '/ok-2', kind: 'ok' },
] as const;

test('downloadAll settles per item and never rejects — a 404 + a RST are isolated from successes', async () => {
    for (const it of ITEMS) {
        if (it.kind === 'ok')
            server.route('GET', it.path, {
                statuses: [200],
                rawBody: `ok${it.path}`,
                ttfbDelay: 40,
            });
        else if (it.kind === 'notfound')
            server.route('GET', it.path, {
                statuses: [404],
                body: { error: 'not_found' },
            });
        else
            server.route('GET', it.path, {
                statuses: [200],
                rawBody: 'ABCDEFGHIJKLMNOP', // 16 bytes advertised…
                declaredLength: 16,
                resetAfterBytes: 4, // …only 4 written, then a real ECONNRESET mid-body
            });
    }

    // Awaiting the batch RESOLVES (never throws) even though two items fail terminally.
    const results = await downloadAll(
        ITEMS.map((it) => ({ path: it.path })),
        {
            concurrency: 2,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
        },
    );

    // Each item settled strictly on its OWN outcome, in enqueue order.
    expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
        'fulfilled',
    ]);

    // Successful items carry their COMPLETE, uncorrupted bytes despite failing siblings sharing the run.
    expect(await blobText(okValue(results[0]!).blob)).toBe('ok/ok-0');
    expect(await blobText(okValue(results[2]!).blob)).toBe('ok/ok-1');
    expect(await blobText(okValue(results[4]!).blob)).toBe('ok/ok-2');

    // The failures are classified: a terminal 404, and a retryable transport RST (undici "fetch failed").
    const e404 = asRejected(results[1]!);
    expect(e404.retryable).toBe(false);
    expect(e404.code).toBe('HTTP_404');

    const eRst = asRejected(results[3]!);
    expect(eRst.retryable).toBe(true);
    expect(eRst.code).toBeDefined();
    expect(eRst.reason.message).toMatch(/fetch failed/i);

    expect(server.callCount()).toBe(ITEMS.length);
});
