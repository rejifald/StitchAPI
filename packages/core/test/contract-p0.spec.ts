// CONTRACT.md P0 regression: the enumerable `__config` is plain JSON data. Every function-valued
// field an author can write — endpoint thunks, `transform`, `paginate.next`/`items`, `hooks.*`,
// the predicate forms of `acceptStatus`/`retry.on`/`throttle.on`, `idempotency.keyOf`,
// `cache.keyOf` — must be stripped by redaction (the engine reads them off the non-enumerable
// `__rawConfig`), and every scalar shorthand must arrive on `__config` already normalized to its
// canonical envelope (P7/P12/P13/P15).
import { stitch } from '../src';
import type { StitchConfig } from '../src';

// Recursively collect the paths of every function-valued field on an object graph. `__config`
// only carries own enumerable data, so a plain Object.entries walk is the honest P0 probe.
function fnPaths(value: unknown, path = '$'): string[] {
    if (typeof value === 'function') return [path];
    if (value === null || typeof value !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out.push(...fnPaths(v, `${path}.${k}`));
    }
    return out;
}

const rawConfigOf = (f: unknown): StitchConfig =>
    (f as { __rawConfig: StitchConfig }).__rawConfig;

describe('CONTRACT.md P0 — __config is plain JSON data', () => {
    // Every function-valued slot an author can populate, in one stitch.
    const laden = stitch({
        name: 'p0-fn-laden',
        url: () => 'https://api.example.test/items',
        transform: (body) => body,
        paginate: {
            next: () => undefined,
            items: () => [],
            pages: 3,
        },
        hooks: {
            onRequest: () => undefined,
            onResponse: () => undefined,
            onError: () => undefined,
            onRetry: () => undefined,
        },
        acceptStatus: (status) => status === 404,
        retry: { attempts: 2, on: (status) => status >= 500 },
        throttle: { rate: '2/s', on: (status) => status === 429 },
        idempotency: { keyOf: () => 'p0-idem' },
        cache: {
            ttl: '1m',
            keyOf: () => 'p0-cache',
            // String→list P7 shorthands ride along here (the scalar-cache stitch below uses the
            // bare-TTL spelling, so the object form lives on this one).
            vary: 'accept',
            methods: 'GET',
        },
    });

    // Every scalar shorthand, each normalized to its canonical envelope before `__config`.
    const shorthand = stitch({
        name: 'p0-shorthand',
        baseUrl: () => 'https://api.example.test',
        path: '/things/{id}',
        method: 'POST',
        bodyType: 'multipart',
        multipart: 'dot',
        stream: 'ndjson',
        sse: true,
        retry: 3,
        timeout: '5s',
        throttle: '2/s',
        idempotency: true,
        circuit: [2, '30s'],
        cache: '1m',
        acceptStatus: 404,
        // Single fragment ≡ one-element list (P7); folded into the merged config.
        extends: { headers: { accept: 'application/json' } },
    });

    test('the fn-laden stitch exposes zero function-valued paths on __config', () => {
        expect(fnPaths(laden.__config)).toEqual([]);
    });

    test('the shorthand stitch exposes zero function-valued paths on __config', () => {
        expect(fnPaths(shorthand.__config)).toEqual([]);
    });

    test('__config survives a JSON round-trip unchanged', () => {
        for (const cfg of [laden.__config, shorthand.__config]) {
            expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
        }
    });

    test('function-valued sugar is redacted field by field', () => {
        const cfg = laden.__config;
        // A thunked endpoint has no static string — the slot is absent, not stringified.
        expect(cfg.url).toBeUndefined();
        expect(cfg).not.toHaveProperty('transform');
        expect(cfg).not.toHaveProperty('hooks');
        // Only the fn-free `pages` cap survives on paginate.
        expect(cfg.paginate).toEqual({ pages: 3 });
        // Predicate status-matches are redacted away; data fields stay.
        expect(cfg.acceptStatus).toBeUndefined();
        expect(cfg.retry).toEqual({ attempts: 2 });
        expect(cfg.throttle).toEqual({ rate: '2/s' });
        expect(cfg.idempotency).toEqual({});
        expect(cfg.cache).toEqual({
            ttl: '1m',
            vary: ['accept'],
            methods: ['GET'],
        });
    });

    test('every scalar shorthand arrives as its canonical envelope', () => {
        const cfg = shorthand.__config;
        // The baseUrl thunk is redacted; the static path survives.
        expect(cfg.baseUrl).toBeUndefined();
        expect(cfg.path).toBe('/things/{id}');
        expect(cfg.retry).toEqual({ attempts: 3 });
        expect(cfg.timeout).toEqual({ total: '5s' });
        expect(cfg.stream).toEqual({ decode: 'ndjson' });
        expect(cfg.multipart).toEqual({ nesting: 'dot' });
        expect(cfg.sse).toEqual({ reconnect: true });
        expect(cfg.throttle).toEqual({ rate: '2/s' });
        expect(cfg.idempotency).toEqual({});
        expect(cfg.circuit).toEqual({ failures: 2, cooldown: '30s' });
        expect(cfg.cache).toEqual({ ttl: '1m' });
        expect(cfg.acceptStatus).toEqual([404]);
        // The single-fragment extends folded into the merged config (and the key itself is gone).
        expect(cfg.headers).toEqual({ accept: 'application/json' });
        expect(cfg).not.toHaveProperty('extends');
    });

    test('the engine-side sugar lives on the non-enumerable __rawConfig', () => {
        const raw = rawConfigOf(laden);
        expect(typeof raw.url).toBe('function');
        expect(typeof raw.transform).toBe('function');
        expect(typeof raw.paginate?.next).toBe('function');
        expect(typeof raw.hooks?.onRequest).toBe('function');
        expect(typeof raw.acceptStatus).toBe('function');
        expect(fnPaths(rawConfigOf(shorthand))).toContain('$.baseUrl');
        // Neither meta property is enumerable — a spread/JSON view of the stitch leaks nothing.
        expect(Object.keys(laden)).not.toContain('__config');
        expect(Object.keys(laden)).not.toContain('__rawConfig');
    });
});
