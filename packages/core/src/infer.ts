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

// ---- extends/fragment flattening (the type-level image of `flatten` + `deepMerge`) --------
// `OutputOf`/`InputOf` historically read ONLY the top-level `output`/`input` of the directly-passed
// config, ignoring schemas a fragment contributes through `extends`. At runtime `compose()` in
// stitch.ts deep-merges `input`/`output` across every fragment (depth-first, base→child, last-wins
// per key) and `validateInput` validates the merged result — so the static type was blind to a
// fragment-supplied slot (issue #76). The machinery below mirrors that runtime merge at the type
// level: it expands `extends` into a flat, ordered layer list, then folds the `input` slots
// (key-union, last-wins per slot) and picks the last-written `output`.
//
// ENGAGEMENT (tuple-only, by design): the merge engages ONLY when `extends` is a concrete TUPLE —
// `[C] extends [{ extends: readonly [unknown, ...unknown[]] }]`. `stitch`/`seam`/`graphql` capture
// their config with a `const` type parameter, so an INLINE `extends: [base, …]` is inferred as a
// tuple and each fragment's literal slot types survive. A pre-widened `extends` (e.g. built up in a
// mutable variable, inferred as the loose `Fragment[]` array) is NOT a tuple → the guard's false
// branch → the historical top-level-only read. Two payoffs: (1) the no-`extends` (and array-
// `extends`) path is byte-identical to before, so existing inference and compile cost are unchanged;
// (2) for an unresolved type parameter `C` (the surface helpers' generic), `InputOf<C>`/`OutputOf<C>`
// collapse to the loose `StitchInput`/`unknown`, which the loose-implementation bodies depend on
// (they retype with a documented `as` — see download/sse/stream/seam/graphql).
//
// Scope note (the seam shared fragment): a seam contributes its config as one more `extends`
// fragment, but `SeamConfig = Omit<StitchConfig, …|'input'|'output'|…>` (types.ts) STRUCTURALLY
// cannot carry `input`/`output` — so #76's "apply to the seam fragment" is a no-op for these two
// slots by construction, and only the explicit `extends:[…]` array can contribute schemas. We do
// not widen `SeamConfig`; the type tests pin that a seam can't declare `input`/`output`.

/**
 * Normalise one `extends` member to a config-shaped object. A bare path STRING contributes only
 * `path` (no `input`/`output`), exactly like `asConfig` in stitch.ts — so a string fragment narrows
 * nothing. A {@link Stitch} used as a fragment is left as-is: it has no top-level `input`/`output`
 * key (those live, loosely typed, under `__rawConfig`), so it too contributes nothing narrowing.
 * That stitch-as-fragment limitation is accepted and deliberate (#76): a stitch erases its literal
 * slot types behind the loose `InputSchemas`/`SchemaLike` of `StitchConfig`, so digging into it
 * would only yield `unknown`-ish inference — we leave its runtime merge intact and infer nothing
 * extra from it.
 */
type AsFrag<F> = F extends string ? { path: F } : F;

/**
 * The fragment-tree depth cap. `extends` can nest (a fragment that itself `extends`), and the
 * flattening below is recursive — an unbounded walk would blow up compile time / hit the recursion
 * limiter on a pathological config. We bound the DEPTH of `extends` nesting at 8: deeper than that,
 * `ExpandFrag` stops descending and treats the over-deep fragment as a leaf (its own slots still
 * count; only its further-nested `extends` is ignored). Eight is far beyond any realistic preset
 * chain — typical use is one or two layers — and keeps the docs twoslash suite fast. The countdown
 * is a tuple whose length is the remaining budget; `[unknown, ...D]` would grow it, `D extends
 * [unknown, ...infer R]` spends one.
 */
type FragDepth = [
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
];

/**
 * Expand one already-`AsFrag`-normalised config into the ordered list of layers it stands for:
 * its own `extends` fragments first (base, recursively), then the config itself minus `extends`
 * — the depth-first, base→child order of `flatten`. When the depth budget `D` is exhausted we stop
 * recursing and keep the config as a single leaf, so a too-deep chain degrades to the top-level
 * read rather than failing.
 */
type ExpandFrag<C, D extends readonly unknown[]> = D extends [
    unknown,
    ...infer Rest,
]
    ? C extends { extends: infer E extends readonly unknown[] }
        ? [...Flatten<E, Rest>, Omit<C, 'extends'>]
        : [C]
    : [C];

/**
 * Flatten a `readonly` fragment array into a single ordered layer list (base→child, last-wins),
 * recursing through each member's own `extends`. The head/tail split walks the array; `AsFrag`
 * normalises strings/stitches before expansion. `D` is the shared depth budget threaded down.
 */
type Flatten<
    Fs extends readonly unknown[],
    D extends readonly unknown[],
> = Fs extends readonly [infer H, ...infer T]
    ? [...ExpandFrag<AsFrag<H>, D>, ...Flatten<T, D>]
    : [];

/**
 * The full ordered layer list for a config `C` (the config itself last). `C` is fed through the
 * same `ExpandFrag` so its own `extends` is expanded ahead of it — identical to `flatten([config])`
 * at runtime. The result is base→child, so a left-to-right fold gives last-wins semantics.
 *
 * Exported so the config GUARDS in `types.ts` read the composed config rather than the literal —
 * without them, a slot supplied through `extends` is invisible and a valid config is rejected.
 * There is deliberately one flattener: a second copy would drift from this one's depth budget and
 * `AsFrag` normalisation, and the guards would disagree with `InputOf` about what a config even is.
 */
export type Layers<C> = ExpandFrag<C, FragDepth>;

/**
 * True when ANY layer satisfies `Shape`. The guards ask two questions of a composed config — "is
 * this slot set anywhere?" and "is its enabler set anywhere?" — and both are existential, so a
 * left-to-right scan is enough; neither needs last-wins resolution.
 *
 * Existential rather than last-wins is a deliberate, documented bias. Resolving an override chain
 * at the type level (a later layer setting `wire.body` back to `'json'`) is both hard and easy to
 * get subtly wrong, and the two failure directions are not symmetric: a false POSITIVE rejects
 * working code loudly, a false NEGATIVE merely fails to catch something the compiler never caught
 * before. Scanning existentially can only ever produce the second.
 */
export type AnyLayer<
    Ls extends readonly unknown[],
    Shape,
> = Ls extends readonly [infer H, ...infer T]
    ? [H] extends [Shape]
        ? true
        : AnyLayer<T, Shape>
    : false;

/**
 * Fold the layer list to the merged `output` slot: the LAST layer that declares `output` wins the
 * whole slot (an atomic schema is never structurally merged — mirroring how a child `output`
 * dominates the validated result). Walk from the tail so the first hit IS the last writer.
 */
type MergeOutput<Ls extends readonly unknown[]> = Ls extends readonly [
    ...infer Rest,
    infer Last,
]
    ? Last extends { output: infer O }
        ? O
        : MergeOutput<Rest>
    : never;

/** Whether any layer in the list declares an `output` slot. */
type HasOutput<Ls extends readonly unknown[]> = Ls extends readonly [
    infer H,
    ...infer T,
]
    ? H extends { output: unknown }
        ? true
        : HasOutput<T>
    : false;

/**
 * Fold the layer list to the merged `input` schemas: union the slot keys across every layer's
 * `input`, with the LAST layer to declare a given slot winning it (key-union + last-wins per slot —
 * the type-level image of `deepMerge` folding each layer's `input` object). Walk base→child and let
 * later writes overwrite; `Acc` carries the running merge.
 */
type MergeInputSlots<
    Ls extends readonly unknown[],
    Acc = Record<never, never>,
> = Ls extends readonly [infer H, ...infer T]
    ? MergeInputSlots<
          T,
          H extends { input: infer I } ? Omit<Acc, keyof I> & I : Acc
      >
    : Acc;

/** Whether any layer in the list declares an `input` slot (drives the no-input fallback). */
type HasInput<Ls extends readonly unknown[]> = Ls extends readonly [
    infer H,
    ...infer T,
]
    ? H extends { input: unknown }
        ? true
        : HasInput<T>
    : false;

/**
 * Map a config object's `output` slot to the stitch result type, now reading the merged `output`
 * across `extends` fragments. No `extends` → the historical, byte-identical top-level read
 * (`C extends { output } ? InferOutput : unknown`), so every existing stitch is unchanged and pays
 * no extra type work. With `extends`, the last fragment (or the config) to declare `output` wins;
 * if none do, the result stays `unknown`.
 */
export type OutputOf<C> = [C] extends [
    { extends: readonly [unknown, ...unknown[]] },
]
    ? HasOutput<Layers<C>> extends true
        ? InferOutput<MergeOutput<Layers<C>>>
        : unknown
    : C extends { output: infer O }
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
 * slots, the runtime-only `signal`/`onProgress` passthrough, and — when no `variables`/`params`/`query`
 * schema is declared — the untyped loose passthroughs for those slots. {@link Prettify} collapses the
 * required∩optional split into one flat object.
 *
 * The trailing conditionals restore backward compatibility. The mapped slots above gate on `& keyof I`,
 * so a slot only appears when `input` actually declares it — which means declaring ONE slot (say
 * `input: { body }`) would otherwise DROP the `params`/`query` slots from the call argument entirely,
 * making `query: {…}`/`params: {…}` a compile error even though the runtime reads input by field name
 * regardless (issue #134). `variables` is now an {@link InputSchemas} slot too, so it likewise falls OUT
 * of {@link ExtraSlots} and would lose its loose passthrough. So re-add all three as loose optional
 * passthroughs here, mirroring one another: a config that declares the schema types it through the slot
 * machinery above; one that declares NONE keeps the loose runtime slot it has always carried. Each
 * `I extends { X: unknown }` probe is true only when that key was actually written, yielding
 * `Record<never, never>` (empty) so the typed and loose branches never overlap on the same key. The
 * passthrough value types match {@link StitchInput} exactly (`Record<string, unknown>`) so the result
 * stays assignable to `StitchInput` at the surface-helper boundary (see {@link InputOf}).
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
            : { variables?: Record<string, unknown> }) &
        (I extends { params: unknown }
            ? Record<never, never>
            : { params?: Record<string, unknown> }) &
        (I extends { query: unknown }
            ? Record<never, never>
            : { query?: Record<string, unknown> })
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
 * none. Read off the {@link MergedInput} of `C` (the `extends`-folded `input`) — NOT the bare
 * top-level `C['input']`: that is what lets a `params` schema contributed by an `extends` fragment win
 * its keys over the path-only fold. Read via {@link InferInput} (NOT off the computed `Base`): the
 * loose {@link StitchInput} fallback carries `params?: Record<string, unknown>`, whose index signature
 * would otherwise make EVERY name look schema-provided and swallow the path-only fold. With no
 * `input.params` schema this is `Record<never, never>` (the empty object, spelled to avoid a bare `{}`),
 * so the path vars alone shape `params`. `NonNullable` unwraps the optional slot; a non-object inferred
 * shape (degenerate) intersects harmlessly with the path-only keys.
 */
type SchemaParams<C> =
    MergedInput<C> extends { params: infer P }
        ? NonNullable<InferInput<P>>
        : Record<never, never>;
/**
 * The folded `params` slot: the schema-declared shape ({@link SchemaParams}) intersected with the
 * path-only var names typed `string | number | bigint` (what `expandPath` ultimately stringifies).
 * Path-only keys are `Exclude`d of the schema's keys, so a key the schema already names KEEPS its
 * schema type — schema wins. Placed as a REQUIRED property, so `HasRequired`/`Args` make the call
 * argument required — the correctness win. {@link Prettify} flattens the intersection for clean
 * errors and tsd identity.
 *
 * `bigint` is in the set because it is the value a caller holds after parsing a 64-bit id OUT of the
 * double-precision range JSON would have rounded it into — the standard repair for that precision
 * loss. `expandPath` stringifies it exactly like a number, so the type admitting it is the type
 * telling the truth about what the runtime accepts.
 */
type PathParams<C> = Prettify<
    SchemaParams<C> &
        Record<
            Exclude<PathVarsOf<C>, keyof SchemaParams<C>>,
            string | number | bigint
        >
>;

/**
 * The merged `input` schema object a config resolves to once `extends` fragments are folded — the
 * SOURCE OF TRUTH that {@link SchemaParams} reads `params` off. With an `extends` array, fold the
 * layers key-union/last-wins via {@link MergeInputSlots} (or `Record<never, never>` when no layer
 * declares `input`); without `extends`, the directly-written top-level `input` (or empty). Reading
 * `params` off THIS — not off `C['input']` — is what lets a `params` schema contributed by an
 * `extends` fragment win its keys over the bare path-only fold.
 */
type MergedInput<C> = [C] extends [
    { extends: readonly [unknown, ...unknown[]] },
]
    ? HasInput<Layers<C>> extends true
        ? MergeInputSlots<Layers<C>>
        : Record<never, never>
    : C extends { input: infer I }
      ? I
      : Record<never, never>;

/**
 * Fold the RFC 6570 path-template vars onto an already-computed call-argument `Base`. No path vars
 * (`PathVarsOf<C>` is `never`, tuple-wrapped to stop distribution) → `Base` is returned byte-for-byte,
 * so a non-templated stitch is exactly its Phase-2 base. Otherwise intersect a required `params`
 * slot ({@link PathParams}) — schema-named keys keep their schema type, path-only names are added
 * required. Used for the `CallInput<…>` arms; the no-input arms build `params` via `Omit` instead
 * (see {@link InputOf}).
 */
type FoldPathParams<C, Base> = [PathVarsOf<C>] extends [never]
    ? Base
    : Base & { params: PathParams<C> };

/**
 * Map a config object's `input` slot to the typed call argument, reading the `extends`-merged `input`
 * schemas (Gap B) and then folding in any RFC 6570 path-template vars from a string-literal
 * `path`/`url` (Gap A). No `input`/`extends` and no path vars → the loose {@link StitchInput} (the
 * historical default), so a stitch with no input schemas and no template stays fully optional.
 *
 * The merged base comes first: with an `extends` array we key-union the layers' `input` slots
 * (last-wins, via {@link MergeInputSlots}) so a `headers` schema from a base fragment or a `body` the
 * child adds both surface; without `extends` we read the top-level `input`. Path vars are then folded
 * over that base. The two families of branches fold DIFFERENTLY on purpose — both must keep the result
 * assignable to {@link StitchInput}, because every surface helper assigns the engine's loose
 * `Stitch<TOut, StitchInput>` to its declared `Stitch<TOut, InputOf<C>>` and the call argument sits
 * contravariantly in that signature (so `InputOf<C>` must flow *back* into `StitchInput`):
 *
 * - **With input schemas** (`Base = CallInput<…>`, a deferred mapped type for a generic `C`): fold by
 *   INTERSECTION (`CallInput<…> & { params }`, via {@link FoldPathParams}). The base is left
 *   structurally untouched — its `query?` / `body?` modifiers stay exactly as Phase 2 emitted them; an
 *   `Omit<…>`-re-wrap would, under `exactOptionalPropertyTypes`, widen those optional slots to
 *   `T | undefined` and break that boundary assignment. Intersecting only narrows/adds `params`: a
 *   `params` schema key (now also one a fragment contributed) keeps its schema type, path-only keys
 *   are added required.
 * - **Without input schemas** (`Base = StitchInput`, a CONCRETE interface): build `params` purely from
 *   the path vars via `Omit<StitchInput, 'params'> & { params }`. `Omit` over a concrete type resolves
 *   immediately (no deferral → no boundary break) and DROPS `StitchInput`'s loose
 *   `params?: Record<string, unknown>`, so the slot is exactly `{ id: string | number | bigint }`
 *   rather than that intersected with the catch-all index signature.
 */
export type InputOf<C> = [C] extends [
    { extends: readonly [unknown, ...unknown[]] },
]
    ? HasInput<Layers<C>> extends true
        ? FoldPathParams<C, CallInput<MergeInputSlots<Layers<C>>>>
        : [PathVarsOf<C>] extends [never]
          ? StitchInput
          : Prettify<Omit<StitchInput, 'params'> & { params: PathParams<C> }>
    : C extends { input: infer I }
      ? FoldPathParams<C, CallInput<I>>
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
