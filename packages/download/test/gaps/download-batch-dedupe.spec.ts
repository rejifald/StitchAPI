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
const byId = (results: ItemResult[]): Map<ItemResult['id'], ItemResult> =>
    new Map(results.map((r) => [r.id, r]));

const tick = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

// The server sees a client abort when the SOCKET closes — a real network event, not synchronous
// with `cancel()`. Poll for it rather than guessing a sleep.
const waitFor = async (
    ready: () => boolean,
    what: string,
    timeoutMs = 2000,
): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await tick(10);
    }
};

// The other half of the ref-count claim is a NEGATIVE — the wire must stay open. Watch it for a
// window instead: an abort that was going to land lands within a socket close, far inside this.
const staysOpen = async (
    openNow: () => number,
    forMs: number,
): Promise<void> => {
    const deadline = Date.now() + forMs;
    while (Date.now() < deadline) {
        expect(openNow()).toBe(1);
        await tick(10);
    }
};

test('by DEFAULT, duplicate URLs are INDEPENDENT fetches — two requests on the wire', async () => {
    server.route('GET', '/dup', {
        statuses: [200],
        rawBody: 'dup-body',
        ttfbDelay: 40, // hold both slots open together so a dedupe (if any) would collapse them
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
        ttfbDelay: 40,
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

// ---- #455: resolved-URL keys ------------------------------------------------------------------
// v1 keyed off `item.url` / an explicit `id`, so two items that spell ONE endpoint differently were
// two keys and two requests. The key is the RESOLVED target now — `defaults.baseUrl` + `path`, query
// canonicalised — so "same request?" is answered by what goes on the wire, not by how it was typed.

test('dedupe keys off the RESOLVED target — two `{ path }` items under one `baseUrl` collapse', async () => {
    server.route('GET', '/shared', {
        statuses: [200],
        rawBody: 'shared-body',
        ttfbDelay: 40, // hold both slots open together, so a dedupe can collapse them
    });

    // Neither item carries a `url` and neither carries an `id`: under the v1 key both fell back to
    // their ENQUEUE INDEX ('0' and '1') — two keys, two fetches.
    const results = await downloadAll(
        [{ path: '/shared' }, { path: '/shared' }],
        {
            concurrency: 2,
            dedupe: true,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
        },
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/shared')).toBe(1); // ONE wire request
    expect(await blobText(okValue(results[0]!).blob)).toBe('shared-body');
    expect(okValue(results[0]!).blob).toBe(okValue(results[1]!).blob);
});

test('the key is canonical: one query written in two orders is ONE request', async () => {
    server.route('GET', '/q', {
        statuses: [200],
        rawBody: 'q-body',
        ttfbDelay: 40,
    });

    const results = await downloadAll(
        [{ path: '/q?a=1&b=2' }, { path: '/q?b=2&a=1' }],
        {
            concurrency: 2,
            dedupe: true,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
        },
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/q')).toBe(1);
});

test('an explicit `id` still outranks the URL — two ids never share one fetch', async () => {
    server.route('GET', '/split', {
        statuses: [200],
        rawBody: 'split-body',
        ttfbDelay: 40,
    });

    // Same resolved target, but the caller named them apart. An `id` is a deliberate identity claim
    // and it is still what dedupe keys off first, so these stay two independent downloads.
    const results = await downloadAll(
        [
            { path: '/split', id: 'left' },
            { path: '/split', id: 'right' },
        ],
        {
            concurrency: 2,
            dedupe: true,
            defaults: { baseUrl: server.url, retry: { attempts: 1 } },
        },
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/split')).toBe(2);
});

// ---- #455: ref-counted sharers ----------------------------------------------------------------
// v1 shared a bare promise: cancelling a FOLLOWER only detached it (the fetch ran on, and the
// follower still settled 'fulfilled' when it finished), and cancelling the LEADER aborted the one
// request everybody was waiting on, failing the followers. The sharers are ref-counted now.
//
// These pin the CANCEL half on its own, so they carry a repeated explicit `id`: that keyed one
// shared fetch under v1 too, which is what makes a v1 leader/follower pair to cancel. (A repeated
// id is the group's key; the per-item id is disambiguated by enqueue index, so the pair answers to
// 'dup' and 1.) Both are admitted synchronously — `downloadAll` adds in a loop and concurrency is 2
// — so by the time it returns, the second has already joined the first's fetch.
const dup = (path: string): { path: string; id: string } => ({
    path,
    id: 'dup',
});

test('cancelling a FOLLOWER leaves the shared fetch running — the leader still settles ok', async () => {
    server.route('GET', '/hold', {
        statuses: [200],
        rawBody: 'hold-body',
        ttfbDelay: 150,
    });

    const batch = downloadAll([dup('/hold'), dup('/hold')], {
        concurrency: 2,
        dedupe: true,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    batch.cancel(1); // the FOLLOWER
    const map = byId(await batch);

    expect(map.get(1)!.status).toBe('cancelled'); // it really is cancelled, not quietly fulfilled
    expect(map.get('dup')!.status).toBe('fulfilled'); // and the leader is untouched
    expect(await blobText(okValue(map.get('dup')!).blob)).toBe('hold-body');
    expect(server.callCount('/hold')).toBe(1);
});

test('cancelling the LEADER does NOT fail its followers — the fetch survives its opener', async () => {
    server.route('GET', '/hold', {
        statuses: [200],
        rawBody: 'hold-body',
        ttfbDelay: 150,
    });

    const batch = downloadAll([dup('/hold'), dup('/hold')], {
        concurrency: 2,
        dedupe: true,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    batch.cancel('dup'); // the LEADER — the item that actually opened the request
    const map = byId(await batch);

    expect(map.get('dup')!.status).toBe('cancelled');
    expect(map.get(1)!.status).toBe('fulfilled'); // NOT rejected: it never asked to be cancelled
    expect(await blobText(okValue(map.get(1)!).blob)).toBe('hold-body');
    expect(server.callCount('/hold')).toBe(1);
});

test('the shared request aborts only when the LAST sharer cancels', async () => {
    server.route('GET', '/hold3', {
        statuses: [200],
        rawBody: 'hold3-body',
        ttfbDelay: 1500, // long enough that nothing here races the response
    });

    const batch = downloadAll([dup('/hold3'), dup('/hold3'), dup('/hold3')], {
        concurrency: 3,
        dedupe: true,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    await waitFor(
        () => server.openNow('/hold3') === 1,
        'the shared request to reach the wire',
    );

    batch.cancel('dup'); // the leader goes first — the group is handed to a survivor
    batch.cancel(1);
    // Two refs dropped, one to go: the bytes are still coming for whoever is left.
    await staysOpen(() => server.openNow('/hold3'), 150);

    batch.cancel(2); // the LAST sharer — only now is there nobody left to abort for
    await waitFor(
        () => server.openNow('/hold3') === 0,
        'the shared request to abort',
    );

    const results = await batch;
    expect(results.every((r) => r.status === 'cancelled')).toBe(true);
    expect(server.callCount('/hold3')).toBe(1);
});

test('the `idle` window follows the group to the survivor when the leader cancels', async () => {
    // A slow-but-ALIVE shared stream: chunks every 40ms under a 120ms forward-progress window, so it
    // survives only while its chunks keep resetting that window. Cancelling the leader hands the
    // group on, and the bytes have to keep reaching whoever holds it now — a watchdog left pointing
    // at the settled leader would stop being reset and cut a download that is plainly progressing.
    server.route('GET', '/drip', {
        statuses: [200],
        headers: { 'content-type': 'application/octet-stream' },
        stream: { chunks: ['a', 'b', 'c', 'd', 'e', 'f'], chunkDelay: 40 },
    });

    const batch = downloadAll([dup('/drip'), dup('/drip')], {
        concurrency: 2,
        dedupe: true,
        idle: 120,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    batch.cancel('dup'); // the leader leaves; the follower inherits the fetch AND its idle window
    const map = byId(await batch);

    expect(map.get('dup')!.status).toBe('cancelled');
    expect(map.get(1)!.status).toBe('fulfilled'); // not cut by a stale IDLE_TIMEOUT
    expect(await blobText(okValue(map.get(1)!).blob)).toBe('abcdef');
});

// ---- #455: the scope line ---------------------------------------------------------------------

test('dedupe collapses only items IN FLIGHT TOGETHER — a finished result is never replayed', async () => {
    server.route('GET', '/seq', { statuses: [200], rawBody: 'seq-body' });

    // concurrency 1: the second item is admitted only once the first has SETTLED, so there is no
    // in-flight fetch left to join. Pinning the documented limit — dedupe is in-flight coalescing,
    // not a cache, and a just-finished blob is not replayed into a short window. (v1 leaked a
    // one-microtask window here: settling is what pumps the queue, and the key outlived it.)
    const results = await downloadAll([dup('/seq'), dup('/seq')], {
        concurrency: 1,
        dedupe: true,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(server.callCount('/seq')).toBe(2);
});

test('a FAILED shared fetch is not inherited by an item admitted after it — the wire is retried', async () => {
    // The sharper edge of that same window: the item admitted BY the leader's settlement used to
    // find the leader's key still registered and adopt its REJECTION — a 404 for a request it never
    // sent, which is how a batch stops actually retrying. Two 404s is the honest answer; one is the leak.
    server.route('GET', '/gone', { statuses: [404, 404], rawBody: 'nope' });

    const results = await downloadAll([dup('/gone'), dup('/gone')], {
        concurrency: 1,
        dedupe: true,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(server.callCount('/gone')).toBe(2);
});
