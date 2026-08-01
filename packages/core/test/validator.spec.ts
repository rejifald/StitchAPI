// Direct unit tests for toValidator (src/validator.ts) — the adapter that coerces a Zod schema,
// any Standard Schema, an existing Validator, or a plain predicate into one Validator shape.
// gaps/tovalidator-predicate.spec.ts covers the predicate arm; the other arms (and the contract
// details) were only exercised indirectly through real Zod usage. These pin them with fakes:
//   - null/undefined → undefined;
//   - an existing {validate} object is returned unchanged;
//   - the Zod (safeParse) arm maps success.data and issue lists (defaulting a missing path to []);
//   - the Standard Schema arm unwraps `value` and FLATTENS object path segments ({key} → key);
//   - an unsupported input throws the helpful error;
//   - the raw schema is attached as a NON-enumerable `source` (ADR 0004 — for cache fingerprinting).
import { toValidator } from '../src/validator';
import type { Validator } from '../src/validator';

describe('toValidator: passthrough, null, and unsupported input', () => {
    test('null and undefined coerce to undefined', () => {
        expect(toValidator(null)).toBeUndefined();
        expect(toValidator(undefined)).toBeUndefined();
    });

    test('an existing {validate} Validator is returned as-is', () => {
        const v: Validator = { validate: async () => ({ ok: true, value: 1 }) };
        expect(toValidator(v)).toBe(v);
    });

    test('an unsupported schema throws a helpful error', () => {
        expect(() => toValidator(42)).toThrow(/Unsupported schema/);
        expect(() => toValidator('nope')).toThrow(/Unsupported schema/);
    });
});

describe('toValidator: Zod-style (safeParse)', () => {
    const zodLike = {
        safeParse: (v: unknown) =>
            v === 'ok'
                ? { success: true, data: 'DATA' }
                : {
                      success: false,
                      error: {
                          issues: [
                              { path: ['a', 0], message: 'bad' },
                              { message: 'no-path' },
                          ],
                      },
                  },
    };

    test('success maps to { ok, value: data }', async () => {
        const r = await toValidator(zodLike)!.validate('ok');
        expect(r).toEqual({ ok: true, value: 'DATA' });
    });

    test('failure maps issues, defaulting a missing path to []', async () => {
        const r = await toValidator(zodLike)!.validate('x');
        expect(r).toEqual({
            ok: false,
            issues: [
                { path: ['a', 0], message: 'bad' },
                { path: [], message: 'no-path' },
            ],
        });
    });
});

describe('toValidator: Standard Schema (~standard)', () => {
    const stdLike = {
        '~standard': {
            version: 1,
            vendor: 'fake',
            validate: (v: unknown) =>
                v === 'ok'
                    ? { value: 'V' }
                    : {
                          issues: [{ message: 'm', path: ['x', { key: 'y' }] }],
                      },
        },
    };

    test('success unwraps the validated value', async () => {
        const r = await toValidator(stdLike)!.validate('ok');
        expect(r).toEqual({ ok: true, value: 'V' });
    });

    test('failure flattens an object path segment ({key}) to its key', async () => {
        const r = await toValidator(stdLike)!.validate('x');
        expect(r).toEqual({
            ok: false,
            issues: [{ path: ['x', 'y'], message: 'm' }],
        });
    });
});

describe('toValidator: source attachment (ADR 0004)', () => {
    test('attaches the raw schema as a NON-enumerable `source`', () => {
        const zodLike = { safeParse: () => ({ success: true, data: 1 }) };
        const v = toValidator(zodLike)!;
        expect(v.schema).toBe(zodLike); // readable for cache fingerprinting
        expect(Object.keys(v)).not.toContain('schema'); // never enumerated
        expect(Object.getOwnPropertyDescriptor(v, 'schema')?.enumerable).toBe(
            false,
        );
    });
});
