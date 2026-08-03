// ADR 0005 Decision 6 finished for the `form` arm. Decision 6 named the bug — "`encodeRequestBody`
// / `appendForm` currently iterate top-level keys only, so a nested object becomes
// `[object Object]`" — and fixed it for `multipart` via `multipart.nesting`, leaving the
// urlencoded `form` arm on the broken path with no escape hatch. Both urlencoded surfaces (the
// query string and a `wire.body: 'form'` body) now run ONE walker, so a single `wire.array`
// governs both and nested objects expand `qs`-style on each.
import { stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

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

/** POST `body` as a form and hand back the raw urlencoded wire string. */
async function formWire(
    body: Record<string, unknown>,
    array?: 'indices' | 'brackets' | 'repeat',
): Promise<string> {
    server.route('POST', '/form', { body: { ok: true } });
    const post = stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/form',
        wire: { body: 'form' as const, ...(array ? { array } : {}) },
    });
    await post({ body });
    return String(server.calls('/form')[0]?.body);
}

describe('form bodies serialise through the shared urlencoded walker', () => {
    // ── The bug Decision 6 named, on the arm it was never applied to ─────────
    test('a nested object expands to a[b]=c, never [object Object]', async () => {
        const raw = await formWire({ page: { size: 10 } });
        const params = new URLSearchParams(raw);

        expect(params.get('page[size]')).toBe('10');
        expect(raw).not.toContain('object');
    });

    test('nesting recurses to arbitrary depth', async () => {
        const params = new URLSearchParams(
            await formWire({ a: { b: { c: 1 } } }),
        );
        expect(params.get('a[b][c]')).toBe('1');
    });

    // ── One `arrayFormat` now governs BOTH urlencoded surfaces ───────────────
    test("default is 'indices', matching the query string's default", async () => {
        const params = new URLSearchParams(await formWire({ ids: [1, 2] }));
        expect(params.get('ids[0]')).toBe('1');
        expect(params.get('ids[1]')).toBe('2');
        expect(params.has('ids')).toBe(false);
    });

    test("arrayFormat: 'brackets' applies to a form body", async () => {
        const params = new URLSearchParams(
            await formWire({ ids: [1, 2] }, 'brackets'),
        );
        expect(params.getAll('ids[]')).toEqual(['1', '2']);
        expect(params.has('ids[0]')).toBe(false);
    });

    test("arrayFormat: 'repeat' applies to a form body", async () => {
        const params = new URLSearchParams(
            await formWire({ ids: [1, 2] }, 'repeat'),
        );
        expect(params.getAll('ids')).toEqual(['1', '2']);
        expect(params.has('ids[0]')).toBe(false);
    });

    // ── What the shared walker must NOT change about form bodies ─────────────
    test('a space stays `+`-encoded in a form body (not %20)', async () => {
        const raw = await formWire({ q: 'a b' });
        expect(raw).toBe('q=a+b');
        // …while the query string keeps `%20` for the same value — both round-trip.
        expect(new URLSearchParams(raw).get('q')).toBe('a b');
    });

    test('reserved characters still round-trip', async () => {
        const raw = await formWire({ password: 'p@ss & word' });
        expect(new URLSearchParams(raw).get('password')).toBe('p@ss & word');
    });

    test('null and undefined leaves are skipped, as in the query string', async () => {
        const params = new URLSearchParams(
            await formWire({ a: null, b: undefined, c: 1 }),
        );
        expect(params.has('a')).toBe(false);
        expect(params.has('b')).toBe(false);
        expect(params.get('c')).toBe('1');
    });

    test('a Date leaf serialises as an ISO string, as in the query string', async () => {
        const raw = await formWire({ since: new Date('2026-08-03T00:00:00Z') });
        expect(new URLSearchParams(raw).get('since')).toBe(
            '2026-08-03T00:00:00.000Z',
        );
    });

    // ── The two urlencoded surfaces agree, which is the point ────────────────
    test('query string and form body agree on keys for the same value', async () => {
        const value = { ids: [1, 2], page: { size: 10 } };

        const bodyKeys = [
            ...new URLSearchParams(await formWire(value)).keys(),
        ].sort();

        server.reset();
        server.route('GET', '/q', { body: { ok: true } });
        const get = stitch({ baseUrl: server.url, path: '/q' });
        await get({ query: value });
        const queryKeys = Object.keys(
            server.calls('/q')[0]?.query ?? {},
        ).sort();

        expect(bodyKeys).toEqual(queryKeys);
    });
});
