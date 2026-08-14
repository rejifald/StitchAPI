// Pins P4 (download-test-rig-spec §2.8): across a batch of INDEPENDENT downloads sharing a throttle,
// each call SETTLES ON ITS OWN — one bad URL (a 404, or a mid-body RST) never fails the others, and a
// successful item's bytes are complete and uncorrupted despite failing siblings sharing the budget.
//
// This is the isolation property the future @stitchapi/download batch API MUST preserve: a naive
// `Promise.all` over the calls would reject the WHOLE batch on the first failure; a batch downloader
// has to be per-item (the `Promise.allSettled` shape modelled here). We pin it at the raw
// download()+throttle layer so the batch API inherits an already-proven substrate — the two failure
// MODES compose with concurrency, not just in isolation.
//
// Deferred (an orchestrator CONTRACT, not a property of raw download()): same-URL DEDUPE (P18) —
// whether enqueuing the same URL twice reuses one in-flight fetch or runs two independent ones.
// StitchAPI's only coalescing is cache-gated (and download blobs are typically uncacheable), so a
// dedupe map is NEW batch-layer code; every call here is independent by construction. The batch API
// picks the contract (recommended default: independent fetches) and a future spec pins whichever.
import { download } from '../../src/download';
import type { DownloadResult } from '../../src/download';
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

// A mixed batch: good / 404 / good / RST / good — failures interleaved with successes, all sharing one
// host-keyed budget of 2. `ok` items hold briefly so the batch genuinely overlaps failures & successes
// under the gate (isolation must survive real concurrency, not just a serial run).
const ITEMS = [
    { path: '/ok-0', kind: 'ok' as const },
    { path: '/bad-404', kind: 'notfound' as const },
    { path: '/ok-1', kind: 'ok' as const },
    { path: '/bad-rst', kind: 'reset' as const },
    { path: '/ok-2', kind: 'ok' as const },
];

test('a partial-failure batch settles per-item — one bad URL never fails the others (404 + RST isolated)', async () => {
    for (const it of ITEMS) {
        if (it.kind === 'ok')
            server.route('GET', it.path, {
                statuses: [200],
                rawBody: `ok-body${it.path}`,
                ttfbDelay: 60,
            });
        else if (it.kind === 'notfound')
            server.route('GET', it.path, {
                statuses: [404],
                body: { error: 'not_found' },
            });
        else
            server.route('GET', it.path, {
                statuses: [200],
                rawBody: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', // 36 bytes advertised…
                declaredLength: 36,
                resetAfterBytes: 6, // …only 6 written, then a real ECONNRESET mid-body
            });
    }

    const calls = ITEMS.map((it) =>
        download({
            baseUrl: server.url,
            path: it.path,
            throttle: { concurrency: 2, pool: 'host' },
            retry: { attempts: 1 }, // failures terminal — no backoff to wait on
        }),
    );

    // Per-item settling — the batch shape a downloader must use (NOT `Promise.all`, which would
    // collapse on the first reject).
    const settled = await Promise.allSettled(calls.map((c) => c()));

    // Each item settled strictly on its OWN outcome; a sibling's failure never leaked across.
    expect(settled.map((s) => s.status)).toEqual([
        'fulfilled', // ok-0
        'rejected', // bad-404
        'fulfilled', // ok-1
        'rejected', // bad-rst
        'fulfilled', // ok-2
    ]);

    // The successful items carry their COMPLETE, correct bytes — not truncated or cross-contaminated
    // by the failing siblings that shared the throttle budget.
    for (const i of [0, 2, 4]) {
        const r = settled[i] as PromiseFulfilledResult<DownloadResult>;
        expect(await blobText(r.value.blob)).toBe(`ok-body${ITEMS[i]!.path}`);
    }

    // The failures are Errors, each its OWN distinct terminal shape — a 404 (engine throws `HTTP 404`
    // before interpret) and a transport RST (undici "fetch failed") — never a resolved partial Blob.
    const err404 = (settled[1] as PromiseRejectedResult).reason as Error;
    const errRst = (settled[3] as PromiseRejectedResult).reason as Error;
    expect(err404).toBeInstanceOf(Error);
    expect(err404.message).toMatch(/404/);
    expect(errRst).toBeInstanceOf(Error);
    expect(errRst.message).toMatch(/fetch failed/i);

    // All five requests reached the server — the gate paced them, it didn't drop the failing ones.
    expect(server.callCount()).toBe(ITEMS.length);
});
