// Regression tests for four cache-invalidation COLLISIONS in the Zod-4 walker
// (StitchAPI ADR 0003/0004). The fingerprint token is a cache key: if two
// semantically-different schemas hash the same, editing a schema fails to
// invalidate the validated cache and stale data is served. Each test below
// FAILS on the pre-fix v4 walker and PASSES after the fix.
import { zodFingerprinter } from '../src';

import { describe, expect, it } from 'vitest';
import * as z4 from 'zod/v4';

// The strategy is typed for Standard Schema; the conformance suite casts the
// same way. We only read `.token` off the result.
const fp = (schema: unknown): string | null =>
    zodFingerprinter.fingerprint(schema as never).token;

describe('@stitchapi/fingerprint-zod — Zod-4 collision regressions', () => {
    // BUG 1 — composite `.refine()` was dropped: the object/record/tuple/map/
    // set/union branches never folded `def.checks`, so a refined composite
    // hashed identically to the plain one (and to a DIFFERENT refinement). The
    // fix folds `v4Checks`, which ABSTAINS on a custom check → token null.
    describe('composite .refine() is captured (abstains, not dropped)', () => {
        it('abstains on a refined object', () => {
            expect(
                fp(z4.object({ a: z4.number() }).refine(() => true)),
            ).toBeNull();
        });

        it('still fingerprints the plain object (non-null)', () => {
            expect(fp(z4.object({ a: z4.number() }))).not.toBeNull();
        });

        it('abstains on refined record/tuple/map/set/union too', () => {
            expect(
                fp(z4.record(z4.string(), z4.number()).refine(() => true)),
            ).toBeNull();
            expect(fp(z4.tuple([z4.string()]).refine(() => true))).toBeNull();
            expect(
                fp(z4.map(z4.string(), z4.number()).refine(() => true)),
            ).toBeNull();
            expect(fp(z4.set(z4.number()).refine(() => true))).toBeNull();
            expect(
                fp(z4.union([z4.string(), z4.number()]).refine(() => true)),
            ).toBeNull();
        });
    });

    // BUG 2 — top-level string formats collided: the `string` branch read only
    // `def.checks`, ignoring `def.format`/`def.pattern`, so z4.email()/uuid()/
    // url() and plain z4.string() all hashed the same. A schema tightened from
    // `string` to `email` would not invalidate its cache.
    describe('string formats are distinct from plain string and each other', () => {
        it('email !== string', () => {
            const email = fp(z4.email());
            expect(email).not.toBeNull();
            expect(email).not.toBe(fp(z4.string()));
        });

        it('email !== url', () => {
            expect(fp(z4.email())).not.toBe(fp(z4.url()));
        });

        it('uuid !== string and !== email', () => {
            expect(fp(z4.uuid())).not.toBe(fp(z4.string()));
            expect(fp(z4.uuid())).not.toBe(fp(z4.email()));
        });
    });

    // BUG 4 — the `coerce` flag was dropped: v4 string/number/bigint/boolean/
    // date ignored `def.coerce`, so z4.coerce.number() (accepts "1") hashed the
    // same as z4.number() (rejects "1"). v3 already folded coerce.
    describe('coercion changes the fingerprint', () => {
        it('coerce.number !== number', () => {
            const coerced = fp(z4.coerce.number());
            expect(coerced).not.toBeNull();
            expect(coerced).not.toBe(fp(z4.number()));
        });

        it('coerce.string/boolean/bigint/date each differ from their plain form', () => {
            expect(fp(z4.coerce.string())).not.toBe(fp(z4.string()));
            expect(fp(z4.coerce.boolean())).not.toBe(fp(z4.boolean()));
            expect(fp(z4.coerce.bigint())).not.toBe(fp(z4.bigint()));
            expect(fp(z4.coerce.date())).not.toBe(fp(z4.date()));
        });
    });

    // BUG 3 — enum members were String()-coerced: `Object.values(entries)
    // .map(String)` collapsed z4.enum({A:1}) (accepts number 1) and
    // z4.enum({A:'1'}) (accepts string '1'). The fix encodes members with the
    // type-preserving `literal()` helper.
    describe('enum member type is preserved', () => {
        it("enum({A:1}) !== enum({A:'1'})", () => {
            const numeric = fp(z4.enum({ A: 1 }));
            const stringy = fp(z4.enum({ A: '1' }));
            expect(numeric).not.toBeNull();
            expect(stringy).not.toBeNull();
            expect(numeric).not.toBe(stringy);
        });
    });
});
