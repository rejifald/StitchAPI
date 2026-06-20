// Conformance proof for the Zod fingerprint strategy, run against BOTH Zod
// majors: the default `zod` import (v3 `_def`) and `zod/v4` (v4 `_zod.def`).
import { zodFingerprinter } from '../src';

import {
    assertConformance,
    verifyFingerprintContract,
} from 'stitchapi/testing';
import type { FingerprintFixtures } from 'stitchapi/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as z4 from 'zod/v4';

const fixtures: FingerprintFixtures = {
    stable: [
        {
            label: 'v3-user',
            schema: () => z.object({ id: z.number(), name: z.string() }),
        },
        { label: 'v3-string-min2', schema: () => z.string().min(2) },
        {
            label: 'v4-user',
            schema: () => z4.object({ id: z4.number(), name: z4.string() }),
        },
    ],
    equivalent: [
        {
            label: 'v3-key-order',
            a: () => z.object({ id: z.number(), name: z.string() }),
            b: () => z.object({ name: z.string(), id: z.number() }),
        },
        {
            label: 'v4-key-order',
            a: () => z4.object({ id: z4.number(), name: z4.string() }),
            b: () => z4.object({ name: z4.string(), id: z4.number() }),
        },
        // Same contract across Zod majors → same fingerprint, so a v3→v4 upgrade
        // that keeps the shape does NOT spuriously invalidate the cache.
        {
            label: 'cross-version-enum',
            a: () => z.enum(['a', 'b']),
            b: () => z4.enum(['a', 'b']),
        },
        // Cross-version stability for less-common types: a v3→v4 upgrade that
        // keeps the shape keeps the fingerprint — and this exercises the v4
        // type-dispatch for each (the original battery only crossed enums).
        { label: 'cross-null', a: () => z.null(), b: () => z4.null() },
        {
            label: 'cross-undefined',
            a: () => z.undefined(),
            b: () => z4.undefined(),
        },
        { label: 'cross-any', a: () => z.any(), b: () => z4.any() },
        { label: 'cross-unknown', a: () => z.unknown(), b: () => z4.unknown() },
        { label: 'cross-never', a: () => z.never(), b: () => z4.never() },
        { label: 'cross-void', a: () => z.void(), b: () => z4.void() },
        { label: 'cross-bigint', a: () => z.bigint(), b: () => z4.bigint() },
        { label: 'cross-date', a: () => z.date(), b: () => z4.date() },
        {
            label: 'cross-set',
            a: () => z.set(z.number()),
            b: () => z4.set(z4.number()),
        },
        {
            label: 'cross-tuple',
            a: () => z.tuple([z.string()]),
            b: () => z4.tuple([z4.string()]),
        },
    ],
    distinct: [
        { label: 'v3-string', schema: () => z.string() },
        { label: 'v3-string-min2', schema: () => z.string().min(2) },
        { label: 'v3-string-min3', schema: () => z.string().min(3) },
        { label: 'v3-number', schema: () => z.number() },
        { label: 'v3-number-int', schema: () => z.number().int() },
        { label: 'v3-boolean', schema: () => z.boolean() },
        { label: 'v3-obj-id', schema: () => z.object({ id: z.number() }) },
        {
            label: 'v3-obj-id-name',
            schema: () => z.object({ id: z.number(), name: z.string() }),
        },
        {
            label: 'v3-obj-id-string',
            schema: () => z.object({ id: z.string() }),
        },
        {
            label: 'v3-obj-id-optional',
            schema: () => z.object({ id: z.number().optional() }),
        },
        {
            label: 'v3-obj-id-nullable',
            schema: () => z.object({ id: z.number().nullable() }),
        },
        { label: 'v3-enum-ab', schema: () => z.enum(['a', 'b']) },
        { label: 'v3-enum-abc', schema: () => z.enum(['a', 'b', 'c']) },
        { label: 'v3-literal-x', schema: () => z.literal('x') },
        { label: 'v3-array-string', schema: () => z.array(z.string()) },
        {
            label: 'v3-union-sn',
            schema: () => z.union([z.string(), z.number()]),
        },
        { label: 'v4-obj-id', schema: () => z4.object({ id: z4.number() }) },
        {
            label: 'v4-obj-id-name',
            schema: () => z4.object({ id: z4.number(), name: z4.string() }),
        },
        { label: 'v4-string-min2', schema: () => z4.string().min(2) },
        { label: 'v4-enum-xy', schema: () => z4.enum(['x', 'y']) },
        // Less-common Zod types the original battery omitted — each exercises a
        // distinct type-dispatch branch and must fingerprint to a unique value.
        { label: 'v3-bigint', schema: () => z.bigint() },
        { label: 'v3-date', schema: () => z.date() },
        { label: 'v3-tuple', schema: () => z.tuple([z.string(), z.number()]) },
        { label: 'v3-record', schema: () => z.record(z.number()) },
        { label: 'v3-map', schema: () => z.map(z.string(), z.number()) },
        { label: 'v3-set', schema: () => z.set(z.number()) },
        {
            label: 'v3-intersection',
            schema: () =>
                z.intersection(
                    z.object({ a: z.number() }),
                    z.object({ b: z.string() }),
                ),
        },
        {
            label: 'v3-readonly',
            schema: () => z.object({ a: z.number() }).readonly(),
        },
        { label: 'v3-branded', schema: () => z.string().brand('UserId') },
        { label: 'v3-null', schema: () => z.null() },
        { label: 'v3-undefined', schema: () => z.undefined() },
        { label: 'v3-any', schema: () => z.any() },
        { label: 'v3-unknown', schema: () => z.unknown() },
        { label: 'v3-never', schema: () => z.never() },
        { label: 'v3-void', schema: () => z.void() },
        { label: 'v3-nan', schema: () => z.nan() },
    ],
    abstain: [
        {
            label: 'v3-refine',
            schema: () => z.string().refine((x) => x.length > 0),
        },
        {
            label: 'v3-transform',
            schema: () => z.string().transform((x) => x.length),
        },
        { label: 'v3-default', schema: () => z.string().default('x') },
        {
            label: 'v4-refine',
            schema: () => z4.string().refine((x) => x.length > 0),
        },
        {
            label: 'v4-transform',
            schema: () => z4.string().transform((x) => x.length),
        },
        { label: 'v4-default', schema: () => z4.string().default('x') },
    ],
};

describe('@stitchapi/fingerprint-zod', () => {
    it('passes the fingerprint conformance contract (Zod v3 + v4)', () => {
        const report = verifyFingerprintContract(zodFingerprinter, fixtures);
        expect(report.violations).toEqual([]);
        expect(report.ok).toBe(true);
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    it('declares the zod vendor and a supported range', () => {
        expect(zodFingerprinter.vendor).toBe('zod');
        expect(zodFingerprinter.supports).toContain('3.24');
    });

    it('abstains (null) on an opaque refine but fingerprints its base shape', () => {
        const base = zodFingerprinter.fingerprint(z.string() as never);
        const refined = zodFingerprinter.fingerprint(
            z.string().refine((x) => x.length > 0) as never,
        );
        expect(base.value).not.toBeNull();
        expect(refined.value).toBeNull();
    });
});
