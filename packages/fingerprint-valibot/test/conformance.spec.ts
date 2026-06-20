// Conformance proof for the Valibot fingerprint strategy (StitchAPI ADR 0004).
import { valibotFingerprinter } from '../src';

import {
    assertConformance,
    verifyFingerprintContract,
} from 'stitchapi/testing';
import type { FingerprintFixtures } from 'stitchapi/testing';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

const fixtures: FingerprintFixtures = {
    stable: [
        {
            label: 'user',
            schema: () => v.object({ id: v.number(), name: v.string() }),
        },
        {
            label: 'string-min2',
            schema: () => v.pipe(v.string(), v.minLength(2)),
        },
        { label: 'enum-ab', schema: () => v.picklist(['a', 'b']) },
        {
            label: 'nested',
            schema: () =>
                v.object({
                    tags: v.array(v.string()),
                    age: v.optional(v.number()),
                }),
        },
    ],
    equivalent: [
        // Permuted KEY ORDER must hash equal (the walker sorts object keys).
        {
            label: 'key-order',
            a: () => v.object({ id: v.number(), name: v.string() }),
            b: () => v.object({ name: v.string(), id: v.number() }),
        },
        // Permuted ACTION ORDER must hash equal (the walker sorts pipe actions).
        {
            label: 'action-order',
            a: () => v.pipe(v.string(), v.minLength(2), v.maxLength(8)),
            b: () => v.pipe(v.string(), v.maxLength(8), v.minLength(2)),
        },
        // Re-ordered picklist members describe the same set.
        {
            label: 'picklist-order',
            a: () => v.picklist(['a', 'b', 'c']),
            b: () => v.picklist(['c', 'a', 'b']),
        },
    ],
    distinct: [
        { label: 'string', schema: () => v.string() },
        {
            label: 'string-min2',
            schema: () => v.pipe(v.string(), v.minLength(2)),
        },
        // CONSTRAINT VALUE changed: min 2 vs min 3.
        {
            label: 'string-min3',
            schema: () => v.pipe(v.string(), v.minLength(3)),
        },
        { label: 'number', schema: () => v.number() },
        // CONSTRAINT VALUE changed on a numeric bound.
        {
            label: 'number-min5',
            schema: () => v.pipe(v.number(), v.minValue(5)),
        },
        { label: 'boolean', schema: () => v.boolean() },
        { label: 'obj-id', schema: () => v.object({ id: v.number() }) },
        // FIELD ADDED.
        {
            label: 'obj-id-name',
            schema: () => v.object({ id: v.number(), name: v.string() }),
        },
        // FIELD TYPE CHANGED.
        { label: 'obj-id-string', schema: () => v.object({ id: v.string() }) },
        // OPTIONAL vs required.
        {
            label: 'obj-id-optional',
            schema: () => v.object({ id: v.optional(v.number()) }),
        },
        // NULLABLE.
        {
            label: 'obj-id-nullable',
            schema: () => v.object({ id: v.nullable(v.number()) }),
        },
        // ENUM / picklist variants.
        { label: 'pick-ab', schema: () => v.picklist(['a', 'b']) },
        { label: 'pick-abc', schema: () => v.picklist(['a', 'b', 'c']) },
        // LITERAL value.
        { label: 'literal-x', schema: () => v.literal('x') },
        { label: 'literal-y', schema: () => v.literal('y') },
        { label: 'array-string', schema: () => v.array(v.string()) },
        // UNION variants.
        { label: 'union-sn', schema: () => v.union([v.string(), v.number()]) },
        {
            label: 'union-snb',
            schema: () => v.union([v.string(), v.number(), v.boolean()]),
        },
        // Less-common Valibot types the original battery omitted — each exercises
        // a distinct type-dispatch branch and must fingerprint to a unique value.
        { label: 'bigint', schema: () => v.bigint() },
        { label: 'date', schema: () => v.date() },
        { label: 'symbol', schema: () => v.symbol() },
        { label: 'null', schema: () => v.null_() },
        { label: 'undefined', schema: () => v.undefined_() },
        { label: 'void', schema: () => v.void_() },
        { label: 'nan', schema: () => v.nan() },
        { label: 'any', schema: () => v.any() },
        { label: 'unknown', schema: () => v.unknown() },
        { label: 'never', schema: () => v.never() },
        { label: 'nullable', schema: () => v.nullable(v.string()) },
        { label: 'nullish', schema: () => v.nullish(v.string()) },
        {
            label: 'tuple',
            schema: () => v.tuple([v.string(), v.number()]),
        },
        {
            label: 'record',
            schema: () => v.record(v.string(), v.number()),
        },
        { label: 'map', schema: () => v.map(v.string(), v.number()) },
        { label: 'set', schema: () => v.set(v.number()) },
        { label: 'enum', schema: () => v.enum_({ A: 'x', B: 'y' }) },
        {
            label: 'variant',
            schema: () =>
                v.variant('t', [
                    v.object({ t: v.literal('a') }),
                    v.object({ t: v.literal('b') }),
                ]),
        },
        {
            label: 'intersect',
            schema: () =>
                v.intersect([
                    v.object({ a: v.number() }),
                    v.object({ b: v.string() }),
                ]),
        },
        {
            label: 'strict-object',
            schema: () => v.strictObject({ id: v.number() }),
        },
        {
            label: 'loose-object',
            schema: () => v.looseObject({ id: v.number() }),
        },
    ],
    abstain: [
        // Opaque predicate (check) → cannot capture the logic.
        {
            label: 'check',
            schema: () =>
                v.pipe(
                    v.string(),
                    v.check((x) => x.length > 0),
                ),
        },
        // Value-mutating transform → not captured by shape.
        {
            label: 'transform',
            schema: () =>
                v.pipe(
                    v.string(),
                    v.transform((x) => x.length),
                ),
        },
        // Function-valued requirement (integer's requirement is a predicate fn).
        {
            label: 'integer-fn-requirement',
            schema: () => v.pipe(v.number(), v.integer()),
        },
        // Injected default → opaque value injection.
        {
            label: 'optional-default',
            schema: () => v.optional(v.string(), 'fallback'),
        },
        // Branding is a transformation action → abstain.
        {
            label: 'brand',
            schema: () => v.pipe(v.string(), v.brand('UserId')),
        },
        // Lazy / recursive schema is not soundly walkable → abstain.
        {
            label: 'lazy',
            schema: () => v.lazy(() => v.string()),
        },
    ],
};

describe('@stitchapi/fingerprint-valibot', () => {
    it('passes the fingerprint conformance contract', () => {
        const report = verifyFingerprintContract(
            valibotFingerprinter,
            fixtures,
        );
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    it('declares the valibot vendor and a supported range', () => {
        expect(valibotFingerprinter.vendor).toBe('valibot');
        expect(valibotFingerprinter.supports).toBe('^1.0.0');
    });

    it('abstains (null) on an opaque check but fingerprints its base shape', () => {
        const base = valibotFingerprinter.fingerprint(v.string() as never);
        const checked = valibotFingerprinter.fingerprint(
            v.pipe(
                v.string(),
                v.check((x) => x.length > 0),
            ) as never,
        );
        expect(base.value).not.toBeNull();
        expect(checked.value).toBeNull();
    });
});
