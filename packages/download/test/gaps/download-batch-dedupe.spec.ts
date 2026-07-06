// Pins P18 at the batch layer: the same-URL DEDUPE contract. Core's partial-failure spec DEFERRED this
// as "NEW batch-layer code (StitchAPI's only coalescing is cache-gated, and blobs are typically
// uncacheable); the batch API picks the contract (recommended default: independent fetches)". Here we
// prove BOTH sides with the server's hit-counter: default = two independent requests; `dedupe: true` =
// one in-flight request shared by both handles.
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

test('by DEFAULT, duplicate URLs are INDEPENDENT fetches — two requests on the wire', async () => {
    server.route('GET', '/dup', {
        statuses: [200],
        rawBody: 'dup-body',
        ttfbDelayMs: 40, // hold both slots open together so a dedupe (if any) would collapse them
    });
    const url = `${server.url}/dup`;

    const results = await downloadAll([{ url }, { url }], {
        concurrency: 2,
        defaults: { retry: { attempts: 1 } },
    });

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/dup')).toBe(2); // independent → two wire requests
    expect(await blobText(okValue(results[0]!).blob)).toBe('dup-body');
    expect(await blobText(okValue(results[1]!).blob)).toBe('dup-body');
});

test('dedupe:true collapses concurrent duplicate URLs onto ONE in-flight request', async () => {
    server.route('GET', '/dup', {
        statuses: [200],
        rawBody: 'dup-body',
        ttfbDelayMs: 40,
    });
    const url = `${server.url}/dup`;

    const results = await downloadAll([{ url }, { url }], {
        concurrency: 2,
        dedupe: true,
        defaults: { retry: { attempts: 1 } },
    });

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/dup')).toBe(1); // deduped → ONE wire request
    // Both handles resolved to the SAME underlying result (one fetch, shared).
    expect(await blobText(okValue(results[0]!).blob)).toBe('dup-body');
    expect(await blobText(okValue(results[1]!).blob)).toBe('dup-body');
    expect(okValue(results[0]!).blob).toBe(okValue(results[1]!).blob);
});
