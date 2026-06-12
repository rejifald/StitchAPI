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
