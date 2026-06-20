// Edge rungs of resolveFingerprint (src/fingerprint.ts) that fingerprint.spec.ts leaves open. That
// suite walks the ladder thoroughly, but three precedence/folding details go unpinned:
//   - the no-output (rung 4) generation FOLDS `unwrap` and a versioned `transform`, so two
//     no-schema stitches that differ only in those get DISTINCT cache generations (the existing
//     test only checks the policy is fast + the generation is non-empty);
//   - an opaque transform with no output still REFUSES — the transform gate (rung 2) outranks the
//     no-schema fast path (rung 4);
//   - `trustTransform` clears the transform gate but does NOT rescue an un-fingerprintable schema:
//     it still refuses (rung 5), and only `onUnfingerprintable: 'revalidate'` caches it.
import { clearFingerprinters, resolveFingerprint } from '../src/fingerprint';
import type { StandardSchemaV1 } from '../src/standard-schema';

// A Standard Schema for a vendor with NO registered fingerprinter → un-fingerprintable.
const unregisteredSchema = (): StandardSchemaV1 => ({
    '~standard': {
        version: 1,
        vendor: 'unregistered-vendor',
        validate: (value: unknown) => ({ value }),
    },
});

beforeEach(() => {
    clearFingerprinters();
});

describe('resolveFingerprint: no-output (rung 4) folds unwrap + transform', () => {
    it('distinct unwrap → distinct no-schema generation (still fast)', () => {
        const a = resolveFingerprint({ unwrap: 'data' });
        const b = resolveFingerprint({ unwrap: 'meta' });
        expect(a.policy).toBe('fast');
        expect(b.policy).toBe('fast');
        expect(a.generation).not.toBe(b.generation);
    });

    it('distinct transformVersion → distinct no-schema generation (still fast)', () => {
        const fn = (x: unknown) => x;
        const v1 = resolveFingerprint({ transform: fn, transformVersion: 'v1' });
        const v2 = resolveFingerprint({ transform: fn, transformVersion: 'v2' });
        expect(v1.policy).toBe('fast'); // no output → rung 4
        expect(v2.policy).toBe('fast');
        expect(v1.generation).not.toBe(v2.generation);
    });
});

describe('resolveFingerprint: the transform gate outranks the no-schema fast path', () => {
    it('an opaque transform with no output still refuses (rung 2 before rung 4)', () => {
        const r = resolveFingerprint({ transform: (x: unknown) => x });
        expect(r.policy).toBe('refuse');
        expect(r.reason).toContain('opaque transform');
    });
});

describe('resolveFingerprint: trustTransform does not rescue an un-fingerprintable schema', () => {
    it('trustTransform clears the transform gate but an un-fingerprintable schema still refuses', () => {
        const r = resolveFingerprint({
            output: unregisteredSchema(),
            transform: (x: unknown) => x,
            trustTransform: true,
        });
        expect(r.policy).toBe('refuse');
        // The refusal is about the SCHEMA (rung 5), not the transform (rung 2) — it cleared the gate.
        expect(r.reason).toContain('unregistered-vendor');
        expect(r.reason).not.toContain('opaque transform');
    });

    it('the same case caches under onUnfingerprintable: revalidate', () => {
        const r = resolveFingerprint({
            output: unregisteredSchema(),
            transform: (x: unknown) => x,
            trustTransform: true,
            onUnfingerprintable: 'revalidate',
        });
        expect(r.policy).toBe('revalidate');
    });
});
