// Conformance proof for the Effect Schema fingerprint strategy.
//
// A raw Effect schema is not a Standard Schema, so every fixture wraps its schema
// with `S.standardSchemaV1(...)` — that object carries `~standard.vendor ===
// 'effect'` (which the kit enforces) and keeps the `.ast` the strategy reads.
import { effectFingerprinter } from '../src';

import * as S from 'effect/Schema';
import {
    assertConformance,
    verifyFingerprintContract,
} from 'stitchapi/testing';
import type { FingerprintFixtures } from 'stitchapi/testing';
import { describe, expect, it } from 'vitest';

// Helper: wrap a raw Effect schema as the Standard Schema users actually pass.
const std = (build: () => unknown) => () =>
    S.standardSchemaV1(build() as never);

const fixtures: FingerprintFixtures = {
    stable: [
        {
            label: 'user',
            schema: std(() => S.Struct({ id: S.Number, name: S.String })),
        },
        { label: 'string', schema: std(() => S.String) },
        { label: 'union', schema: std(() => S.Union(S.String, S.Number)) },
    ],
    equivalent: [
        {
            // Permuted key order must hash equal — the walker sorts object keys.
            label: 'key-order',
            a: std(() => S.Struct({ id: S.Number, name: S.String })),
            b: std(() => S.Struct({ name: S.String, id: S.Number })),
        },
        {
            // Union member order is irrelevant — members are sorted.
            label: 'union-order',
            a: std(() => S.Union(S.String, S.Number)),
            b: std(() => S.Union(S.Number, S.String)),
        },
    ],
    distinct: [
        { label: 'string', schema: std(() => S.String) },
        { label: 'number', schema: std(() => S.Number) },
        { label: 'boolean', schema: std(() => S.Boolean) },
        { label: 'obj-id', schema: std(() => S.Struct({ id: S.Number })) },
        {
            label: 'obj-id-name', // field added
            schema: std(() => S.Struct({ id: S.Number, name: S.String })),
        },
        {
            label: 'obj-id-string', // field type changed
            schema: std(() => S.Struct({ id: S.String })),
        },
        {
            label: 'obj-id-optional', // optional vs required
            schema: std(() => S.Struct({ id: S.optional(S.Number) })),
        },
        {
            label: 'obj-id-nullable', // nullable
            schema: std(() => S.Struct({ id: S.NullOr(S.Number) })),
        },
        { label: 'union-sn', schema: std(() => S.Union(S.String, S.Number)) },
        { label: 'literal-x', schema: std(() => S.Literal('x')) }, // literal value
        { label: 'literal-y', schema: std(() => S.Literal('y')) },
        { label: 'array-string', schema: std(() => S.Array(S.String)) },
        { label: 'array-number', schema: std(() => S.Array(S.Number)) },
        { label: 'tuple-sn', schema: std(() => S.Tuple(S.String, S.Number)) },
        { label: 'enum-ab', schema: std(() => S.Enums({ A: 'a', B: 'b' })) }, // enum variants
        {
            label: 'enum-abc',
            schema: std(() => S.Enums({ A: 'a', B: 'b', C: 'c' })),
        },
        {
            label: 'record-sn', // a Record must not collide with a struct
            schema: std(() => S.Record({ key: S.String, value: S.Number })),
        },
        { label: 'empty-struct', schema: std(() => S.Struct({})) },
    ],
    abstain: [
        {
            label: 'transform',
            schema: std(() =>
                S.transform(S.String, S.Number, {
                    decode: (s: string) => s.length,
                    encode: (n: number) => String(n),
                }),
            ),
        },
        {
            // An opaque predicate (minLength) → Refinement → abstain.
            label: 'refinement',
            schema: std(() => S.String.pipe(S.minLength(2))),
        },
        {
            label: 'suspend',
            schema: std(() => S.suspend(() => S.String)),
        },
        {
            // An applied constructor default turns the struct into a Transformation.
            label: 'default',
            schema: std(() =>
                S.Struct({
                    a: S.optionalWith(S.String, { default: () => 'x' }),
                }),
            ),
        },
    ],
};

describe('@stitchapi/fingerprint-effect', () => {
    it('passes the fingerprint conformance contract', () => {
        const report = verifyFingerprintContract(effectFingerprinter, fixtures);
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    it('declares the effect vendor and a supported range', () => {
        expect(effectFingerprinter.vendor).toBe('effect');
        expect(effectFingerprinter.supports).toBe('^3.0.0');
    });

    it('abstains (null) on an opaque refinement but fingerprints its base type', () => {
        const base = effectFingerprinter.fingerprint(
            S.standardSchemaV1(S.String) as never,
        );
        const refined = effectFingerprinter.fingerprint(
            S.standardSchemaV1(S.String.pipe(S.minLength(2))) as never,
        );
        expect(base.value).not.toBeNull();
        expect(refined.value).toBeNull();
    });
});
