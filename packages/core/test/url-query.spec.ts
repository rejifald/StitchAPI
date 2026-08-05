import { stitch } from '../src';
import {
    appendQueryString,
    buildQuery,
    expandPath,
    topLevelQueryIndex,
} from '../src/util';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-url-query-${process.pid}.jsonl`,
);

// ---- RFC 6570 template expansion (Level 1–4) ------------------------------
describe('expandPath (RFC 6570)', () => {
    test('simple expansion encodes reserved characters', () => {
        expect(expandPath('/users/{id}', { id: 42 })).toBe('/users/42');
        expect(expandPath('/q/{term}', { term: 'a b/c' })).toBe('/q/a%20b%2Fc');
        expect(expandPath('/a/{x}/{y}', { x: 1, y: 2 })).toBe('/a/1/2');
    });

    test('reserved (+) and fragment (#) operators pass reserved chars through', () => {
        expect(expandPath('/files/{+path}', { path: 'a/b/c.txt' })).toBe(
            '/files/a/b/c.txt',
        );
        expect(expandPath('{#section}', { section: 'a/b' })).toBe('#a/b');
    });

    test('label, path-segment and path-style operators', () => {
        expect(expandPath('{.ext}', { ext: 'json' })).toBe('.json');
        expect(expandPath('/base{/a,b}', { a: 'x', b: 'y' })).toBe('/base/x/y');
        expect(expandPath('{;k}', { k: 'v' })).toBe(';k=v');
        expect(expandPath('{;empty}', { empty: '' })).toBe(';empty');
    });

    test('query and continuation operators with empty + missing vars', () => {
        expect(expandPath('/s{?a,b}', { a: '1', b: '2' })).toBe('/s?a=1&b=2');
        expect(expandPath('/s{?a,b}', { a: '1' })).toBe('/s?a=1');
        expect(expandPath('/s{?a}{&b}', { a: '1', b: '2' })).toBe('/s?a=1&b=2');
        expect(expandPath('/s{?a}', { a: '' })).toBe('/s?a=');
    });

    test('explode (*), prefix (:n), and list/object collapse', () => {
        expect(expandPath('{/list*}', { list: ['a', 'b'] })).toBe('/a/b');
        expect(expandPath('{?ids*}', { ids: [1, 2] })).toBe('?ids=1&ids=2');
        expect(expandPath('/{token:3}', { token: 'abcdef' })).toBe('/abc');
        expect(expandPath('/{list}', { list: ['a', 'b'] })).toBe('/a,b');
        expect(expandPath('/{obj}', { obj: { a: 1, b: 2 } })).toBe('/a,1,b,2');
    });

    test('missing variables and literals', () => {
        expect(expandPath('/users/{id}', {})).toBe('/users/');
        expect(expandPath('/a b/{id}', { id: 1 })).toBe('/a%20b/1');
        expect(expandPath('https://h.io/x/{id}', { id: 1 })).toBe(
            'https://h.io/x/1',
        );
    });

    // Regression: a `bigint` var used to match none of the scalar `typeof` arms and fell through to
    // the object arm, where `Object.entries(1n)` is `[]` — so the var expanded to NOTHING and
    // `/things/{id}` silently became `/things/`, addressing the COLLECTION instead of the item. No
    // error, no event. This is the exact value 64-bit IDs are parsed into to dodge JSON precision
    // loss, so the drop hit the people who had already done the right thing.
    describe('bigint vars (issue: silently dropped path parameter)', () => {
        const id = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2 — unrepresentable as a double

        test('a bigint expands in every scalar position, not just some', () => {
            expect(expandPath('/v1/things/{id}', { id })).toBe(
                '/v1/things/9007199254740993',
            );
            expect(expandPath('/v1/{+id}', { id })).toBe(
                '/v1/9007199254740993',
            );
            expect(expandPath('{#id}', { id })).toBe('#9007199254740993');
            expect(expandPath('{.id}', { id })).toBe('.9007199254740993');
            expect(expandPath('/v1{/id}', { id })).toBe('/v1/9007199254740993');
            expect(expandPath('/v1{;id}', { id })).toBe(
                '/v1;id=9007199254740993',
            );
            expect(expandPath('/v1{?id}', { id })).toBe(
                '/v1?id=9007199254740993',
            );
            expect(expandPath('/v1{?a}{&id}', { a: 1, id })).toBe(
                '/v1?a=1&id=9007199254740993',
            );
        });

        test('every digit survives — the whole reason the caller reached for a bigint', () => {
            const url = expandPath('/v1/things/{id}', { id });
            expect(url).toBe(`/v1/things/${id.toString()}`);
            // The same id through a `number` loses the low digits; that lossy form must NOT appear.
            expect(url).not.toContain(String(Number(id))); // 9007199254740992
        });

        test('the prefix (:n) modifier truncates a bigint by decimal digits', () => {
            expect(expandPath('/{id:4}', { id })).toBe('/9007');
        });

        test('0n expands to "0" rather than vanishing as an empty value', () => {
            // `0n` is falsy — it must still take the scalar arm, like the number `0` does.
            expect(expandPath('/v1/things/{id}', { id: 0n })).toBe(
                '/v1/things/0',
            );
            expect(expandPath('/v1{?id}', { id: 0n })).toBe('/v1?id=0');
        });

        test('bigints inside lists and objects keep working', () => {
            // These arms already routed through `String()`/`stringifyLeaf`; pin them so a future
            // refactor of the scalar arm cannot regress the composite ones.
            expect(expandPath('/{ids}', { ids: [1n, 2n] })).toBe('/1,2');
            expect(expandPath('{?ids*}', { ids: [1n, 2n] })).toBe(
                '?ids=1&ids=2',
            );
            expect(expandPath('/{o}', { o: { a: 1n } })).toBe('/a,1');
            expect(expandPath('{?o*}', { o: { a: 1n } })).toBe('?a=1');
        });

        test('the path and query builders agree on a bigint', () => {
            // The bug was the two URL-building paths disagreeing: `buildQuery`/`stringifyLeaf`
            // rendered a bigint while `expandPath` erased it. Same value, same rendering.
            expect(expandPath('/v1{?since}', { since: id })).toBe(
                `/v1${buildQuery({ since: id })}`,
            );
        });
    });
});

// ---- qs-style query encoding ----------------------------------------------
describe('buildQuery (nested, qs-style)', () => {
    test('flat scalars', () => {
        expect(buildQuery({ a: 1, b: 'x y' })).toBe('?a=1&b=x%20y');
        expect(buildQuery({})).toBe('');
        expect(buildQuery(undefined)).toBe('');
    });

    test('nested objects expand to bracketed keys', () => {
        // `filter[type]=admin`, bracket chars percent-encoded as qs does by default
        expect(buildQuery({ filter: { type: 'admin' } })).toBe(
            '?filter%5Btype%5D=admin',
        );
        expect(buildQuery({ a: { b: { c: 1 } } })).toBe('?a%5Bb%5D%5Bc%5D=1');
    });

    test('arrays use indexed keys', () => {
        expect(buildQuery({ ids: [1, 2] })).toBe('?ids%5B0%5D=1&ids%5B1%5D=2');
    });

    test('null/undefined and empties are skipped', () => {
        expect(buildQuery({ a: null, b: undefined, c: 1 })).toBe('?c=1');
        expect(buildQuery({ a: {}, b: [] })).toBe('');
    });
});

// ---- helpers for the engine's template/query split ------------------------
describe('topLevelQueryIndex / appendQueryString', () => {
    test('a top-level ? is the predefined-query delimiter', () => {
        expect(topLevelQueryIndex('/a?b=1')).toBe(2);
    });
    test('a ? inside a {?x} expression is not the delimiter', () => {
        expect(topLevelQueryIndex('/search{?q}')).toBe(-1);
        expect(topLevelQueryIndex('/search{?q}?extra=1')).toBe(11);
    });
    test('appendQueryString switches ? to & and preserves a fragment', () => {
        expect(appendQueryString('http://h/p', '?a=1')).toBe('http://h/p?a=1');
        expect(appendQueryString('http://h/p?x=1', '?a=1')).toBe(
            'http://h/p?x=1&a=1',
        );
        expect(appendQueryString('http://h/p#frag', '?a=1')).toBe(
            'http://h/p?a=1#frag',
        );
        expect(appendQueryString('http://h/p', '')).toBe('http://h/p');
    });
});

// ---- end-to-end through the engine ----------------------------------------
describe('URL building through stitch', () => {
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

    test('nested query objects and arrays reach the wire', async () => {
        server.route('GET', '/items', { body: { ok: true } });
        const list = stitch({ url: `${server.url}/items` });
        await list({ query: { filter: { type: 'admin' }, ids: [1, 2] } });
        expect(server.calls('/items')[0]?.query).toEqual({
            'filter[type]': 'admin',
            'ids[0]': '1',
            'ids[1]': '2',
        });
    });

    test('a {+path} reserved operator keeps slashes in the path', async () => {
        server.route('GET', '/files/a/b/c.txt', { body: { ok: true } });
        const getFile = stitch({ url: `${server.url}/files/{+path}` });
        await expect(
            getFile({ params: { path: 'a/b/c.txt' } }),
        ).resolves.toEqual({ ok: true });
    });

    test('a {?x} template operator merges with a call-time query', async () => {
        server.route('GET', '/search', { body: { ok: true } });
        const search = stitch({ url: `${server.url}/search{?type}` });
        await search({ params: { type: 'admin' }, query: { q: 'ada' } });
        expect(server.calls('/search')[0]?.query).toEqual({
            type: 'admin',
            q: 'ada',
        });
    });
});
