// CONTRACT.md P0 regression: the enumerable `__config` is plain JSON data. Every function-valued
// field an author can write — endpoint thunks, `transform`, `paginate.next`/`items`, `hooks.*`, the
// predicate forms of `acceptStatus`/`retry.on`/`throttle.on`, `idempotency.keyOf`, `cache.keyOf`,
// and a live `TraceSink` — must be stripped by redaction; the engine reads that sugar off the
// non-enumerable `__rawConfig`.
// This guards two things at once: the exfil-at-rest surface (a public config view must not carry
// live author closures — ADR 0002) and JSON-serialisability (a function silently drops on
// `JSON.stringify`, so a leaked one corrupts every trace / report / `mcp` view of the stitch).
import { stitch } from '../src';
import type { StitchConfig, TraceSink } from '../src';

import { describe, expect, test } from 'vitest';

// Recursively collect the paths of every function-valued field on an object graph. `__config` only
// carries own enumerable data, so a plain `Object.entries` walk is the honest P0 probe.
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
            // The canonical derivation-fn name (not the @deprecated `key`): redaction must strip
            // BOTH, so exercising `keyOf` here pins the name-agnostic strip.
            keyOf: () => 'p0-cache',
            vary: ['accept'],
            methods: ['GET'],
        },
        // A live sink: `trace` is data in its shorthand forms but an author-closure handle in this
        // one, so it is the third data-or-handle slot alongside `url`/`acceptStatus`.
        trace: { handle: () => undefined },
    });

    test('the fn-laden stitch exposes zero function-valued paths on __config', () => {
        expect(fnPaths(laden.__config)).toEqual([]);
    });

    test('__config survives a JSON round-trip unchanged', () => {
        expect(JSON.parse(JSON.stringify(laden.__config))).toEqual(
            laden.__config,
        );
    });

    test('function-valued sugar is redacted field by field', () => {
        const cfg = laden.__config;
        // A thunked endpoint has no static string — the slot is absent, not stringified.
        expect(cfg.url).toBeUndefined();
        expect(cfg).not.toHaveProperty('transform');
        expect(cfg).not.toHaveProperty('hooks');
        // Fn-free data survives; the paginate/keyOf/predicate fns are gone.
        expect(cfg.paginate).not.toHaveProperty('next');
        expect(cfg.paginate).not.toHaveProperty('items');
        expect(cfg.paginate?.pages).toBe(3);
        expect(cfg.acceptStatus).toBeUndefined(); // the predicate form is redacted
        expect(cfg.retry).not.toHaveProperty('on'); // the predicate `on` is redacted
        expect(cfg.retry?.attempts).toBe(2);
        expect(cfg.throttle).not.toHaveProperty('on');
        expect(cfg.throttle?.rate).toBe('2/s');
        expect(cfg.idempotency).not.toHaveProperty('keyOf');
        expect(cfg.cache).not.toHaveProperty('keyOf');
        expect(cfg.cache).not.toHaveProperty('key');
        expect(cfg.cache?.ttl).toBe('1m');
        // A live sink is dropped WHOLE, not fn-stripped to a hollow `{}` — an empty object would
        // read as "tracing configured with defaults" and would not survive a JSON round-trip.
        expect(cfg).not.toHaveProperty('trace');
    });

    test('the `trace` shorthand forms are dropped with the slot', () => {
        // `'console'` / `false` resolve to the same live sink, so the whole slot goes — `trace` is
        // infrastructure and joins `store`/`adapter`/`clock` in being absent from the public view.
        const named = stitch({
            name: 'p0-trace-console',
            url: 'https://api.example.test/x',
            trace: 'console',
        });
        expect(named.__config).not.toHaveProperty('trace');
        const off = stitch({
            name: 'p0-trace-off',
            url: 'https://api.example.test/x',
            trace: false,
        });
        expect(off.__config).not.toHaveProperty('trace');
    });

    test('a class-based TraceSink is dropped too (methods live on the prototype)', () => {
        // The own-entry fn-strip cannot see a prototype method, so this is the case a per-field
        // strip would silently pass while still exposing a live handle.
        class ClassSink implements TraceSink {
            seen = 0;
            handle(): void {
                this.seen += 1;
            }
        }
        const s = stitch({
            name: 'p0-trace-class',
            url: 'https://api.example.test/x',
            trace: new ClassSink(),
        });
        expect(s.__config).not.toHaveProperty('trace');
        expect(JSON.parse(JSON.stringify(s.__config))).toEqual(s.__config);
    });

    test('the engine-side sugar lives on the non-enumerable __rawConfig', () => {
        const raw = rawConfigOf(laden);
        expect(typeof raw.url).toBe('function');
        expect(typeof raw.transform).toBe('function');
        expect(typeof raw.paginate?.next).toBe('function');
        expect(typeof raw.hooks?.onRequest).toBe('function');
        expect(typeof raw.acceptStatus).toBe('function');
        expect(fnPaths(raw.cache)).toContain('$.keyOf'); // the cache derivation fn is retained raw
        expect(fnPaths(raw.trace)).toContain('$.handle'); // the live sink is retained raw
        // Neither meta property is enumerable — a spread / JSON view of the stitch leaks nothing.
        expect(Object.keys(laden)).not.toContain('__config');
        expect(Object.keys(laden)).not.toContain('__rawConfig');
    });
});
