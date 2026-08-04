// Property-based tests for the config-token parsers in `src/util.ts`. These four functions sit
// on the outermost edge of the public surface — every `timeout`, `buffer`, and `throttle` value
// a caller writes passes through one of them — and their contracts are stated as *grammars*
// (CONTRACT.md P22/P25), which is the shape a property test can hold to account across the whole
// input space rather than at whichever half-dozen points a table test happened to pick.
//
// The expectations below are computed from scale tables restated independently of the
// implementation, never by re-running its own arithmetic. A wrong exponent in `src/util.ts` has
// to fail one of these rather than be mirrored by it.
import {
    parseBytes,
    parseDuration,
    parseRate,
    stripTrailingSlashes,
} from '../src/util';

import fc from 'fast-check';

const BYTE_UNITS = ['b', 'kb', 'mb', 'gb', 'tb'] as const;
const BYTE_SCALE: Record<(typeof BYTE_UNITS)[number], number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
};

const MS_UNITS = ['ms', 's', 'm', 'h', 'd'] as const;
const MS_SCALE: Record<(typeof MS_UNITS)[number], number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

const RATE_UNITS = ['ms', 's', 'm'] as const;
const RATE_WINDOW: Record<(typeof RATE_UNITS)[number], number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
};

// `1000 * 1024**4` is ~1.1e15, comfortably inside Number.MAX_SAFE_INTEGER, so every exact
// equality below stays exact — a wider magnitude would be testing float rounding, not parsing.
const magnitude = fc.integer({ min: 0, max: 1000 });

// The parsers return `number | undefined`; every input generated here is inside the grammar, so
// `undefined` is a failure. Folding it to NaN makes that failure loud in whichever assertion
// follows instead of needing a non-null assertion at each call site.
const bytes = (s: string): number => parseBytes(s) ?? Number.NaN;
const ms = (s: string): number => parseDuration(s) ?? Number.NaN;

describe('parseBytes (property)', () => {
    it('scales each unit by its documented power of 1024', () => {
        fc.assert(
            fc.property(
                magnitude,
                fc.constantFrom(...BYTE_UNITS),
                (n, unit) => {
                    expect(bytes(`${n}${unit}`)).toBe(n * BYTE_SCALE[unit]);
                },
            ),
        );
    });

    it('reads the IEC spelling as the same value as the plain one', () => {
        fc.assert(
            fc.property(
                magnitude,
                fc.constantFrom('k', 'm', 'g', 't'),
                (n, prefix) => {
                    expect(bytes(`${n}${prefix}ib`)).toBe(
                        bytes(`${n}${prefix}b`),
                    );
                },
            ),
        );
    });

    it('ignores case and surrounding whitespace', () => {
        fc.assert(
            fc.property(
                magnitude,
                fc.constantFrom(...BYTE_UNITS),
                (n, unit) => {
                    const canonical = bytes(`${n}${unit}`);
                    expect(bytes(`${n}${unit.toUpperCase()}`)).toBe(canonical);
                    expect(bytes(`  ${n}${unit}  `)).toBe(canonical);
                },
            ),
        );
    });

    // The documented promise is that a fractional token "floors — never rounds up past what the
    // caller asked for". Stated as an interval rather than an equality, so this holds the
    // rounding *direction* to account without restating the implementation's own expression.
    it('floors a fractional token, never rounding up past the requested cap', () => {
        fc.assert(
            fc.property(
                magnitude,
                fc.integer({ min: 1, max: 99 }),
                fc.constantFrom(...BYTE_UNITS),
                (whole, frac, unit) => {
                    const got = bytes(`${whole}.${frac}${unit}`);
                    const exact = Number(`${whole}.${frac}`) * BYTE_SCALE[unit];
                    expect(Number.isInteger(got)).toBe(true);
                    expect(got).toBeLessThanOrEqual(exact);
                    expect(got).toBeGreaterThan(exact - 1);
                },
            ),
        );
    });

    it('is monotonic in the magnitude', () => {
        fc.assert(
            fc.property(
                magnitude,
                magnitude,
                fc.constantFrom(...BYTE_UNITS),
                (a, b, unit) => {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    expect(bytes(`${lo}${unit}`)).toBeLessThanOrEqual(
                        bytes(`${hi}${unit}`),
                    );
                },
            ),
        );
    });

    it('passes a number through as already-bytes', () => {
        fc.assert(
            fc.property(fc.integer(), (n) => {
                expect(parseBytes(n)).toBe(n);
            }),
        );
    });
});

describe('parseDuration (property)', () => {
    it('scales each unit by its documented factor', () => {
        fc.assert(
            fc.property(magnitude, fc.constantFrom(...MS_UNITS), (n, unit) => {
                expect(ms(`${n}${unit}`)).toBe(n * MS_SCALE[unit]);
            }),
        );
    });

    it('reads a bare numeric string as milliseconds', () => {
        // 0 is excluded deliberately: the bare-number branch is `Number(d) || undefined`, so
        // "0" is documented to fall through to undefined rather than to zero.
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 1_000_000 }), (n) => {
                expect(ms(`${n}`)).toBe(n);
            }),
        );
    });

    it('ignores surrounding whitespace', () => {
        fc.assert(
            fc.property(magnitude, fc.constantFrom(...MS_UNITS), (n, unit) => {
                expect(ms(`  ${n}${unit}  `)).toBe(ms(`${n}${unit}`));
            }),
        );
    });

    it('is monotonic in the magnitude', () => {
        fc.assert(
            fc.property(
                magnitude,
                magnitude,
                fc.constantFrom(...MS_UNITS),
                (a, b, unit) => {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    expect(ms(`${lo}${unit}`)).toBeLessThanOrEqual(
                        ms(`${hi}${unit}`),
                    );
                },
            ),
        );
    });

    it('passes a number through as already-milliseconds', () => {
        fc.assert(
            fc.property(fc.integer(), (n) => {
                expect(parseDuration(n)).toBe(n);
            }),
        );
    });
});

describe('parseRate (property)', () => {
    it('splits a rate into its count and window length', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.constantFrom(...RATE_UNITS),
                (count, unit) => {
                    expect(parseRate(`${count}/${unit}`)).toEqual({
                        count,
                        per: RATE_WINDOW[unit],
                    });
                },
            ),
        );
    });

    it('tolerates whitespace around the separator', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.constantFrom(...RATE_UNITS),
                (count, unit) => {
                    expect(parseRate(`  ${count} / ${unit}  `)).toEqual(
                        parseRate(`${count}/${unit}`),
                    );
                },
            ),
        );
    });

    it('throws on anything outside the grammar', () => {
        fc.assert(
            fc.property(
                fc
                    .string()
                    .filter(
                        (s) => !/^[1-9]\d*\s*\/\s*(ms|s|m)$/.test(s.trim()),
                    ),
                (bad) => {
                    expect(() => parseRate(bad)).toThrow(/bad rate/);
                },
            ),
        );
    });

    // A zero count parses to a spacing of `per / 0` = Infinity, which `setTimeout` clamps to 1ms —
    // "block everything" under an injected clock, NO limit at all on the system clock. Rejected at
    // the grammar, for every spelling of zero and every unit.
    it('rejects a zero count', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('0', '00', '000'),
                fc.constantFrom(...RATE_UNITS),
                (zero, unit) => {
                    expect(() => parseRate(`${zero}/${unit}`)).toThrow(
                        /bad rate/,
                    );
                },
            ),
        );
    });

    // The only thing either limiter consumes is `per / count`, so any two rates with the same
    // ratio ARE the same limiter — the property that lets the grammar stay a ratio.
    it('equal ratios parse to equal spacing', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
                const perSecond = parseRate(`${n}/s`);
                const perMinute = parseRate(`${n * 60}/m`);
                expect(perMinute.per / perMinute.count).toBe(
                    perSecond.per / perSecond.count,
                );
            }),
        );
    });
});

describe('stripTrailingSlashes (property)', () => {
    it('never returns a value ending in a slash', () => {
        fc.assert(
            fc.property(fc.string(), (s) => {
                expect(stripTrailingSlashes(s).endsWith('/')).toBe(false);
            }),
        );
    });

    it('only ever removes a suffix', () => {
        fc.assert(
            fc.property(fc.string(), (s) => {
                expect(s.startsWith(stripTrailingSlashes(s))).toBe(true);
            }),
        );
    });

    it('is idempotent', () => {
        fc.assert(
            fc.property(fc.string(), (s) => {
                const once = stripTrailingSlashes(s);
                expect(stripTrailingSlashes(once)).toBe(once);
            }),
        );
    });

    // This is the property the hand-rolled backward scan exists for: the regex it replaced
    // (`/\/+$/`) backtracks quadratically on a long run of slashes. Generating that run
    // directly is what would have caught the trap, so it is generated directly.
    it('absorbs any number of trailing slashes', () => {
        fc.assert(
            fc.property(fc.string(), fc.nat({ max: 512 }), (s, k) => {
                expect(stripTrailingSlashes(s + '/'.repeat(k))).toBe(
                    stripTrailingSlashes(s),
                );
            }),
        );
    });
});
