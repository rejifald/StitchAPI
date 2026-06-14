// Unit tests for the cache engine internals (ADR 0003): the 128-bit hash, the canonicalisation
// rules that decide when two requests collide, the in-process coalescer primitive, and the
// generation-bump invalidation helpers. These exercise `src/cache.ts` directly — the engine
// integration is covered by cache.spec.ts.
import { memoryStore } from '../src';
import {
    InflightCoalescer,
    type RequestDescriptor,
    bumpCacheGeneration,
    cacheStitchId,
    deriveCacheKey,
    xxh128,
} from '../src/cache';

const GET = (extra: Partial<RequestDescriptor> = {}): RequestDescriptor => ({
    method: 'GET',
    url: 'https://api.example.test/users',
    ...extra,
});

describe('xxh128', () => {
    test('is deterministic and 128-bit (32 lowercase hex chars)', () => {
        expect(xxh128('hello')).toBe(xxh128('hello'));
        expect(xxh128('hello')).toMatch(/^[0-9a-f]{32}$/);
        expect(xxh128('')).toMatch(/^[0-9a-f]{32}$/);
    });

    test('distinguishes different inputs', () => {
        expect(xxh128('hello')).not.toBe(xxh128('world'));
        expect(xxh128('a')).not.toBe(xxh128('b'));
        // length-sensitive (the avalanche folds the length in)
        expect(xxh128('abc')).not.toBe(xxh128('abcd'));
    });

    test('handles inputs spanning the 32-byte stripe boundary', () => {
        const long = 'x'.repeat(200);
        expect(xxh128(long)).toBe(xxh128(long));
        expect(xxh128(long)).not.toBe(xxh128('x'.repeat(201)));
    });
});

describe('deriveCacheKey canonicalisation', () => {
    test('object keys are sorted recursively (order-insensitive)', () => {
        const a = deriveCacheKey(
            GET({ body: { a: 1, b: { c: 2, d: 3 } } }),
            undefined,
        );
        const b = deriveCacheKey(
            GET({ body: { b: { d: 3, c: 2 }, a: 1 } }),
            undefined,
        );
        expect(a).toBe(b);
    });

    test('array order is preserved (ordered)', () => {
        const a = deriveCacheKey(GET({ body: { ids: [1, 2, 3] } }), undefined);
        const b = deriveCacheKey(GET({ body: { ids: [3, 2, 1] } }), undefined);
        expect(a).not.toBe(b);
    });

    test('null is kept; undefined is treated as absent', () => {
        const withNull = deriveCacheKey(GET({ body: { a: null } }), undefined);
        const empty = deriveCacheKey(GET({ body: {} }), undefined);
        const withUndef = deriveCacheKey(
            GET({ body: { a: undefined } }),
            undefined,
        );
        expect(withNull).not.toBe(empty); // null is an explicit value
        expect(withUndef).toBe(empty); // undefined ≡ absent
    });

    test('URL is normalised through the platform URL (host case, default port, dot-segments)', () => {
        const a = deriveCacheKey(
            { method: 'GET', url: 'https://API.example.test:443/a/../b' },
            undefined,
        );
        const b = deriveCacheKey(
            { method: 'GET', url: 'https://api.example.test/b' },
            undefined,
        );
        expect(a).toBe(b);
    });

    test('query-param order is preserved (we own the query string)', () => {
        const a = deriveCacheKey(
            { method: 'GET', url: 'https://x.test/s?a=1&b=2' },
            undefined,
        );
        const b = deriveCacheKey(
            { method: 'GET', url: 'https://x.test/s?b=2&a=1' },
            undefined,
        );
        expect(a).not.toBe(b);
    });

    test('method is upper-cased', () => {
        expect(deriveCacheKey({ ...GET(), method: 'get' }, undefined)).toBe(
            deriveCacheKey({ ...GET(), method: 'GET' }, undefined),
        );
    });

    test('principal is folded in (scope isolation)', () => {
        const alice = deriveCacheKey(GET({ principal: 'alice' }), undefined);
        const bob = deriveCacheKey(GET({ principal: 'bob' }), undefined);
        const none = deriveCacheKey(GET(), undefined);
        expect(alice).not.toBe(bob);
        expect(alice).not.toBe(none);
    });

    test('an unhashable body yields undefined (warn-and-pass-through)', () => {
        expect(
            deriveCacheKey(GET({ body: () => 1 }), undefined),
        ).toBeUndefined();
        expect(
            deriveCacheKey(GET({ body: new Map() }), undefined),
        ).toBeUndefined();
        expect(
            deriveCacheKey(GET({ body: new Uint8Array([1, 2]) }), undefined),
        ).toBeUndefined();
    });

    test('explicit vary folds the listed request headers; others are ignored', () => {
        const en = GET({ headers: { 'accept-language': 'en' } });
        const fr = GET({ headers: { 'accept-language': 'fr' } });
        expect(deriveCacheKey(en, ['accept-language'])).not.toBe(
            deriveCacheKey(fr, ['accept-language']),
        );
        // not in the vary set → header ignored, keys collide
        expect(deriveCacheKey(en, undefined)).toBe(
            deriveCacheKey(fr, undefined),
        );
    });

    test('volatile/secret headers never enter the key, even if named in vary', () => {
        const a = GET({ headers: { authorization: 'Bearer A' } });
        const b = GET({ headers: { authorization: 'Bearer B' } });
        expect(deriveCacheKey(a, ['authorization'])).toBe(
            deriveCacheKey(b, ['authorization']),
        );
    });

    test('GraphQL document is opaque; variables are canonicalised', () => {
        const v1 = deriveCacheKey(
            {
                method: 'POST',
                url: 'https://x.test/graphql',
                graphql: { query: 'query Q { me }', variables: { a: 1, b: 2 } },
            },
            undefined,
        );
        const v2 = deriveCacheKey(
            {
                method: 'POST',
                url: 'https://x.test/graphql',
                graphql: { query: 'query Q { me }', variables: { b: 2, a: 1 } },
            },
            undefined,
        );
        const v3 = deriveCacheKey(
            {
                method: 'POST',
                url: 'https://x.test/graphql',
                graphql: {
                    query: 'query OTHER { me }',
                    variables: { a: 1, b: 2 },
                },
            },
            undefined,
        );
        expect(v1).toBe(v2); // variable key order irrelevant
        expect(v1).not.toBe(v3); // different document → different key
    });

    test('the cache.key sugar override replaces the request seed but keeps principal isolation', () => {
        const alice = deriveCacheKey(
            GET({ principal: 'alice' }),
            undefined,
            'custom',
        );
        const bob = deriveCacheKey(
            GET({ principal: 'bob' }),
            undefined,
            'custom',
        );
        const sameAlice = deriveCacheKey(
            GET({ principal: 'alice', url: 'https://other.test/x' }),
            undefined,
            'custom',
        );
        expect(alice).not.toBe(bob); // principal still isolates
        expect(alice).toBe(sameAlice); // the request itself no longer matters
    });
});

describe('InflightCoalescer', () => {
    test('the first caller leads; the rest follow one shared promise', async () => {
        const c = new InflightCoalescer<number>();
        const a = c.join('k');
        const b = c.join('k');
        expect(a.leader).toBe(true);
        expect(b.leader).toBe(false);
        expect(c.size).toBe(1);
        if (a.leader) a.settle(42);
        expect(await b.promise).toBe(42);
        expect(c.size).toBe(0); // settle drops the in-flight entry
    });

    test('a leader failure rejects the shared promise (the engine re-runs followers)', async () => {
        const c = new InflightCoalescer<number>();
        const a = c.join('k');
        const b = c.join('k');
        if (a.leader) a.fail(new Error('boom'));
        await expect(b.promise).rejects.toThrow('boom');
        expect(c.size).toBe(0);
    });

    test('distinct keys do not coalesce', () => {
        const c = new InflightCoalescer<number>();
        expect(c.join('a').leader).toBe(true);
        expect(c.join('b').leader).toBe(true);
        expect(c.size).toBe(2);
    });

    test('aborts are ref-counted: the run drops only when the LAST participant aborts', () => {
        const c = new InflightCoalescer<number>();
        let cancelled = 0;
        const s0 = new AbortController();
        const s1 = new AbortController();
        const s2 = new AbortController();
        c.join('k', { signal: s0.signal, onCancel: () => (cancelled += 1) });
        c.join('k', { signal: s1.signal });
        c.join('k', { signal: s2.signal });
        expect(c.size).toBe(1);

        s1.abort();
        expect(cancelled).toBe(0);
        expect(c.size).toBe(1);

        s2.abort();
        expect(cancelled).toBe(0);
        expect(c.size).toBe(1);

        s0.abort(); // last waiter
        expect(cancelled).toBe(1);
        expect(c.size).toBe(0);
    });
});

describe('generation helpers', () => {
    test('cacheStitchId prefers name, then path, then a fallback', () => {
        expect(cacheStitchId({ name: 'foo' })).toBe('foo');
        expect(cacheStitchId({ path: '/bar' })).toBe('/bar');
        expect(cacheStitchId({})).toBe('stitch');
    });

    test('bumpCacheGeneration incr-s the cache-wide and per-stitch counters', async () => {
        const store = memoryStore();
        await bumpCacheGeneration(store);
        await bumpCacheGeneration(store);
        expect(await store.get('cache:gen')).toBe(2);

        await bumpCacheGeneration(store, 'users');
        expect(await store.get('cache:gen:users')).toBe(1);
        expect(await store.get('cache:gen')).toBe(2); // untouched
    });
});
