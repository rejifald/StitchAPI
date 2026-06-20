// Direct unit tests for isStandardSchema (src/standard-schema.ts) — the structural type guard
// that every schema-consuming path leans on (validator, fingerprint, openapi, testing). It had
// no direct test, yet two of its branches are deliberate and easy to regress:
//   - it accepts a *function* carrying `~standard`, not just an object — callable validators
//     exist (e.g. an arktype type IS a function), which is the whole reason it checks
//     `typeof x === 'function'` alongside `'object'`;
//   - it must return false (never throw) for primitives — the typeof check short-circuits the
//     `'~standard' in x` test, which would otherwise TypeError on a string/number.
import { isStandardSchema } from '../src/standard-schema';
import type { StandardSchemaV1 } from '../src/standard-schema';

const schemaLike = (): StandardSchemaV1 => ({
    '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
    },
});

describe('isStandardSchema', () => {
    it('accepts an object exposing ~standard', () => {
        expect(isStandardSchema(schemaLike())).toBe(true);
    });

    it('accepts a function exposing ~standard (callable validators)', () => {
        const callable = (value: unknown) => value;
        (callable as unknown as Record<string, unknown>)['~standard'] =
            schemaLike()['~standard'];
        expect(isStandardSchema(callable)).toBe(true);
    });

    it('rejects an object without ~standard', () => {
        expect(isStandardSchema({})).toBe(false);
        expect(isStandardSchema({ validate: () => ({ value: 1 }) })).toBe(false);
    });

    it('rejects a plain function without ~standard', () => {
        expect(isStandardSchema(() => undefined)).toBe(false);
    });

    it('rejects null and undefined', () => {
        expect(isStandardSchema(null)).toBe(false);
        expect(isStandardSchema(undefined)).toBe(false);
    });

    it('returns false (never throws) for primitives', () => {
        // The `typeof` guard must short-circuit before `'~standard' in x`, which would
        // otherwise throw "Cannot use 'in' operator" on a string/number/boolean.
        expect(isStandardSchema('a string')).toBe(false);
        expect(isStandardSchema(42)).toBe(false);
        expect(isStandardSchema(true)).toBe(false);
        expect(isStandardSchema(0)).toBe(false);
        expect(isStandardSchema('')).toBe(false);
    });

    it('rejects arrays (object, but no ~standard key)', () => {
        expect(isStandardSchema([])).toBe(false);
        expect(isStandardSchema([schemaLike()])).toBe(false);
    });

    it('is purely structural — only the key presence is checked, not its shape', () => {
        // The guard is intentionally minimal: it does not validate version/vendor/validate.
        expect(isStandardSchema({ '~standard': null })).toBe(true);
    });
});
