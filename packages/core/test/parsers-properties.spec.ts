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

// A rate's denominator IS a duration (ADR 0023 Decision 3), so it has no scale table of its own —
// it reuses MS_SCALE above. The separate three-entry RATE_WINDOW this replaced was the hand-copied
// subset that left the value space with holes (no token denoted a 1000/hour quota's 3600ms spacing).
//
// `setTimeout` clamps a delay past the 32-bit signed ceiling to 1ms, so a spacing beyond it would
// run UNLIMITED. Restated here rather than imported, per this file's rule.
const MAX_SPACING = 2_147_483_647;

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
    // A bare unit is its one-unit token, over the SAME unit set as `parseDuration` — `'2/h'` and
    // `'2/d'` are the units the old three-entry grammar could not spell.
    it('reads a bare unit as one of that unit, across every duration unit', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.constantFrom(...MS_UNITS),
                (count, unit) => {
                    expect(parseRate(`${count}/${unit}`)).toEqual({
                        count,
                        per: MS_SCALE[unit],
                    });
                    // …and the bare unit is exactly the 1-unit token, not a near-miss of it.
                    expect(parseRate(`${count}/1${unit}`)).toEqual(
                        parseRate(`${count}/${unit}`),
                    );
                },
            ),
        );
    });

    // The denominator is a full duration token, which is what makes '1000/h' and '100/15m'
    // expressible at all — neither has ANY spelling in the old grammar (both need a fractional
    // count over a bare unit, and counts are integers).
    it('scales a multi-unit denominator by its documented window', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.integer({ min: 1, max: 1000 }),
                fc.constantFrom(...MS_UNITS),
                (count, n, unit) => {
                    const per = n * MS_SCALE[unit];
                    fc.pre(per / count <= MAX_SPACING); // past the ceiling is its own property below
                    expect(parseRate(`${count}/${n}${unit}`)).toEqual({
                        count,
                        per,
                    });
                },
            ),
        );
    });

    it('tolerates whitespace around the separator', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.constantFrom(...MS_UNITS),
                (count, unit) => {
                    expect(parseRate(`  ${count} / ${unit}  `)).toEqual(
                        parseRate(`${count}/${unit}`),
                    );
                },
            ),
        );
    });

    // The claim Decision 3 rests on: the denominator's grammar IS `parseDuration`'s, so a
    // denominator that parser rejects (or reads as non-positive) is a rate this one rejects.
    // Using `parseDuration` here is the property, not a mirror of `parseRate`'s own arithmetic —
    // it asserts the two agree, which is the whole point of deleting the second scale table.
    it('rejects exactly the denominators parseDuration will not read as a positive window', () => {
        fc.assert(
            fc.property(
                fc
                    .string()
                    // Bare units are the documented exception — `'s'` means `'1s'`, and
                    // `parseDuration('s')` alone is undefined.
                    .filter(
                        (d) =>
                            !(MS_UNITS as readonly string[]).includes(d.trim()),
                    )
                    .filter((d) => {
                        const per = parseDuration(d.trim());
                        return (
                            per === undefined ||
                            !Number.isFinite(per) ||
                            per <= 0
                        );
                    }),
                (d) => {
                    expect(() => parseRate(`1/${d}`)).toThrow(/bad rate/);
                },
            ),
        );
    });

    it('throws on a count that is not a positive integer', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('0', '00', '0.5', '-1', '1.5', '', ' ', 'x'),
                fc.constantFrom(...MS_UNITS),
                (count, unit) => {
                    expect(() => parseRate(`${count}/${unit}`)).toThrow(
                        /bad rate/,
                    );
                },
            ),
        );
    });

    // Both ends of the spacing range fail the same way and so are rejected the same way: a zero
    // count gives Infinity, a window past the ceiling gives a delay `setTimeout` clamps to 1ms.
    // Either would run the limiter UNLIMITED — the one outcome a limiter must never have.
    it('throws on a spacing past the timer ceiling', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 100 }),
                fc.integer({ min: 25, max: 10_000 }),
                (count, days) => {
                    const per = days * MS_SCALE.d;
                    fc.pre(per / count > MAX_SPACING);
                    expect(() => parseRate(`${count}/${days}d`)).toThrow(
                        /bad rate/,
                    );
                },
            ),
        );
        // …and the largest spacing that CAN be honoured still parses, so the bound is the timer's
        // and not an off-by-one of our own.
        expect(parseRate('1/24d')).toEqual({ count: 1, per: 24 * MS_SCALE.d });
    });

    // The only thing either limiter consumes is `per / count`, so any two rates with the same
    // ratio ARE the same limiter. With the denominator widened this is now sayable three ways,
    // and `'2/500ms'` ≡ `'4/s'` is the case the ADR argued is the design rather than a collapse.
    it('equal ratios parse to equal spacing, however they are spelled', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
                const spacing = (r: string) => {
                    const { count, per } = parseRate(r);
                    return per / count;
                };
                expect(spacing(`${n * 60}/m`)).toBe(spacing(`${n}/s`));
                expect(spacing(`${n}/1000ms`)).toBe(spacing(`${n}/s`));
                expect(spacing(`${n * 2}/2s`)).toBe(spacing(`${n}/s`));
                expect(spacing(`${n * 3600}/h`)).toBe(spacing(`${n}/s`));
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
