// Type-level inference: read the result type straight off a validation schema, so a stitch's
// generic can be inferred instead of hand-written. Pure types — nothing here exists at runtime
// (the actual coercion is `toValidator()` in validator.ts). This is what lets
// `stitch({ output: userSchema })` resolve to `Stitch<User>` with no explicit generic and no cast.
import type { StandardSchemaV1 } from './standard-schema';
import type { DriftSpec, InputSchemas, StitchInput } from './types';
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

// ---- Call-argument inference (Phase 2) ------------------------------------
// Type the call argument from the `input` schemas the caller already declares, mirroring how
// `OutputOf` reads `output`. Pure types: the runtime input path (`normalizeInput` → `validateInput`)
// is unchanged — it reads input by field name regardless of its static type.

/**
 * Flatten an intersection of mapped types into a single object literal. Without this the call-arg
 * type stays an `A & B & C` intersection: unreadable in errors and — crucially — NOT
 * identity-comparable in tsd, so `Parameters<S>[0]` assertions couldn't bite. The trailing `& {}`
 * forces eager evaluation.
 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** The slots an `input` schema can validate (see {@link InputSchemas}): params, query, body, headers. */
type SchemaSlots = keyof InputSchemas;
/** {@link StitchInput} keys with no schema slot — `variables` (GraphQL). Carried through untyped. */
type ExtraSlots = Exclude<keyof StitchInput, SchemaSlots>;
/**
 * The pre-coercion input type a declared slot accepts. `NonNullable` keeps it sound when `I` is the
 * declared (optional-slot) {@link InputSchemas} type rather than the inline object literal the caller
 * wrote — in the literal case the written key is already required and `NonNullable` is a no-op.
 */
type SlotInput<I, K extends keyof I> = InferInput<NonNullable<I[K]>>;

/**
 * Which declared slots are REQUIRED in the call argument: a slot is required iff its input type does
 * not accept `undefined`. So a `.optional()` schema (input includes `undefined`), or an unrecognized
 * schema that falls through to `unknown`, yields an OPTIONAL slot — the test fails open, never closed.
 */
type RequiredSchemaKeys<I> = {
    [K in SchemaSlots]: K extends keyof I
        ? undefined extends SlotInput<I, K>
            ? never
            : K
        : never;
}[SchemaSlots];

/**
 * The typed call argument for a config whose `input` is `I`: required schema slots, optional schema
 * slots, and the untyped `variables` passthrough (always optional). {@link Prettify} collapses the
 * required∩optional split into one flat object.
 */
type CallInput<I> = Prettify<
    { [K in RequiredSchemaKeys<I> & keyof I]: SlotInput<I, K> } & {
        [K in Exclude<SchemaSlots, RequiredSchemaKeys<I>> & keyof I]?: Exclude<
            SlotInput<I, K>,
            undefined
        >;
    } & { [K in ExtraSlots]?: StitchInput[K] }
>;

/**
 * Map a config object's `input` slot to the typed call argument. No `input` key → the loose
 * {@link StitchInput} (the historical default), so a stitch with no input schemas is unchanged and
 * its argument stays fully optional. Like {@link OutputOf}, this reads only the top-level `input`
 * key, not `extends` fragments.
 */
export type InputOf<C> = C extends { input: infer I }
    ? CallInput<I>
    : StitchInput;

/** The required (non-optional) keys of `T`. (`Record<never, never>` is the empty object `{}` — the
 * standard "is this key optional?" probe — spelled to avoid a bare `{}` type.) */
type RequiredKeys<T> = {
    [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];
/** Whether `T` has any required key. Degenerate `unknown`/`any` → `false` (fails open to optional). */
type HasRequired<T> = [RequiredKeys<T>] extends [never] ? false : true;
/**
 * The call/`stream` parameter list for an input type `TIn`: a single argument that is REQUIRED when
 * `TIn` has a required key (e.g. a non-optional `body` schema) and OPTIONAL otherwise. So `ping()`
 * (no input schemas → loose {@link StitchInput}, no required keys) stays legal, while `createUser()`
 * (required body) is a compile error.
 */
export type Args<TIn> =
    HasRequired<TIn> extends true ? [input: TIn] : [input?: TIn];
/**
 * Relax the top-level slots named by `K` to optional, leaving the rest of `T` unchanged — the
 * type-level image of `.with()`'s shallow per-slot bind: after binding `body`, the returned stitch's
 * call argument no longer requires it (but a still-unbound required slot stays required).
 */
export type RelaxKeys<T, K extends PropertyKey> = Prettify<
    Omit<T, Extract<keyof T, K>> & Partial<Pick<T, Extract<keyof T, K>>>
>;
