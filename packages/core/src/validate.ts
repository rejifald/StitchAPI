// Standalone validation for any schema a stitch accepts. This is the same normalisation `input`/
// `output` run internally (`toValidator` in validator.ts), exposed as two plain verbs so validating
// a value outside a call is uniform with validating inside one — same {@link SchemaLike} intake,
// same {@link ValidationResult} shape. It replaces reaching into a schema's `['~standard'].validate`,
// which is a protocol-level detail, not an app-facing API (and whose raw result carries no `ok`
// discriminant and can hold non-array issue paths — both normalised here).
import type { InferOutput, SchemaLike } from './infer';
import { type ValidationResult, toValidator } from './validator';

const UNSUPPORTED =
    'validate()/compile() received a value that is not a schema. Fix: pass a Standard Schema, a Zod-style {parse}, a {validate} object, or a (value) => boolean predicate.';

/**
 * Compile a schema into a reusable checker. The schema is coerced ONCE (via the same normalisation
 * a stitch's `input`/`output` use); the returned function validates a value against it and returns
 * `{ ok: true, value }` or `{ ok: false, issues }` — never throwing on invalid data.
 *
 * Reach for this when you validate many values against one schema: the coercion is paid here, not
 * on every call. For a one-off check, {@link validate} is the more direct spelling.
 *
 * `schema` is any {@link SchemaLike} — a hand-written Zod / Valibot / ArkType schema, any Standard
 * Schema (including one from `JsonSchema.adapt`), a `(value) => boolean` predicate, or a
 * {@link Validator}. It is the identical set of schemas a stitch accepts.
 *
 * @example
 * const check = compile(userSchema);
 * const result = await check(payload);
 * if (result.ok) use(result.value); // else result.issues → [{ message, path }]
 */
export function compile<S extends SchemaLike>(
    schema: S,
): (value: unknown) => Promise<ValidationResult<InferOutput<S>>> {
    const validator = toValidator(schema);
    if (!validator) throw new TypeError(UNSUPPORTED);
    return (value) =>
        validator.validate(value) as Promise<ValidationResult<InferOutput<S>>>;
}

/**
 * Validate a value against a schema and return the result — `{ ok: true, value }` or
 * `{ ok: false, issues }`, never throwing on invalid data. The standalone counterpart to the check
 * a stitch runs on `input`/`output`: the same schema, the same result shape.
 *
 * For repeated checks against one schema, {@link compile} coerces once and hands back a reusable
 * checker; `validate(schema, value)` is `compile(schema)(value)` for the single-shot case.
 *
 * @example
 * const result = await validate(userSchema, payload);
 * if (result.ok) use(result.value); // else result.issues → [{ message, path }]
 */
export function validate<S extends SchemaLike>(
    schema: S,
    value: unknown,
): Promise<ValidationResult<InferOutput<S>>> {
    return compile(schema)(value);
}
