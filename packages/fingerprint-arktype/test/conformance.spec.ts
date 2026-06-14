// Conformance proof for the ArkType fingerprint strategy (StitchAPI ADR 0004).
import { arktypeFingerprinter } from '../src';

import { type } from 'arktype';
import {
    assertConformance,
    verifyFingerprintContract,
} from 'stitchapi/testing';
import type { FingerprintFixtures } from 'stitchapi/testing';
import { describe, expect, it } from 'vitest';

const fixtures: FingerprintFixtures = {
    stable: [
        {
            label: 'user',
            schema: () => type({ id: 'number', name: 'string>2' }),
        },
        { label: 'string-min2', schema: () => type('string>2') },
        { label: 'union-sn', schema: () => type('string|number') },
        { label: 'tuple', schema: () => type(['string', 'number']) },
    ],
    equivalent: [
        // Permuted object key order must collapse to the same fingerprint so a
        // re-ordered schema definition does not spuriously invalidate the cache.
        {
            label: 'key-order',
            a: () => type({ id: 'number', name: 'string' }),
            b: () => type({ name: 'string', id: 'number' }),
        },
        {
            label: 'key-order-nested',
            a: () => type({ outer: { z: 'string', a: 'number' } }),
            b: () => type({ outer: { a: 'number', z: 'string' } }),
        },
        // ArkType pre-sorts union branches, so order-independence holds there too.
        {
            label: 'union-order',
            a: () => type('string|number'),
            b: () => type('number|string'),
        },
    ],
    distinct: [
        { label: 'string', schema: () => type('string') },
        { label: 'string-min2', schema: () => type('string>2') }, // constraint value
        { label: 'string-min3', schema: () => type('string>3') }, // constraint value (different)
        { label: 'number', schema: () => type('number') }, // domain changed vs string
        { label: 'number-int', schema: () => type('number.integer') }, // added constraint
        { label: 'boolean', schema: () => type('boolean') },
        { label: 'literal-x', schema: () => type('"x"') },
        { label: 'obj-id', schema: () => type({ id: 'number' }) },
        {
            label: 'obj-id-name',
            schema: () => type({ id: 'number', name: 'string' }), // field added
        },
        { label: 'obj-id-string', schema: () => type({ id: 'string' }) }, // field type changed
        {
            label: 'obj-id-name-optional',
            schema: () => type({ id: 'number', 'name?': 'string' }), // optional vs required
        },
        { label: 'string-nullable', schema: () => type('string|null') }, // nullable
        { label: 'array-string', schema: () => type('string[]') },
        { label: 'union-sn', schema: () => type('string|number') }, // union variants
        { label: 'enum-ab', schema: () => type('"a"|"b"') },
        { label: 'enum-abc', schema: () => type('"a"|"b"|"c"') }, // enum variant added
        { label: 'tuple-sn', schema: () => type(['string', 'number']) },
        { label: 'tuple-ns', schema: () => type(['number', 'string']) }, // order-significant
    ],
    abstain: [
        // Morph (.pipe): JSON carries a non-deterministic opaque `$ark.fn` ref.
        {
            label: 'morph',
            schema: () => type('string').pipe((s: string) => s.length),
        },
        // Narrow/predicate: same — opaque closure under `predicate`.
        {
            label: 'narrow',
            schema: () => type('string').narrow((s: string) => s.length > 0),
        },
        // Property default silently rewrites the validated value → abstain.
        {
            label: 'default',
            schema: () => type({ name: 'string = "x"' }),
        },
    ],
};

describe('@stitchapi/fingerprint-arktype', () => {
    it('passes the fingerprint conformance contract', () => {
        const report = verifyFingerprintContract(
            arktypeFingerprinter,
            fixtures,
        );
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    it('declares the arktype vendor and a supported range', () => {
        expect(arktypeFingerprinter.vendor).toBe('arktype');
        expect(arktypeFingerprinter.supports).toBe('^2.0.0');
    });

    it('abstains (null) on an opaque morph but fingerprints its base shape', () => {
        const base = arktypeFingerprinter.fingerprint(type('string') as never);
        const morphed = arktypeFingerprinter.fingerprint(
            type('string').pipe((s: string) => s.length) as never,
        );
        expect(base.value).not.toBeNull();
        expect(morphed.value).toBeNull();
    });
});
