// Pins docs/GAP-AUDIT.md §2.8: Configurable query array serialization: wire.array 'indices' | 'brackets' | 'repeat'
import { stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-query-array-format-${process.pid}.jsonl`,
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

/**
 * Capture the URL from the 'start' event emitted by a stitch stream.
 * This gives us the raw query string before URLSearchParams parsing loses
 * duplicate keys (repeat / brackets formats both produce duplicate keys).
 */
async function captureStartUrl(
    call: ReturnType<ReturnType<typeof stitch>>,
): Promise<string> {
    let startUrl = '';
    for await (const ev of call.stream()) {
        if (ev.type === 'start') {
            startUrl = ev.url;
        }
        // drain the stream fully
    }
    return startUrl;
}

describe('GAP-AUDIT §2.8 — configurable query array serialization', () => {
    // ── A. Default behavior: indices format ──────────────────────────────────
    // The current (and post-fix) default must stay indices: ids[0]=1&ids[1]=2.
    // This test is expected to be GREEN today and after the fix (it pins the
    // default contract).
    test('default wire.array is indices: ids%5B0%5D=1&ids%5B1%5D=2 on the wire', async () => {
        server.route('GET', '/array-default', { body: { ok: true } });
        const s = stitch({ baseUrl: server.url, path: '/array-default' });
        await s({ query: { ids: [1, 2] } });
        const q = server.calls('/array-default')[0]?.query ?? {};
        // ids[0] and ids[1] come back after URLSearchParams decodes percent-encoding
        expect(q['ids[0]']).toBe('1');
        expect(q['ids[1]']).toBe('2');
        // repeat key must NOT be present under the default
        expect(q['ids']).toBeUndefined();
    });

    // ── B. repeat format: ids=1&ids=2 ───────────────────────────────────────
    // With wire.array:'repeat', each array item gets its own key=value pair
    // with no brackets at all.  URLSearchParams collapses duplicate keys in the
    // server's query Record, so we assert on the raw URL from the 'start' event.
    test("wire.array:'repeat' serialises arrays as repeated bare keys (ids=1&ids=2)", async () => {
        server.route('GET', '/array-repeat', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/array-repeat',
            wire: { array: 'repeat' },
        });
        const url = await captureStartUrl(s({ query: { ids: [1, 2] } }));
        const search = new URLSearchParams(new URL(url).search);
        // Both values must be present under the bare key 'ids'
        expect(search.getAll('ids')).toEqual(['1', '2']);
        // No bracket variants should appear
        expect(search.has('ids[0]')).toBe(false);
        expect(search.has('ids[]')).toBe(false);
    });

    // ── C. brackets format: ids[]=1&ids[]=2 ─────────────────────────────────
    // With wire.array:'brackets', each array item gets the bracket suffix []
    // with no numeric index.  [] is percent-encoded on the wire exactly like the
    // current indices format encodes [0]/[1]: as %5B%5D.
    test("wire.array:'brackets' serialises arrays as ids%5B%5D=1&ids%5B%5D=2", async () => {
        server.route('GET', '/array-brackets', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/array-brackets',
            wire: { array: 'brackets' },
        });
        const url = await captureStartUrl(s({ query: { ids: [1, 2] } }));
        const search = new URLSearchParams(new URL(url).search);
        // Both values must be present under the bracket key 'ids[]'
        expect(search.getAll('ids[]')).toEqual(['1', '2']);
        // No numeric-index or bare-key variants should appear
        expect(search.has('ids[0]')).toBe(false);
        expect(search.has('ids')).toBe(false);
    });
});
