// Type-level inference: read the result type straight off a validation schema, so a stitch's
// generic can be inferred instead of hand-written. Pure types — nothing here exists at runtime
// (the actual coercion is `toValidator()` in validator.ts). This is what lets
// `stitch({ output: userSchema })` resolve to `Stitch<User>` with no explicit generic and no cast.
import type { StandardSchemaV1 } from './standard-schema';
import type { DriftSpec } from './types';
import type { Validator } from './validator';

/**
 * Any schema shape a stitch accepts wherever a {@link Validator} was previously required —
 * `output` and the `input.*` slots. Widening to this union is what removes the old `asValidator`
 * cast: a raw Zod / Standard Schema / predicate now type-checks directly.
 */
export type SchemaLike =
    | Validator
    | StandardSchemaV1<unknown, unknown>
    | { readonly _output: unknown } // Zod (v3/v4) phantom marker
    | ((value: unknown) => boolean); // plain predicate / type guard

/**
 * Extract the validated RESULT type a schema produces, in priority order: a `drift()` wrapper,
 * any Standard Schema (`~standard.types.output` — Valibot, ArkType, Zod ≥3.24, Zod 4), a Zod
 * schema (its `_output` phantom, covering Zod < 3.24 which predates Standard Schema), a
 * hand-rolled {@link Validator}, and a type-guard predicate (the guarded type). Anything else →
 * unknown. Note a predicate TypeScript infers as a guard counts here: `(v) => v != null` is typed
 * `(v) => v is {}`, so it yields `{}`; only a non-narrowing `(v) => boolean` falls through to unknown.
 */
export type InferOutput<S> =
    S extends DriftSpec<infer D>
        ? D
        : S extends StandardSchemaV1<unknown, infer O>
          ? O
          : S extends { readonly _output: infer O }
            ? O
            : S extends Validator<infer O>
              ? O
              : S extends (value: unknown) => value is infer G
                ? G
                : unknown;

/**
 * Extract the INPUT type a schema accepts (pre-coercion). Used to type call arguments from
 * `input` schemas (Phase 2). A {@link Validator} carries a single type, so it stands in for both
 * sides; a plain predicate / type guard narrows to its guarded type. Anything else → unknown.
 */
export type InferInput<S> =
    S extends StandardSchemaV1<infer I, unknown>
        ? I
        : S extends { readonly _input: infer I }
          ? I
          : S extends Validator<infer O>
            ? O
            : S extends (value: unknown) => value is infer G
              ? G
              : unknown;

/**
 * Map a config object's `output` slot to the stitch result type. No `output` key → `unknown`
 * (the historical default), so a stitch with no response schema is unchanged.
 */
export type OutputOf<C> = C extends { output: infer O }
    ? InferOutput<O>
    : unknown;

/**
 * Resolve a stitch's result type at the call boundary: an explicitly supplied generic always
 * wins (the escape hatch — `stitch<Foo>(...)`); otherwise infer from the config's `output`
 * schema. `[TExplicit] extends [never]` is the "was a generic given?" test (`never` is the
 * default, and the tuple wrapper stops `never` from distributing).
 */
export type ResolveOutput<TExplicit, C> = [TExplicit] extends [never]
    ? OutputOf<C>
    : TExplicit;
