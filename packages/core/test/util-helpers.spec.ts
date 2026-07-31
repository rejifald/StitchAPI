// Direct unit tests for the dependency-free helpers in src/util.ts. Most of these
// are exercised only *indirectly* today (parseDuration via cache TTLs, parseRate via
// the throttle, deepMerge via config layering, matchPath/matchAny via drift ignore
// patterns, dirnameOf/stripTrailingSlashes via the file seams) — so their edge cases
// (bare-number durations, array-vs-object merge precedence, prefix-without-over-match,
// single-segment separators) had no test pinning them. These cover the helpers head-on.
import {
    deepMerge,
    dirnameOf,
    envelope,
    getPath,
    isObj,
    matchAny,
    matchPath,
    parseBytes,
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

    it('parses ms / s / m / h / d suffixes', () => {
        expect(parseDuration('500ms')).toBe(500);
        expect(parseDuration('30s')).toBe(30_000);
        expect(parseDuration('2m')).toBe(120_000);
        expect(parseDuration('1h')).toBe(3_600_000);
        expect(parseDuration('2d')).toBe(172_800_000);
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

describe('parseBytes', () => {
    it('passes a number through unchanged', () => {
        expect(parseBytes(4096)).toBe(4096);
    });

    it('returns undefined for nullish input', () => {
        expect(parseBytes(undefined)).toBeUndefined();
    });

    it('parses b / kb / mb / gb / tb as powers of 1024', () => {
        expect(parseBytes('512b')).toBe(512);
        expect(parseBytes('64kb')).toBe(65_536);
        expect(parseBytes('1mb')).toBe(1_048_576);
        expect(parseBytes('2gb')).toBe(2_147_483_648);
        expect(parseBytes('1tb')).toBe(1_099_511_627_776);
    });

    it('accepts the IEC spellings as the same values', () => {
        expect(parseBytes('64kib')).toBe(parseBytes('64kb'));
        expect(parseBytes('1mib')).toBe(parseBytes('1mb'));
        expect(parseBytes('2gib')).toBe(parseBytes('2gb'));
    });

    it('is case-insensitive', () => {
        expect(parseBytes('1MB')).toBe(1_048_576);
        expect(parseBytes('1Mb')).toBe(1_048_576);
        expect(parseBytes('10MiB')).toBe(10 * 1024 * 1024);
    });

    it('accepts a fractional value and surrounding whitespace', () => {
        expect(parseBytes('1.5kb')).toBe(1536);
        expect(parseBytes('  2 mb  ')).toBe(2_097_152);
    });

    it('floors a fraction that lands between bytes — a cap never rounds up', () => {
        expect(parseBytes('1.1kb')).toBe(1126); // 1126.4
    });

    it('treats a bare numeric string as bytes', () => {
        expect(parseBytes('4096')).toBe(4096);
    });

    it('returns undefined for an unparseable string', () => {
        expect(parseBytes('big')).toBeUndefined();
        expect(parseBytes('1gigabyte')).toBeUndefined();
    });

    it('does not accept a bare `i` prefix as a unit', () => {
        expect(parseBytes('5ib')).toBeUndefined();
    });

    it('does not parse a duration token as a size', () => {
        // The two grammars must not overlap: `'1m'` is a minute, never a megabyte.
        expect(parseBytes('1m')).toBeUndefined();
        expect(parseBytes('30s')).toBeUndefined();
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

// `envelope` is the one place CONTRACT.md P12/P14's scalar shorthand is folded — every slot
// (`retry: 3`, `throttle: '2/s'`) and every adapter frame option routes through it, so its edges
// are pinned head-on rather than only through the compose-level shorthand tests.
describe('envelope', () => {
    interface RetryOptions {
        attempts?: number;
        backoff?: string;
    }

    it('folds a bare scalar into its dominant field', () => {
        const v: number | RetryOptions = 3;
        expect(envelope(v, 'attempts')).toEqual({ attempts: 3 });
    });

    it('passes an envelope through by reference, not a copy', () => {
        const opts: RetryOptions = { attempts: 2, backoff: 'expo' };
        const v: number | RetryOptions = opts;
        expect(envelope(v, 'attempts')).toBe(opts);
    });

    it('keeps undefined as undefined, so an absent slot stays absent', () => {
        const v = undefined as number | RetryOptions | undefined;
        expect(envelope(v, 'attempts')).toBeUndefined();
    });

    it('treats every non-object bare form alike — string, number, boolean', () => {
        expect(envelope('2/s' as string | { rate?: string }, 'rate')).toEqual({
            rate: '2/s',
        });
        expect(envelope(0 as number | RetryOptions, 'attempts')).toEqual({
            attempts: 0,
        });
        const flag: boolean | { on?: boolean } = false;
        expect(envelope(flag, 'on')).toEqual({ on: false });
    });

    it('folds a function shorthand — the adapter frame-option form', () => {
        const shaper = (c: unknown): string => String(c);
        type Shaper = typeof shaper;
        const v: Shaper | { data?: Shaper } = shaper;
        expect(envelope(v, 'data')).toEqual({ data: shaper });
    });

    it('folds an array as a bare value rather than mistaking it for the envelope', () => {
        const v: number[] | { on?: number[] } = [429, 503];
        expect(envelope(v, 'on')).toEqual({ on: [429, 503] });
    });
});
