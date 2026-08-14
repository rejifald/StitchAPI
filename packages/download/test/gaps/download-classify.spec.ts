// Pins finding #2 (the engine DROPS the transport `.cause` before a caller sees it — the
// download-reset-midbody finding — so a RST is indistinguishable from a generic 'fetch failed').
// @stitchapi/download recovers it: a per-item `hooks.onError` seam captures the RAW transport error
// BEFORE the engine flattens it, and each rejection is classified — retryable-vs-terminal + a
// best-effort machine `code`. Real sockets (mock-server + the hostile-net raw-socket hatch) so the
// codes are genuine, not mocked.
import { downloadAll } from '../../src';
import type { ItemResult } from '../../src';
import { unusedPort } from '../support/hostile-net';
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

const asRejected = (
    r: ItemResult,
): Extract<ItemResult, { status: 'rejected' }> => {
    if (r.status !== 'rejected')
        throw new Error(`expected rejected but got ${r.status}`);
    return r;
};

test('a mid-body RST is retryable with a transport code; a 404 is terminal (HTTP_404)', async () => {
    server.route('GET', '/rst', {
        statuses: [200],
        rawBody: 'ABCDEFGHIJKLMNOP',
        declaredLength: 16,
        resetAfterBytes: 4, // real ECONNRESET mid-body
    });
    server.route('GET', '/404', {
        statuses: [404],
        body: { error: 'nope' },
    });

    const results = await downloadAll([{ path: '/rst' }, { path: '/404' }], {
        concurrency: 2,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    // The RST: the raw undici error (captured via hooks.onError) carries a transport code the flattened
    // StitchError does not — so we classify it retryable even though its message is just "fetch failed".
    const rst = asRejected(results[0]!);
    expect(rst.retryable).toBe(true);
    expect(rst.code).toBeDefined();
    expect(rst.reason.message).toMatch(/fetch failed/i);

    // The 404: a response-level failure → terminal, coded from its status.
    const e404 = asRejected(results[1]!);
    expect(e404.retryable).toBe(false);
    expect(e404.code).toBe('HTTP_404');
});

test('ECONNREFUSED (nothing listening) is classified retryable', async () => {
    const port = await unusedPort();

    const results = await downloadAll([{ url: `http://127.0.0.1:${port}/x` }], {
        concurrency: 1,
        defaults: { retry: { attempts: 1 } },
    });

    const refused = asRejected(results[0]!);
    expect(refused.retryable).toBe(true);
    // The connect refusal surfaces its code (ECONNREFUSED) via the captured cause chain, or at least a
    // transport-shaped message — never a terminal classification.
    expect(refused.code ?? refused.reason.message).toMatch(
        /ECONNREFUSED|refused|fetch failed/i,
    );
});
