// Tests for the ADR 0004 fingerprint contract: the hash primitive, the registry,
// the resolveFingerprint fallback ladder, and the verifyFingerprintContract
// self-test (a sound strategy passes; broken ones yield NAMED violations, not
// throws — mirroring conformance-kit.spec.ts).
import {
    type FingerprintInput,
    type SchemaFingerprinter,
    clearFingerprinters,
    getFingerprinter,
    hash,
    listFingerprinters,
    registerFingerprinter,
    resolveFingerprint,
} from '../src/fingerprint';
import type { StandardSchemaV1 } from '../src/standard-schema';
import { assertConformance, verifyFingerprintContract } from '../src/testing';
import type { FingerprintFixtures } from '../src/testing';

import { beforeEach, describe, expect, it } from 'vitest';

// A minimal real Standard Schema carrying an inspectable `__desc` the test
// strategy fingerprints (stand-in for a validator's internal structure).
function fakeSchema(
    desc: unknown,
    vendor = 'test',
): StandardSchemaV1 & { readonly __desc: unknown } {
    return {
        '~standard': {
            version: 1,
            vendor,
            validate: (value: unknown) => ({ value }),
        },
        __desc: desc,
    };
}

// Key-order-insensitive JSON encoding, so structurally-equal descriptors match.
function canonical(value: unknown): string {
    return JSON.stringify(value, (_k, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                  Object.entries(v as Record<string, unknown>).sort(
                      ([a], [b]) => a.localeCompare(b),
                  ),
              )
            : v,
    );
}

// Reference strategy: canonicalise + hash the descriptor; abstain on `opaque`.
const refFingerprinter: SchemaFingerprinter = {
    vendor: 'test',
    supports: '*',
    fingerprint(schema) {
        const desc = (schema as { __desc?: unknown }).__desc;
        if (desc && typeof desc === 'object' && 'opaque' in desc) {
            return { token: null, strength: 'strong' };
        }
        return { token: hash(canonical(desc)), strength: 'strong' };
    },
};

describe('hash', () => {
    it('is deterministic for the same input', () => {
        expect(hash('hello')).toBe(hash('hello'));
    });

    it('differs for different inputs', () => {
        expect(hash('a')).not.toBe(hash('b'));
        expect(hash('user|v1')).not.toBe(hash('user|v2'));
    });

    it('returns an opaque 128-bit token (32-char hex)', () => {
        const h = hash('the quick brown fox');
        expect(h).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('registry', () => {
    beforeEach(() => {
        clearFingerprinters();
    });

    it('registers, retrieves, lists, and clears', () => {
        expect(getFingerprinter('test')).toBeUndefined();
        registerFingerprinter(refFingerprinter);
        expect(getFingerprinter('test')).toBe(refFingerprinter);
        expect(listFingerprinters()).toContain(refFingerprinter);
        clearFingerprinters();
        expect(getFingerprinter('test')).toBeUndefined();
    });

    it('last registration for a vendor wins', () => {
        const other: SchemaFingerprinter = {
            vendor: 'test',
            supports: '*',
            fingerprint: () => ({ token: 'x', strength: 'strong' }),
        };
        registerFingerprinter(refFingerprinter);
        registerFingerprinter(other);
        expect(getFingerprinter('test')).toBe(other);
    });
});

describe('resolveFingerprint — the fallback ladder', () => {
    beforeEach(() => {
        clearFingerprinters();
        registerFingerprinter(refFingerprinter);
    });

    const userSchema = () =>
        fakeSchema({ type: 'object', fields: { id: 'number' } });

    it('rung 1: explicit version is authoritative (fast)', () => {
        const r = resolveFingerprint({ output: userSchema(), version: 'v3' });
        expect(r.policy).toBe('fast');
        expect(r.reason).toBe('explicit cache.version');
        expect(r.generation).not.toBe('');
    });

    it('rung 1: version wins even over an opaque transform', () => {
        const r = resolveFingerprint({
            output: userSchema(),
            transform: (b) => b,
            version: 7,
        });
        expect(r.policy).toBe('fast');
    });

    it('rung 1: different version or pick → different generation', () => {
        const a = resolveFingerprint({ version: 'v1' });
        const b = resolveFingerprint({ version: 'v2' });
        const c = resolveFingerprint({ version: 'v1', pick: 'data' });
        expect(a.generation).not.toBe(b.generation);
        expect(a.generation).not.toBe(c.generation);
    });

    it('rung 2: sound fingerprint → fast, stable, schema-sensitive', () => {
        const r1 = resolveFingerprint({ output: userSchema() });
        const r2 = resolveFingerprint({ output: userSchema() });
        expect(r1.policy).toBe('fast');
        expect(r1.reason).toBe('sound structural fingerprint');
        expect(r1.generation).toBe(r2.generation); // stable

        const changed = resolveFingerprint({
            output: fakeSchema({ type: 'object', fields: { id: 'string' } }),
        });
        expect(changed.generation).not.toBe(r1.generation); // sensitive
    });

    it('rung 2: pick is folded into the generation', () => {
        const a = resolveFingerprint({ output: userSchema() });
        const b = resolveFingerprint({ output: userSchema(), pick: 'data' });
        expect(b.policy).toBe('fast');
        expect(b.generation).not.toBe(a.generation);
    });

    it('rung 2: a versioned transform is sound and folded in', () => {
        const base: FingerprintInput = {
            output: userSchema(),
            transform: (b) => b,
        };
        const a = resolveFingerprint({ ...base, transformVersion: 1 });
        const b = resolveFingerprint({ ...base, transformVersion: 2 });
        expect(a.policy).toBe('fast');
        expect(b.policy).toBe('fast');
        expect(a.generation).not.toBe(b.generation);
    });

    it('rung 2: trustTransform + sound schema → fast', () => {
        const r = resolveFingerprint({
            output: userSchema(),
            transform: (b) => b,
            trustTransform: true,
        });
        expect(r.policy).toBe('fast');
    });

    it('rung 5: unknown/unregistered vendor → refuse by default', () => {
        clearFingerprinters();
        const r = resolveFingerprint({ output: userSchema() });
        expect(r.policy).toBe('refuse');
        expect(r.reason).toContain('no fingerprinter registered');
    });

    it('rung 5: opt-in onUnfingerprintable:revalidate', () => {
        clearFingerprinters();
        const r = resolveFingerprint({
            output: userSchema(),
            onUnfingerprintable: 'revalidate',
        });
        expect(r.policy).toBe('revalidate');
    });

    it('rung 5: strategy abstains → refuse', () => {
        const r = resolveFingerprint({
            output: fakeSchema({ type: 'object', opaque: true }),
        });
        expect(r.policy).toBe('refuse');
        expect(r.reason).toContain('abstained');
    });

    it('rung 5: non-Standard-Schema output → refuse', () => {
        const r = resolveFingerprint({ output: { not: 'a schema' } });
        expect(r.policy).toBe('refuse');
        expect(r.reason).toContain('output is not a Standard Schema');
    });

    it('rung 4: no output → fast (no shape to go stale)', () => {
        const r = resolveFingerprint({});
        expect(r.policy).toBe('fast');
        expect(r.reason).toBe('no output schema');
        expect(r.generation).not.toBe('');
    });

    it('rung 2: un-versioned transform → refuse', () => {
        const r = resolveFingerprint({
            output: userSchema(),
            transform: (b) => b,
        });
        expect(r.policy).toBe('refuse');
        expect(r.reason).toContain('opaque transform');
    });
});

describe('verifyFingerprintContract', () => {
    const goodFixtures: FingerprintFixtures = {
        stable: [
            {
                label: 'user',
                schema: () =>
                    fakeSchema({
                        type: 'object',
                        fields: { id: 'number', name: 'string' },
                    }),
            },
        ],
        equivalent: [
            {
                label: 'key-order',
                a: () =>
                    fakeSchema({
                        type: 'object',
                        fields: { id: 'number', name: 'string' },
                    }),
                b: () =>
                    fakeSchema({
                        type: 'object',
                        fields: { name: 'string', id: 'number' },
                    }),
            },
        ],
        distinct: [
            {
                label: 'base',
                schema: () =>
                    fakeSchema({ type: 'object', fields: { id: 'number' } }),
            },
            {
                label: 'added-field',
                schema: () =>
                    fakeSchema({
                        type: 'object',
                        fields: { id: 'number', name: 'string' },
                    }),
            },
            {
                label: 'type-changed',
                schema: () =>
                    fakeSchema({ type: 'object', fields: { id: 'string' } }),
            },
        ],
        abstain: [
            {
                label: 'opaque-refine',
                schema: () => fakeSchema({ type: 'object', opaque: true }),
            },
        ],
    };

    it('a sound strategy passes every rule', () => {
        const report = verifyFingerprintContract(
            refFingerprinter,
            goodFixtures,
        );
        expect(report.ok).toBe(true);
        expect(report.violations).toEqual([]);
        expect(() => {
            assertConformance(report);
        }).not.toThrow();
    });

    it('committed snapshots that match pass; drift is a named violation', () => {
        const baseValue =
            refFingerprinter.fingerprint(
                fakeSchema({ type: 'object', fields: { id: 'number' } }),
            ).token ?? '';
        const ok = verifyFingerprintContract(refFingerprinter, {
            ...goodFixtures,
            snapshots: { base: baseValue },
        });
        expect(ok.ok).toBe(true);

        const drifted = verifyFingerprintContract(refFingerprinter, {
            ...goodFixtures,
            snapshots: { base: 'stale-token' },
        });
        expect(drifted.ok).toBe(false);
        expect(drifted.violations.map((v) => v.rule)).toContain(
            'snapshots: fingerprints match committed cross-version snapshots',
        );
    });

    it('a constant-token strategy fails distinct + abstain, as a report', () => {
        const broken: SchemaFingerprinter = {
            vendor: 'test',
            supports: '*',
            fingerprint: () => ({ token: 'CONST', strength: 'strong' }),
        };
        const report = verifyFingerprintContract(broken, goodFixtures);
        expect(report.ok).toBe(false);
        const failed = report.violations.map((v) => v.rule);
        expect(failed).toContain(
            'distinct: semantically-different schemas → distinct fingerprints',
        );
        expect(failed).toContain(
            'abstain: opaque/unrepresentable schemas → null (soundness)',
        );
        expect(() => {
            assertConformance(report);
        }).toThrow();
    });

    it('an async strategy violates the sync result-shape rule', () => {
        // Deliberately violates the synchronous contract (cast through unknown).
        const asyncFp = {
            vendor: 'test',
            supports: '*',
            fingerprint: () =>
                Promise.resolve({ token: 'x', strength: 'strong' }),
        } as unknown as SchemaFingerprinter;
        const report = verifyFingerprintContract(asyncFp, goodFixtures);
        expect(report.ok).toBe(false);
    });

    it('a vendor mismatch is caught', () => {
        const report = verifyFingerprintContract(refFingerprinter, {
            stable: [
                {
                    label: 'wrong-vendor',
                    schema: () => fakeSchema({ x: 1 }, 'zod'),
                },
            ],
            distinct: [
                {
                    label: 'wrong-vendor',
                    schema: () => fakeSchema({ x: 1 }, 'zod'),
                },
            ],
        });
        expect(report.ok).toBe(false);
        expect(report.violations.map((v) => v.rule)).toContain(
            'vendor: strategy.vendor matches every fixture schema',
        );
    });
});
