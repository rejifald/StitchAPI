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

/** The slots an `input` schema can validate (see {@link InputSchemas}): params, query, body, headers, variables. */
type SchemaSlots = keyof InputSchemas;
/** {@link StitchInput} keys with no schema slot — the runtime-only `signal` / `onProgress` controls. Carried through untyped. */
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
 * slots, the runtime-only `signal`/`onProgress` passthrough, and — when no `variables` schema is
 * declared — the untyped `variables` passthrough. {@link Prettify} collapses the required∩optional
 * split into one flat object.
 *
 * The trailing conditional restores backward compatibility: `variables` is now an {@link InputSchemas}
 * slot, so it falls OUT of {@link ExtraSlots}. A graphql config that declares a `variables` schema
 * types it through the slot machinery above; one that declares NONE (`I` has no `variables` key) would
 * otherwise lose the optional `variables?` it used to carry — so re-add it here as the loose
 * passthrough. The `I extends { variables: unknown }` probe is true only when a `variables` key was
 * actually written, so the two branches never overlap (no typed-vs-loose clash on the same key).
 */
type CallInput<I> = Prettify<
    { [K in RequiredSchemaKeys<I> & keyof I]: SlotInput<I, K> } & {
        [K in Exclude<SchemaSlots, RequiredSchemaKeys<I>> & keyof I]?: Exclude<
            SlotInput<I, K>,
            undefined
        >;
    } & { [K in ExtraSlots]?: StitchInput[K] } & (I extends {
            variables: unknown;
        }
            ? Record<never, never>
            : { variables?: Record<string, unknown> })
>;

// ---- Path-template variables (Phase 2c) -----------------------------------
// A templated endpoint contributes required input that the `input` schemas don't name: the engine
// expands the path against `input.params` (`expandPath(tpl, input.params ?? {})`, engine.ts), so a
// `{id}` slot needs `params.id` at call time even with no `input.params` schema. These types read
// the variable NAMES off a string-literal `path`/`url` and fold them into the `params` slot, mirroring
// the runtime grammar (`expandPath` in util.ts) at the type level. Pure types — zero runtime: the
// engine already does the expansion. A non-literal endpoint (a `${base}/…` template-literal type, or a
// thunk `url`) has no literal to walk, so it yields `never` and adds nothing — fail open, never closed.

/** RFC 6570 expression operators (`{+id}`, `{?q}`, …) — the leading char `expandPath` strips. */
type TplOp = '+' | '#' | '.' | '/' | ';' | '?' | '&';
/** Drop a leading {@link TplOp} from one `{…}` expression body, matching `expandPath`'s operator slice. */
type StripOp<S extends string> = S extends `${TplOp}${infer R}` ? R : S;
/**
 * Drop a varspec's modifier — prefix (`id:2`) or explode (`id*`) — leaving the bare name. Mirrors the
 * runtime varspec regex `([^:*]*)(?::(\d+)|(\*))?`: the name is everything up to the first `:` or `*`.
 * The `:` case is tested first so `id:2` stops at the colon rather than the (absent) star.
 */
type StripMod<S extends string> = S extends `${infer N}:${string}`
    ? N
    : S extends `${infer N}*`
      ? N
      : S;
/** Split one expression body on commas (`{?q,sort}` → `q | sort`), stripping each varspec's modifier. */
type SplitVars<S extends string> = S extends `${infer H},${infer T}`
    ? StripMod<H> | SplitVars<T>
    : StripMod<S>;
/**
 * Every variable name in a template literal: walk each `{…}` expression, strip its operator, split its
 * comma-separated varspecs, strip each modifier → a union of names. A string with no `{` (a plain path,
 * or a literal `?page=1` query — which lives outside any brace) yields `never`. Recursion is bounded by
 * the number of `{…}` groups, well within TS's instantiation budget for realistic endpoints.
 */
type PathVars<S extends string> = S extends `${string}{${infer E}}${infer Rest}`
    ? SplitVars<StripOp<E>> | PathVars<Rest>
    : never;
/**
 * The path-template variables a config declares: from a string-literal `path`, else a string-literal
 * `url` (host included — `url` is templated too). The `infer P extends string` guard matches a literal
 * only — a thunk `url` (`() => string`) and a widened `string` both fail the constraint and fall through
 * to `never`, so a non-literal endpoint adds no params (fail open). `path` wins when both are literals,
 * matching the engine's `usingUrl ? url : path` precedence is irrelevant here (a config rarely sets both,
 * and either spelling's vars are equally required); reading `path` first is the simple, stable choice.
 */
type PathVarsOf<C> = C extends { path: infer P extends string }
    ? PathVars<P>
    : C extends { url: infer U extends string }
      ? PathVars<U>
      : never;

/**
 * The `params` shape a config's `input.params` schema declares, or the empty object when it declares
 * none. Read straight off `C['input']['params']` via {@link InferInput} (NOT off the computed `Base`):
 * the loose {@link StitchInput} fallback carries `params?: Record<string, unknown>`, whose index
 * signature would otherwise make EVERY name look schema-provided and swallow the path-only fold. With no
 * `input.params` schema this is `Record<never, never>` (the empty object, spelled to avoid a bare `{}`),
 * so the path vars alone shape `params`. `NonNullable` unwraps the optional slot; a non-object inferred
 * shape (degenerate) intersects harmlessly with the path-only keys.
 */
type SchemaParams<C> = C extends { input: { params: infer P } }
    ? NonNullable<InferInput<P>>
    : Record<never, never>;
/**
 * The folded `params` slot: the schema-declared shape ({@link SchemaParams}) intersected with the
 * path-only var names typed `string | number` (what `expandPath` ultimately stringifies). Path-only
 * keys are `Exclude`d of the schema's keys, so a key the schema already names KEEPS its schema type —
 * schema wins. Placed as a REQUIRED property, so `HasRequired`/`Args` make the call argument required —
 * the correctness win. {@link Prettify} flattens the intersection for clean errors and tsd identity.
 */
type PathParams<C> = Prettify<
    SchemaParams<C> &
        Record<Exclude<PathVarsOf<C>, keyof SchemaParams<C>>, string | number>
>;

/**
 * Map a config object's `input` slot to the typed call argument, then fold in any RFC 6570
 * path-template vars (from a string-literal `path`/`url`). No `input` key → the loose
 * {@link StitchInput} (the historical default), so a stitch with no input schemas and no template stays
 * fully optional. Like {@link OutputOf}, this reads only the top-level `input`/`path`/`url`, not
 * `extends` fragments. No path vars in a branch (`PathVarsOf<C>` is `never`, tuple-wrapped to stop
 * distribution) → the base is returned byte-for-byte, so a non-templated stitch is exactly Phase 2.
 *
 * The two `input` branches fold path vars DIFFERENTLY on purpose — both must keep the result assignable
 * to {@link StitchInput}, because every surface helper assigns the engine's loose
 * `Stitch<TOut, StitchInput>` to its declared `Stitch<TOut, InputOf<C>>` and the call argument sits
 * contravariantly in that signature (so `InputOf<C>` must flow *back* into `StitchInput`):
 *
 * - **With an `input` schema** (`Base = CallInput<I>`, a deferred mapped type for a generic `C`): fold by
 *   INTERSECTION (`CallInput<I> & { params }`). The base is left structurally untouched — its `query?` /
 *   `body?` modifiers stay exactly as Phase 2 emitted them; an `Omit<…>`-re-wrap would, under
 *   `exactOptionalPropertyTypes`, widen those optional slots to `T | undefined` and break that boundary
 *   assignment. Intersecting only narrows/adds `params`: a `params` schema key keeps its schema type,
 *   path-only keys are added required.
 * - **Without an `input` schema** (`Base = StitchInput`, a CONCRETE interface): build `params` purely from
 *   the path vars via `Omit<StitchInput, 'params'> & { params }`. `Omit` over a concrete type resolves
 *   immediately (no deferral → no boundary break) and DROPS `StitchInput`'s loose
 *   `params?: Record<string, unknown>`, so the slot is exactly `{ id: string | number }` rather than that
 *   intersected with the catch-all index signature.
 */
export type InputOf<C> = C extends { input: infer I }
    ? [PathVarsOf<C>] extends [never]
        ? CallInput<I>
        : CallInput<I> & { params: PathParams<C> }
    : [PathVarsOf<C>] extends [never]
      ? StitchInput
      : Prettify<Omit<StitchInput, 'params'> & { params: PathParams<C> }>;

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
