// `validate(schema, value)` and `compile(schema)` — the standalone counterparts to the check a
// stitch runs on `input`/`output`. The point under test is UNIFORMITY: one intake (any SchemaLike:
// raw Zod, a JsonSchema.adapt-style Standard Schema, a predicate) and one result shape
// (`{ ok, value } | { ok, issues }`), identical to what a stitch validates internally. Plus the two
// guarantees the wrapper adds over reaching into `['~standard'].validate` directly: an `ok`
// discriminant, and normalised array issue paths.
import { compile, validate } from '../src';

import { z } from 'zod';

// A hand-built Standard Schema, shaped exactly like `JsonSchema.adapt(...)`'s output: the raw result
// is `{ value } | { issues }` (no `ok`), which `validate`/`compile` normalise to the `ok` form.
const adaptLike = {
    '~standard': {
        version: 1 as const,
        vendor: 'stitchapi-json-schema',
        validate: (v: unknown) => {
            const limit = (v as { limit?: number }).limit;
            return limit !== undefined && limit <= 50
                ? { value: v }
                : { issues: [{ message: 'must be <= 50', path: ['limit'] }] };
        },
    },
};

describe('validate: one intake, one result shape', () => {
    test('accepts a raw Zod schema — success is { ok: true, value }', async () => {
        const User = z.object({ name: z.string() });
        const r = await validate(User, { name: 'Ada' });
        expect(r).toEqual({ ok: true, value: { name: 'Ada' } });
    });

    test('accepts a raw Zod schema — failure is { ok: false, issues } with an array path', async () => {
        const User = z.object({ name: z.string() });
        const r = await validate(User, { name: 42 });
        if (r.ok) throw new Error('expected failure');
        expect(r.issues).toHaveLength(1);
        expect(Array.isArray(r.issues[0]?.path)).toBe(true);
        expect(r.issues[0]?.path).toEqual(['name']);
    });

    test('accepts a JsonSchema.adapt-style Standard Schema', async () => {
        expect(await validate(adaptLike, { limit: 10 })).toEqual({
            ok: true,
            value: { limit: 10 },
        });
        expect(await validate(adaptLike, { limit: 99 })).toEqual({
            ok: false,
            issues: [{ message: 'must be <= 50', path: ['limit'] }],
        });
    });

    test('accepts a bare predicate', async () => {
        const isString = (v: unknown): v is string => typeof v === 'string';
        expect(await validate(isString, 'ok')).toEqual({
            ok: true,
            value: 'ok',
        });
        expect((await validate(isString, 7)).ok).toBe(false);
    });

    test('rejects a non-schema with a TypeError', () => {
        // @ts-expect-error — null is not a SchemaLike; the guard is for JS callers.
        expect(() => validate(null, 1)).toThrow(TypeError);
    });
});

describe('compile: reusable checker, coerced once', () => {
    test('returns the same result as validate()', async () => {
        const User = z.object({ name: z.string() });
        const check = compile(User);
        expect(await check({ name: 'Ada' })).toEqual(
            await validate(User, { name: 'Ada' }),
        );
    });

    test('coerces the schema ONCE across many checks (validate() coerces per call)', async () => {
        // A `safeParse` getter counts each coercion: `toValidator` reads it exactly once per coerce.
        // `_output` makes the fake a valid SchemaLike (Zod-phantom branch); the extra `safeParse`
        // drives the runtime Zod arm.
        const zodLike = (counter: {
            n: number;
        }): { readonly _output: unknown; safeParse: unknown } => ({
            _output: undefined,
            get safeParse() {
                counter.n++;
                return (v: unknown) => ({ success: true, data: v });
            },
        });

        const compiled = { n: 0 };
        const check = compile(zodLike(compiled));
        await check('a');
        await check('b');
        expect(compiled.n).toBe(1); // bound once at compile time

        const oneShot = { n: 0 };
        const schema = zodLike(oneShot);
        await validate(schema, 'a');
        await validate(schema, 'b');
        expect(oneShot.n).toBe(2); // re-coerced each call
    });

    test('rejects a non-schema with a TypeError', () => {
        // @ts-expect-error — null is not a SchemaLike.
        expect(() => compile(null)).toThrow(TypeError);
    });
});
