// Property-based tests for the config-token parsers in `src/util.ts`. These four functions sit
// on the outermost edge of the public surface — every `timeout`, `buffer`, and `throttle` value
// a caller writes passes through one of them — and their contracts are stated as *grammars*
// (CONTRACT.md P22/P25), which is the shape a property test can hold to account across the whole
// input space rather than at whichever half-dozen points a table test happened to pick.
//
// The expectations below are computed from scale tables restated independently of the
// implementation, never by re-running its own arithmetic. A wrong exponent in `src/util.ts` has
// to fail one of these rather than be mirrored by it.
import { duration, rate, size, stripTrailingSlashes } from '../src/util';

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
const bytes = (s: string): number => size.parse(s) ?? Number.NaN;
const ms = (s: string): number => duration.parse(s) ?? Number.NaN;

describe('size.parse (property)', () => {
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
                expect(size.parse(n)).toBe(n);
            }),
        );
    });
});

describe('duration.parse (property)', () => {
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
                expect(duration.parse(n)).toBe(n);
            }),
        );
    });
});

describe('rate.parse (property)', () => {
    // A bare unit is its one-unit token, over the SAME unit set as `duration.parse` — `'2/h'` and
    // `'2/d'` are the units the old three-entry grammar could not spell.
    it('reads a bare unit as one of that unit, across every duration unit', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 10_000 }),
                fc.constantFrom(...MS_UNITS),
                (count, unit) => {
                    expect(rate.parse(`${count}/${unit}`)).toEqual({
                        count,
                        per: MS_SCALE[unit],
                    });
                    // …and the bare unit is exactly the 1-unit token, not a near-miss of it.
                    expect(rate.parse(`${count}/1${unit}`)).toEqual(
                        rate.parse(`${count}/${unit}`),
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
                    expect(rate.parse(`${count}/${n}${unit}`)).toEqual({
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
                    expect(rate.parse(`  ${count} / ${unit}  `)).toEqual(
                        rate.parse(`${count}/${unit}`),
                    );
                },
            ),
        );
    });

    // The claim Decision 3 rests on: the denominator's grammar IS `duration.parse`'s, so a
    // denominator that parser rejects (or reads as non-positive) is a rate this one rejects.
    // Using `duration.parse` here is the property, not a mirror of `rate.parse`'s own arithmetic —
    // it asserts the two agree, which is the whole point of deleting the second scale table.
    it('rejects exactly the denominators duration.parse will not read as a positive window', () => {
        fc.assert(
            fc.property(
                fc
                    .string()
                    // Bare units are the documented exception — `'s'` means `'1s'`, and
                    // `duration.parse('s')` alone is undefined.
                    .filter(
                        (d) =>
                            !(MS_UNITS as readonly string[]).includes(d.trim()),
                    )
                    .filter((d) => {
                        const per = duration.parse(d.trim());
                        return (
                            per === undefined ||
                            !Number.isFinite(per) ||
                            per <= 0
                        );
                    }),
                (d) => {
                    expect(() => rate.parse(`1/${d}`)).toThrow(/bad rate/);
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
                    expect(() => rate.parse(`${count}/${unit}`)).toThrow(
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
                    expect(() => rate.parse(`${count}/${days}d`)).toThrow(
                        /bad rate/,
                    );
                },
            ),
        );
        // …and the largest spacing that CAN be honoured still parses, so the bound is the timer's
        // and not an off-by-one of our own.
        expect(rate.parse('1/24d')).toEqual({ count: 1, per: 24 * MS_SCALE.d });
    });

    // The sibling of the `stripTrailingSlashes` property below, with one honest difference: there
    // the quadratic behaviour is real, here it was only ever a pattern. The one-regex form of this
    // grammar (`^([1-9]\d*)\s*\/\s*(.+)$`) has a trailing `\s*` and a `.+` that both match a space
    // — what `js/polynomial-redos` flags — but measured linear on every shape below, because
    // `(.+)$` succeeds as soon as one character remains. The hand-rolled split has no overlap at
    // all, and this pins the property either way: a long run of whitespace changes neither the
    // answer nor the cost, so a future one-regex "simplification" has to fail something.
    it('is unmoved by a long run of whitespace around the slash', () => {
        fc.assert(
            fc.property(
                fc.nat({ max: 2048 }),
                fc.nat({ max: 2048 }),
                fc.constantFrom(...MS_UNITS),
                (before, after, unit) => {
                    const pad = (k: number) => ' '.repeat(k);
                    expect(
                        rate.parse(`2${pad(before)}/${pad(after)}${unit}`),
                    ).toEqual(rate.parse(`2/${unit}`));
                },
            ),
        );
        // The failing shapes matter more than the passing ones: these have no valid denominator,
        // so a backtracking matcher would have to exhaust every split before giving up.
        for (const bad of [
            `2/${' '.repeat(4096)}`,
            `2${' '.repeat(4096)}/`,
            `${' '.repeat(4096)}/s`,
            `2/${' '.repeat(2048)}x${' '.repeat(2048)}`,
        ])
            expect(() => rate.parse(bad)).toThrow(/bad rate/);
    });

    // The only thing either limiter consumes is `per / count`, so any two rates with the same
    // ratio ARE the same limiter. With the denominator widened this is now sayable three ways,
    // and `'2/500ms'` ≡ `'4/s'` is the case the ADR argued is the design rather than a collapse.
    it('equal ratios parse to equal spacing, however they are spelled', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
                const spacing = (r: string) => {
                    const { count, per } = rate.parse(r);
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

// ---- the encode direction (`format`) --------------------------------------------------------
// `format` is specified as the EXACT inverse of `parse`, which is a property over the whole
// numeric range rather than a table of pretty cases — exactly the shape this file exists for.
// The round-trip is the contract a caller relies on to read a value back after writing it, and
// it is the clause that separates the house pair from `ms`, whose `ms(90_000)` is `'2m'` and
// parses back to 120_000.
//
// The expectations here are NOT computed from the formatter's own arithmetic: each asserts on
// `parse(format(n)) === n`, where `parse` is the independently-tested decoder above. A formatter
// that picked the wrong exponent, rounded, or emitted an exponential form fails the round-trip
// rather than being mirrored by a re-implementation of its own bug.

describe('duration.format (property)', () => {
    it('round-trips every non-negative magnitude exactly', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.nat({ max: Number.MAX_SAFE_INTEGER }),
                    fc.double({ min: 0, max: 1e12, noNaN: true }),
                ),
                (n) => {
                    expect(duration.parse(duration.format(n))).toBe(n);
                },
            ),
        );
    });

    // The base unit is always available (its quotient IS the value and its scale is 1), so no
    // finite input can fall through to a form the grammar rejects. A `format` that returned an
    // un-parseable token would surface here as `undefined` rather than a wrong number.
    it('always emits a token the grammar accepts', () => {
        fc.assert(
            fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), (n) => {
                expect(duration.parse(duration.format(n))).not.toBeUndefined();
            }),
        );
    });

    // `Number('0') || undefined` is `undefined`, so a bare `'0'` is the one integer the numeric
    // -string arm cannot read back. Zero must therefore carry a unit — the single case where the
    // "largest exact unit" rule is not what makes the round-trip work.
    it('gives zero a unit, since a bare "0" does not parse', () => {
        expect(duration.format(0)).toBe('0ms');
        expect(duration.parse('0')).toBeUndefined();
        expect(duration.parse(duration.format(0))).toBe(0);
    });

    it('prefers the largest unit that stays exact and readable', () => {
        expect(duration.format(3_600_000)).toBe('1h');
        expect(duration.format(86_400_000)).toBe('1d');
        expect(duration.format(1500)).toBe('1.5s');
        expect(duration.format(90_000)).toBe('1.5m');
        // 90_001 divides into no unit cleanly — `1.5000166…m` is exact but unreadable, so the
        // base unit wins rather than a rounded `'2m'`.
        expect(duration.format(90_001)).toBe('90001ms');
    });

    // A duration core produces is a raw-ms number and a non-finite one is a bug upstream, not a
    // config typo, so this is the one direction that throws rather than degrading quietly.
    it('rejects a non-finite magnitude', () => {
        expect(() => duration.format(NaN)).toThrow(TypeError);
        expect(() => duration.format(Infinity)).toThrow(TypeError);
    });
});

describe('size.format (property)', () => {
    it('round-trips every non-negative byte count exactly', () => {
        fc.assert(
            fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), (n) => {
                expect(size.parse(size.format(n))).toBe(n);
            }),
        );
    });

    it('gives zero a unit, since a bare "0" does not parse', () => {
        expect(size.format(0)).toBe('0b');
        expect(size.parse('0')).toBeUndefined();
        expect(size.parse(size.format(0))).toBe(0);
    });

    // The readability guard matters more for sizes than durations: 1024 is a power of two, so a
    // byte count's kb quotient is almost always exact — and almost always unreadable. Exactness
    // alone would emit `'1.5009765625kb'` here.
    it('falls to the base unit rather than emit an exact but unreadable quotient', () => {
        expect(size.format(1536)).toBe('1.5kb');
        expect(size.format(1537)).toBe('1537b');
        expect(size.format(1_048_576)).toBe('1mb');
        expect(size.format(10 * 1024 * 1024)).toBe('10mb');
    });

    it('rejects a non-finite byte count', () => {
        expect(() => size.format(NaN)).toThrow(TypeError);
        expect(() => size.format(Infinity)).toThrow(TypeError);
    });
});

describe('rate.format (property)', () => {
    it('round-trips every legal { count, per } exactly', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 1_000_000 }),
                fc.integer({ min: 1, max: 86_400_000 * 40 }),
                (count, per) => {
                    // The spacing ceiling is part of the grammar, so a pair past it is not a
                    // legal rate in either direction — `format` rejects it exactly as `parse` does.
                    fc.pre(per / count <= 2_147_483_647);
                    expect(rate.parse(rate.format({ count, per }))).toEqual({
                        count,
                        per,
                    });
                },
            ),
        );
    });

    // A one-unit window drops the `1`, because `parse` reads a bare unit as its one-unit token
    // and the short spelling is the one the docs and house defaults are written in.
    it('writes a one-unit window as a bare unit', () => {
        expect(rate.format({ count: 2, per: 1000 })).toBe('2/s');
        expect(rate.format({ count: 10, per: 60_000 })).toBe('10/m');
        expect(rate.format({ count: 1000, per: 3_600_000 })).toBe('1000/h');
        expect(rate.format({ count: 100, per: 900_000 })).toBe('100/15m');
    });

    // `'2/500ms'` ≡ `'4/s'` is the design (ADR 0023), but `format` returns the pair it was handed
    // rather than a reduced representative — `count` is the number the consumer wrote, and the
    // round-trip above is equality, not equivalence.
    it('does not reduce a rate to an equivalent one', () => {
        expect(rate.format({ count: 2, per: 500 })).toBe('2/500ms');
        expect(rate.format({ count: 4, per: 1000 })).toBe('4/s');
        // Same limiter, different tokens — and each parses back to its own pair.
        expect(rate.parse('2/500ms')).toEqual({ count: 2, per: 500 });
        expect(rate.parse('4/s')).toEqual({ count: 4, per: 1000 });
    });

    // `format` enforces the same three rejections `parse` does, so a pair that could not have
    // come from `parse` fails at the encode step instead of producing a token that throws on the
    // way back in.
    it('rejects what parse would reject', () => {
        expect(() => rate.format({ count: 0, per: 1000 })).toThrow(/bad rate/);
        expect(() => rate.format({ count: 1.5, per: 1000 })).toThrow(
            /bad rate/,
        );
        expect(() => rate.format({ count: 1, per: 0 })).toThrow(/bad rate/);
        expect(() => rate.format({ count: 1, per: -500 })).toThrow(/bad rate/);
        // 30 days at one grant is past the setTimeout ceiling, the same token `parse` rejects.
        expect(() => rate.format({ count: 1, per: 86_400_000 * 30 })).toThrow(
            /timer ceiling/,
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
