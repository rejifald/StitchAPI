// Conformance proof for the TypeBox fingerprint strategy.
//
// TypeBox 0.34 schemas are plain JSON Schema objects keyed by `Symbol(TypeBox.Kind)`
// and do NOT expose a `~standard` surface — so the registry cannot dispatch a raw
// TypeBox schema to a fingerprinter today. The conformance kit (rightly) enforces
// that every fixture is a Standard Schema whose `~standard.vendor` matches the
// strategy's vendor. We therefore wrap each TypeBox schema with `std()`, attaching
// a minimal `~standard` while PRESERVING the JSON-Schema props + `Symbol(TypeBox.*)`
// markers the strategy reads. TypeBox must be surfaced this way (via such a wrapper
// or a future TypeBox release) to participate in the registry; the fingerprint
// LOGIC is what this package proves.
import { typeboxFingerprinter } from '../src';

import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';
import {
    assertConformance,
    verifyFingerprintContract,
} from 'stitchapi/testing';
import type { FingerprintFixtures } from 'stitchapi/testing';
import { describe, expect, it } from 'vitest';

// Attach a minimal Standard Schema surface in place. `Object.assign` mutates the
// TypeBox schema so its JSON-Schema props and `Symbol(TypeBox.*)` markers survive —
// the strategy reads those, and the kit reads `~standard.vendor`.
function std<T extends TSchema>(tb: T): T {
    return Object.assign(tb, {
        '~standard': {
            version: 1,
            vendor: 'typebox',
            validate: (value: unknown) => ({ value }),
        },
    });
}

const fixtures: FingerprintFixtures = {
    stable: [
        {
            label: 'user',
            schema: () =>
                std(
                    Type.Object({
                        id: Type.Number(),
                        name: Type.String({ minLength: 2 }),
                    }),
                ),
        },
        {
            label: 'string-min2',
            schema: () => std(Type.String({ minLength: 2 })),
        },
        {
            label: 'array-of-string',
            schema: () => std(Type.Array(Type.String())),
        },
    ],
    equivalent: [
        // Permuted KEY ORDER in the same object must hash equal — the walker sorts
        // object keys (both top-level and the `properties`/`required` it produces).
        {
            label: 'key-order',
            a: () =>
                std(
                    Type.Object({
                        id: Type.Number(),
                        name: Type.String(),
                    }),
                ),
            b: () =>
                std(
                    Type.Object({
                        name: Type.String(),
                        id: Type.Number(),
                    }),
                ),
        },
    ],
    distinct: [
        // 1. base object
        {
            label: 'obj-id',
            schema: () => std(Type.Object({ id: Type.Number() })),
        },
        // 2. field added
        {
            label: 'obj-id-name',
            schema: () =>
                std(Type.Object({ id: Type.Number(), name: Type.String() })),
        },
        // 3. field type changed (number -> string)
        {
            label: 'obj-id-string',
            schema: () => std(Type.Object({ id: Type.String() })),
        },
        // 4. optional vs required
        {
            label: 'obj-id-optional',
            schema: () =>
                std(Type.Object({ id: Type.Optional(Type.Number()) })),
        },
        // 5. constraint value: minLength 2 vs 3
        {
            label: 'string-min2',
            schema: () => std(Type.String({ minLength: 2 })),
        },
        {
            label: 'string-min3',
            schema: () => std(Type.String({ minLength: 3 })),
        },
        // 6. format added
        {
            label: 'string-email',
            schema: () => std(Type.String({ format: 'email' })),
        },
        // 7. enum / union variants differ
        {
            label: 'enum-ab',
            schema: () =>
                std(Type.Union([Type.Literal('a'), Type.Literal('b')])),
        },
        {
            label: 'enum-abc',
            schema: () =>
                std(
                    Type.Union([
                        Type.Literal('a'),
                        Type.Literal('b'),
                        Type.Literal('c'),
                    ]),
                ),
        },
        // 8. literal value
        { label: 'literal-x', schema: () => std(Type.Literal('x')) },
        // a few more for good measure
        { label: 'number', schema: () => std(Type.Number()) },
        { label: 'integer', schema: () => std(Type.Integer()) },
        { label: 'boolean', schema: () => std(Type.Boolean()) },
        {
            label: 'array-string',
            schema: () => std(Type.Array(Type.String())),
        },
        {
            label: 'union-string-number',
            schema: () => std(Type.Union([Type.String(), Type.Number()])),
        },
        // Representable JSON-Schema shapes the original battery omitted — each
        // exercises a distinct walker path and must hash to a unique value.
        { label: 'null', schema: () => std(Type.Null()) },
        { label: 'date', schema: () => std(Type.Date()) },
        { label: 'bigint', schema: () => std(Type.BigInt()) },
        { label: 'uint8array', schema: () => std(Type.Uint8Array()) },
        {
            label: 'tuple',
            schema: () => std(Type.Tuple([Type.String(), Type.Number()])),
        },
        {
            label: 'record',
            schema: () => std(Type.Record(Type.String(), Type.Number())),
        },
        {
            label: 'intersect',
            schema: () =>
                std(
                    Type.Intersect([
                        Type.Object({ a: Type.Number() }),
                        Type.Object({ b: Type.String() }),
                    ]),
                ),
        },
    ],
    abstain: [
        // A transform attaches an opaque Decode/Encode codec, invisible to the
        // JSON Schema → must abstain.
        {
            label: 'transform',
            schema: () =>
                std(
                    Type.Transform(Type.String())
                        .Decode((s) => s)
                        .Encode((s) => s) as unknown as TSchema,
                ),
        },
        // A transform nested inside an object — caught by the recursive walk even
        // though the top-level object looks like a plain `{ a: string }`.
        {
            label: 'nested-transform',
            schema: () =>
                std(
                    Type.Object({
                        a: Type.Transform(Type.String())
                            .Decode((s) => s)
                            .Encode((s) => s) as unknown as TSchema,
                    }),
                ),
        },
        // Opaque kinds with no soundly-hashable structure.
        { label: 'any', schema: () => std(Type.Any()) },
        { label: 'unknown', schema: () => std(Type.Unknown()) },
        {
            label: 'function',
            schema: () => std(Type.Function([Type.String()], Type.Number())),
        },
        { label: 'unsafe', schema: () => std(Type.Unsafe({})) },
    ],
};

describe('@stitchapi/fingerprint-typebox', () => {
    it('passes the conformance contract', () => {
        const r = verifyFingerprintContract(typeboxFingerprinter, fixtures);
        expect(r.violations).toEqual([]);
        expect(r.ok).toBe(true);
        expect(() => {
            assertConformance(r);
        }).not.toThrow();
    });

    it('declares the typebox vendor and a supported range', () => {
        expect(typeboxFingerprinter.vendor).toBe('typebox');
        expect(typeboxFingerprinter.range).toContain('0.34');
    });

    it('abstains (null) on an opaque transform but fingerprints its base shape', () => {
        const base = typeboxFingerprinter.fingerprint(
            std(Type.String()) as never,
        );
        const transformed = typeboxFingerprinter.fingerprint(
            std(
                Type.Transform(Type.String())
                    .Decode((s) => s)
                    .Encode((s) => s) as unknown as TSchema,
            ) as never,
        );
        expect(base.token).not.toBeNull();
        expect(transformed.token).toBeNull();
    });
});
