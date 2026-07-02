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
        // Domains / keywords / composites the original battery omitted — each
        // exercises a distinct walker path and must hash to a unique value.
        { label: 'bigint', schema: () => type('bigint') },
        { label: 'symbol', schema: () => type('symbol') },
        { label: 'date', schema: () => type('Date') },
        { label: 'string-email', schema: () => type('string.email') },
        { label: 'string-uuid', schema: () => type('string.uuid') },
        { label: 'record', schema: () => type({ '[string]': 'number' }) },
        {
            label: 'intersection',
            schema: () => type({ a: 'number' }).and({ b: 'string' }),
        },
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
        // BUILT-IN morph/predicate keywords. ArkType represents these with opaque
        // `$ark.*` references that are NOT the literal `$ark.fn` — e.g.
        // `morphs:["$ark.parseJson"]`, `morphs:["$ark.morphs<n>"]`,
        // `predicate:"$ark.isParsableDate"`. They carry value-transforming /
        // opaque-closure logic the walker can't faithfully capture, so a stable
        // token would under-invalidate the cache (ADR 0004). All must abstain.
        {
            // morphs: ["$ark.parseJson"] — a named built-in parser.
            label: 'string.json.parse',
            schema: () => type('string.json.parse'),
        },
        {
            // morphs: ["$ark.morphs<n>"] — counter-based, non-deterministic.
            label: 'string.numeric.parse',
            schema: () => type('string.numeric.parse'),
        },
        {
            label: 'string.integer.parse',
            schema: () => type('string.integer.parse'),
        },
        {
            // Both a morph AND a `$ark.isParsableDate` predicate.
            label: 'string.date.parse',
            schema: () => type('string.date.parse'),
        },
        {
            // predicate: "$ark.isParsableDate" — opaque predicate, no morph.
            label: 'string.date',
            schema: () => type('string.date'),
        },
        {
            // predicate: "$ark.isParsableUrl" — opaque predicate.
            label: 'string.url',
            schema: () => type('string.url'),
        },
        {
            // morphs: ["$ark.morphs<n>"] — a value-transforming format morph.
            label: 'string.lower',
            schema: () => type('string.lower'),
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
        expect(base.token).not.toBeNull();
        expect(morphed.token).toBeNull();
    });

    it('abstains on BUILT-IN morph/predicate keywords (not just $ark.fn)', () => {
        // ArkType emits opaque `$ark.*` refs for its built-in parsers/predicates
        // (e.g. `$ark.parseJson`, `$ark.morphs<n>`, `$ark.isParsableDate`) that
        // are NOT the literal `$ark.fn`. Each carries value-transforming/opaque
        // logic the walker can't capture, so a token would under-invalidate the
        // cache (ADR 0004). All must abstain.
        const builtins = [
            'string.json.parse', // morphs: ["$ark.parseJson"]
            'string.numeric.parse', // morphs: ["$ark.morphs<n>"]
            'string.integer.parse',
            'string.date.parse', // morph + "$ark.isParsableDate" predicate
            'string.date', // predicate: "$ark.isParsableDate"
            'string.url', // predicate: "$ark.isParsableUrl"
            'string.lower', // morphs: ["$ark.morphs<n>"] (format morph)
        ] as const;
        for (const keyword of builtins) {
            const f = arktypeFingerprinter.fingerprint(type(keyword) as never);
            expect(f.token, `${keyword} should abstain`).toBeNull();
        }

        // A pure structural keyword carrying no opaque logic still fingerprints —
        // the fix must not over-abstain. (`string.email` is a plain regex pattern;
        // its JSON contains no `$ark.` reference at all.)
        const structural = arktypeFingerprinter.fingerprint(
            type('string.email') as never,
        );
        expect(structural.token).not.toBeNull();
    });
});
