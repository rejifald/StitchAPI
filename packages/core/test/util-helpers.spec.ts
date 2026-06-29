// Direct unit tests for the dependency-free helpers in src/util.ts. Most of these
// are exercised only *indirectly* today (parseDuration via cache TTLs, parseRate via
// the throttle, deepMerge via config layering, matchPath/matchAny via drift ignore
// patterns, dirnameOf/stripTrailingSlashes via the file seams) — so their edge cases
// (bare-number durations, array-vs-object merge precedence, prefix-without-over-match,
// single-segment separators) had no test pinning them. These cover the helpers head-on.
import {
    deepMerge,
    dirnameOf,
    getPath,
    isObj,
    matchAny,
    matchPath,
    parseDuration,
    parseRate,
    stripTrailingSlashes,
} from '../src/util';

describe('parseDuration', () => {
    it('passes a number through unchanged', () => {
        expect(parseDuration(1500)).toBe(1500);
    });

    it('returns undefined for nullish input', () => {
        expect(parseDuration(undefined)).toBeUndefined();
    });

    it('parses ms / s / m suffixes', () => {
        expect(parseDuration('500ms')).toBe(500);
        expect(parseDuration('30s')).toBe(30_000);
        expect(parseDuration('2m')).toBe(120_000);
    });

    it('accepts a fractional value and surrounding whitespace', () => {
        expect(parseDuration('1.5s')).toBe(1500);
        expect(parseDuration('  10s  ')).toBe(10_000);
    });

    it('treats a bare numeric string as milliseconds', () => {
        expect(parseDuration('100')).toBe(100);
    });

    it('returns undefined for an unparseable string', () => {
        expect(parseDuration('soon')).toBeUndefined();
    });
});

describe('parseRate', () => {
    it('parses count and per-unit window', () => {
        expect(parseRate('2/s')).toEqual({ count: 2, per: 1000 });
        expect(parseRate('10/m')).toEqual({ count: 10, per: 60_000 });
        expect(parseRate('5/ms')).toEqual({ count: 5, per: 1 });
    });

    it('tolerates whitespace around the slash', () => {
        expect(parseRate('  3 / s ')).toEqual({ count: 3, per: 1000 });
    });

    it('throws on a malformed rate', () => {
        expect(() => parseRate('fast')).toThrow(/bad rate/);
    });
});

describe('stripTrailingSlashes', () => {
    it('removes one or more trailing slashes', () => {
        expect(stripTrailingSlashes('https://x/')).toBe('https://x');
        expect(stripTrailingSlashes('https://x///')).toBe('https://x');
    });

    it('leaves a slash-free string untouched (same reference)', () => {
        const s = 'https://x/api';
        expect(stripTrailingSlashes(s)).toBe(s);
    });

    it('handles all-slash and empty strings', () => {
        expect(stripTrailingSlashes('///')).toBe('');
        expect(stripTrailingSlashes('')).toBe('');
    });
});

describe('isObj', () => {
    it('is true only for plain objects', () => {
        expect(isObj({})).toBe(true);
        expect(isObj({ a: 1 })).toBe(true);
    });

    it('is false for arrays, null and primitives', () => {
        expect(isObj([])).toBe(false);
        expect(isObj(null)).toBe(false);
        expect(isObj(undefined)).toBe(false);
        expect(isObj('x')).toBe(false);
        expect(isObj(5)).toBe(false);
    });
});

describe('deepMerge', () => {
    it('recursively merges nested objects', () => {
        expect(deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 }, e: 4 })).toEqual(
            {
                a: 1,
                b: { c: 2, d: 3 },
                e: 4,
            },
        );
    });

    it('replaces arrays wholesale rather than concatenating', () => {
        expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    });

    it('returns the other side when one is undefined', () => {
        expect(
            deepMerge({ a: 1 }, undefined as unknown as { a: number }),
        ).toEqual({ a: 1 });
        expect(
            deepMerge(undefined as unknown as { b: number }, { b: 2 }),
        ).toEqual({ b: 2 });
    });

    it('lets b win when the two sides have mismatched shapes', () => {
        expect(
            deepMerge({ a: { x: 1 } }, { a: 5 } as unknown as {
                a: { x: number };
            }),
        ).toEqual({ a: 5 });
    });
});

describe('getPath', () => {
    it('reads a nested dotted path', () => {
        expect(getPath({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    });

    it('returns the root object for an empty path', () => {
        const root = { a: 1 };
        expect(getPath(root, '')).toBe(root);
    });

    it('returns undefined for a missing branch without throwing', () => {
        expect(getPath({ a: 1 }, 'x.y')).toBeUndefined();
    });

    it('short-circuits on null without throwing', () => {
        expect(getPath({ a: null }, 'a.b')).toBeNull();
        expect(getPath(null, 'a')).toBeNull();
    });

    it('preserves a falsy leaf value', () => {
        expect(getPath({ a: 0 }, 'a')).toBe(0);
    });
});

describe('matchPath', () => {
    it('matches exactly', () => {
        expect(matchPath('data.id', 'data.id')).toBe(true);
    });

    it('matches a prefix across a dot or a bracket boundary', () => {
        expect(matchPath('data', 'data.id')).toBe(true);
        expect(matchPath('data', 'data[].id')).toBe(true);
    });

    it('does not treat a shared prefix within a segment as a match', () => {
        expect(matchPath('a.b', 'a.bc')).toBe(false);
    });

    it('supports a single-segment wildcard', () => {
        expect(matchPath('data.*.id', 'data.items.id')).toBe(true);
        expect(matchPath('data.*.id', 'data.items.name')).toBe(false);
    });

    it('returns false for an unrelated path', () => {
        expect(matchPath('data', 'other')).toBe(false);
    });
});

describe('matchAny', () => {
    it('is true when any pattern matches', () => {
        expect(matchAny(['x', 'data'], 'data.id')).toBe(true);
    });

    it('is false for an empty or undefined pattern list', () => {
        expect(matchAny([], 'data.id')).toBe(false);
        expect(matchAny(undefined, 'data.id')).toBe(false);
    });
});

describe('dirnameOf', () => {
    it('returns the directory part for POSIX paths', () => {
        expect(dirnameOf('/a/b/c')).toBe('/a/b');
        expect(dirnameOf('a/b')).toBe('a');
    });

    it('returns "." when there is no separator', () => {
        expect(dirnameOf('file.txt')).toBe('.');
    });

    it('keeps the root slash for a top-level path', () => {
        expect(dirnameOf('/a')).toBe('/');
    });

    it('handles Windows-style backslash separators', () => {
        expect(dirnameOf('a\\b\\c')).toBe('a\\b');
    });
});
