# Proposal — end-to-end type inference (OVERVIEW §2.1)

**Status:** mostly **shipped** (output inference [#72](https://github.com/rejifald/StitchAPI/pull/72), call-argument inference [#77](https://github.com/rejifald/StitchAPI/pull/77)) · **this doc:** the **residual-gap** design · **Scope:** `packages/core` (types only, except Gap C) · **Target branch:** `main`
**Covers:** OVERVIEW §2.1 ("End-to-end type inference") · **Tracks:** [#75](https://github.com/rejifald/StitchAPI/issues/75) (GraphQL `variables`), [#76](https://github.com/rejifald/StitchAPI/issues/76) (`extends` / seam fragments), and a path-template-vars follow-up issue (being filed)

> [!IMPORTANT]
>
> Read the framing first. §2.1 is **not** an open feature — the headline already
> shipped. `stitch({ output: userSchema })` resolves to `Stitch<User>` and
> `createUser({ body })` types its argument, both with no generic and no cast.
> This document exists to (a) **reconcile** what §2.1 asked against what landed,
> and (b) design the **three narrow gaps that remain**. It deliberately does not
> re-litigate the shipped design.

---

## TL;DR

OVERVIEW §2.1 promised that a stitch infers its result type from `config.output`
and its call-argument type from `config.input`, "so you almost never write a
generic." That promise is **kept on `main`**:

- **Output inference** ([#72](https://github.com/rejifald/StitchAPI/pull/72)) —
  `infer.ts`'s `InferOutput`/`OutputOf`/`ResolveOutput` read the result type
  straight off the `output` schema (Zod / Standard Schema / `Validator` /
  `drift()` / predicate). The `StitchFn` inferring overload
  (`stitch.ts:397-402`) wires it into `Stitch<ResolveOutput<TExplicit, C>, …>`.
- **Call-argument inference** ([#77](https://github.com/rejifald/StitchAPI/pull/77))
  — `InferInput`/`InputOf`/`CallInput`/`Args` type the call argument from the
  `input.*` schemas, with per-slot required-vs-optional and `.with()` relaxation
  (`RelaxKeys`).
- **The `asValidator` cast is gone** — every slot accepts `SchemaLike`
  (`infer.ts:14-18`), so a raw Zod / Standard Schema / predicate type-checks
  directly.

Two design ideas §2.1 leaned on were **removed**, not implemented:
`defineStitch` ([#66](https://github.com/rejifald/StitchAPI/pull/66)) and the
fluent Builder ([#90](https://github.com/rejifald/StitchAPI/pull/90)). Inference
lives on the plain `stitch(config)` / `seam.stitch(config)` overloads instead, so
there is no builder generic-variance surface left to design (§2).

What is left is **three narrow gaps**, each invisible-at-the-type-level today:

| Gap   | What's untyped today                                                                  | Issue                                                  | Shape                                      |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| **A** | RFC 6570 path-template vars (`{id}`) — required at runtime, absent from the call type | follow-up (filing)                                     | types only; **breaking** (tightens an arg) |
| **B** | `extends` / fragment composition over `input`/`output`                                | [#76](https://github.com/rejifald/StitchAPI/issues/76) | types only; narrowing-only                 |
| **C** | GraphQL `variables` — stays an untyped passthrough                                    | [#75](https://github.com/rejifald/StitchAPI/issues/75) | types **+** a small runtime change         |

Recommended merge order is **C → A → B** (smallest/safest first), each gated by
`check:types-d` and the docs twoslash suite (§5).

---

## 1. §2.1 reconciliation — asked vs. shipped

Re-checked against `main` (core, post-ADR-0005/0006). Every row cites the real
`infer.ts` symbol or call site.

| §2.1 asked for                                       | Shipped as                                                                                         | Where                                             | State        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------ |
| Infer result type from `output` schema               | `InferOutput<S>` (drift → Standard Schema → Zod `_output` → `Validator` → guard → `unknown`)       | `infer.ts:28-39`                                  | ✅ #72       |
| Map a config's `output` slot → result                | `OutputOf<C>`                                                                                      | `infer.ts:61-63`                                  | ✅ #72       |
| Explicit generic as an escape hatch                  | `ResolveOutput<TExplicit, C>` (`[TExplicit] extends [never]` "was a generic given?")               | `infer.ts:71-73`                                  | ✅ #72       |
| Infer call-ARGUMENT type from `input` schemas        | `InferInput<S>` + `InputOf<C>` → `CallInput<I>`                                                    | `infer.ts:46-55`, `132-134`, `117-124`            | ✅ #77       |
| Per-slot required-vs-optional argument               | `RequiredSchemaKeys<I>` (a slot is required iff its input type excludes `undefined`) + `Args<TIn>` | `infer.ts:104-110`, `149-150`                     | ✅ #77       |
| `.with()` relaxes only the bound slots               | `RelaxKeys<T, K>` (per-slot, shallow)                                                              | `infer.ts:156-158`                                | ✅ #77       |
| Drop the `asValidator` cast                          | `SchemaLike` union accepted everywhere a `Validator` was                                           | `infer.ts:14-18`; slots `types.ts:326-331`, `380` | ✅ #72/#77   |
| Raw Zod / Standard Schema / predicate, no wrapper    | same `SchemaLike` widening                                                                         | `types.ts:324-325` (comment)                      | ✅           |
| **Path-template vars typed into `params`**           | —                                                                                                  | —                                                 | ❌ **Gap A** |
| **`extends` fragments fold into the inferred types** | — (reads only the top-level `input`/`output`; see `InputOf` note `infer.ts:126-131`)               | —                                                 | ❌ **Gap B** |
| **GraphQL `variables` typed from a schema**          | — (`variables` is the untyped `ExtraSlots` passthrough, `infer.ts:90-91`)                          | —                                                 | ❌ **Gap C** |

> [!NOTE]
>
> `toValidator()` (`validator.ts:37-122`) **type-erases at the value level** —
> it returns a `Validator | undefined`, collapsing every flavour to the same
> wrapper. Inference does **not** depend on that runtime coercion: the type
> helpers read the schema's _static_ type via `SchemaLike` (`InferOutput` /
> `InferInput`) **before** any coercion runs. So `normalizeOutput` /
> `normalizeInput` (`stitch.ts:88-106`) can erase freely at runtime without
> touching the inferred surface. The raw schema is also kept non-enumerably as
> `Validator.source` (`validator.ts:24,29-34`) for the cache fingerprint — a
> value-level concern, orthogonal to inference.

---

## 2. Generic-variance audit

§2.1 was written when two now-removed constructs were on the table. The audit
confirms there is **no builder generic-variance work left** — inference rides the
plain config overloads.

| Construct                     | Status                                                                                      | Consequence for §2.1                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineStitch`                | **removed** ([#66](https://github.com/rejifald/StitchAPI/pull/66), `seam` primitive landed) | No separate "definition" generic to thread. The seam primitive (`seam.stitch`, `types.ts:576-583`) carries the _same_ `ResolveOutput`/`InputOf` overload pair as top-level `stitch`.                                                             |
| Fluent Builder                | **removed** ([#90](https://github.com/rejifald/StitchAPI/pull/90))                          | No chained-builder accumulation type. Variance lives entirely in one inferring overload (`stitch.ts:397-402`) + its non-inferring fallback (`404-408`).                                                                                          |
| `.with()` partial application | **done**                                                                                    | `with<const P extends Partial<TIn>>(p): Stitch<TOut, RelaxKeys<TIn, keyof P>>` (`types.ts:465-467`). The `const P` capture is what lets `RelaxKeys` relax exactly the bound slots — proven per-slot in `test-d/input-inference.test-d.ts:62-75`. |
| `extends` composition         | **gap** ([#76](https://github.com/rejifald/StitchAPI/issues/76))                            | The one remaining variance question — covered as Gap B.                                                                                                                                                                                          |

The shipped overload set is the variance surface:

```ts
// stitch.ts:387-409 — the entire generic surface (mirrored on seam.stitch / seam.graphql)
export interface StitchFn {
    <
        TExplicit = never,
        C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>; // inferring
    <T = unknown>(config: string | Partial<StitchConfig>): Stitch<T>; // fallback
}
```

One sharp edge is already documented and tested: passing the explicit generic
(`stitch<Foo>(…)`) stops TypeScript from inferring `C`, so the **call argument
falls back to loose `StitchInput`** — partial type-argument inference is
unsupported (`stitch.ts:392-395`; asserted `test-d/input-inference.test-d.ts:48-59`).
None of the three gaps changes that; they all operate _inside_ `C` inference.

---

## 3. The three residual gaps

Each section: current behaviour (with cite) → proposed types (design sketch) →
before/after inferred signature → edge cases → breaking-change call.

### Gap A — RFC 6570 path-template vars → typed `params`

#### Current behaviour

A path like `'/users/{id}'` is expanded at runtime by `expandPath`
(`util.ts:208-237`), called from the engine as
`expandPath(tpl, input.params ?? {})` (`engine.ts:164`). So `{id}` is read out of
`input.params` and is **required at runtime** — omit it and the URL ships a
literal `{id}` or an empty segment. But nothing types it: if there is no
`input.params` _schema_, `InputOf` makes `params` optional (or absent), and the
template variable is invisible.

```ts
// today: path declares {id}, but the call argument doesn't know about it
const getUser = stitch({ path: '/users/{id}', output: userSchema });
getUser(); // ✅ compiles — but ships GET /users/{id} (broken at runtime)
getUser({ params: { id: '7' } }); // also fine, but the type never *required* it
```

`expandPath` accepts the full RFC 6570 level-4 grammar: operator prefixes
`TEMPLATE_OPERATORS = ['+','#','.','/',';','?','&']` (`util.ts:82`), comma-joined
varspecs (`util.ts:223`), and the `:n` / `*` modifiers (varspec regex
`/([^:*]*)(?::(\d+)|(\*))?/`, `util.ts:224`). A faithful type extractor must mirror
that grammar.

#### Proposed types

A literal-template extractor that walks `{…}` expressions, strips the operator and
modifiers, comma-splits, and unions the bare variable names. Folded into the
`params` slot so **schema-declared keys win**, **path-only keys become required
`string | number`**, and a **thunk `url` fails open** (a `() => string` is opaque
to the type system).

```ts
// Design sketch (Gap A) — adapted from the implementation work
type TplOp = '+' | '#' | '.' | '/' | ';' | '?' | '&';
type StripOp<S extends string> = S extends `${TplOp}${infer R}` ? R : S;
type StripMod<S extends string> = S extends `${infer N}:${string}`
    ? N
    : S extends `${infer N}*`
      ? N
      : S;
type SplitVars<S extends string> = S extends `${infer H},${infer T}`
    ? StripMod<H> | SplitVars<T>
    : StripMod<S>;
type PathVars<S extends string> = S extends `${string}{${infer E}}${infer Rest}`
    ? SplitVars<StripOp<E>> | PathVars<Rest>
    : never;
```

Folding rule (sketch — the exact spelling lives in `infer.ts` next to `CallInput`):

```ts
// Path-only vars not covered by a params schema become REQUIRED string | number.
type PathOnlyParams<C> = C extends { path: infer P extends string }
    ? Exclude<PathVars<P>, keyof DeclaredParams<C>> extends never
        ? {}
        : {
              params: Record<
                  Exclude<PathVars<P>, keyof DeclaredParams<C>>,
                  string | number
              >;
          }
    : {}; // url is `string | (() => string)`; a thunk → no literal → {} (fail open)
```

- **Schema keys win.** When `input.params` declares `id`, `DeclaredParams<C>`
  already covers it, `Exclude<…>` drops it, and the path contributes nothing —
  the schema's richer type (e.g. a branded `UserId`) stands.
- **Merge into `params`.** `PathOnlyParams<C>` intersects into the existing
  `params` slot inside `InputOf` so a config with _both_ a partial params schema
  and extra path vars gets both.

#### Before / after

```ts
const getUser = stitch({ path: '/users/{id}', output: userSchema });

// before:  (input?: StitchInput) => StitchResult<User>
// after:   (input:  { params: { id: string | number } } & StitchInput) => StitchResult<User>
getUser(); // after: ❌ compile error — params.id is required
getUser({ params: { id: '7' } }); // after: ✅
```

#### Edge cases

- **Operators/modifiers:** `'/files{/path*}'` → `path`; `'{?q,sort}'` → `q | sort`;
  `'/x/{id:4}'` → `id`. `StripOp` + `StripMod` + `SplitVars` reduce all of these
  to bare names, matching `expandPath`.
- **Reserved/query operators (`?`,`&`,`;`):** these produce _query_-style output
  at runtime but still read from `input.params` (`expandPath` only ever reads
  `params`). Typing them as required `params` keys is faithful to the runtime.
  (A future refinement could route `{?q}` to the `query` slot; out of scope —
  start by matching the current read site.)
- **Thunk `url`:** `url: () => string` carries no literal, so `PathVars` sees no
  template → contributes `{}`. Correct: we cannot know the vars, so we must not
  invent required keys (fail open).
- **`baseUrl` + `path`:** only `path` is templated against `params` in the read
  site we extend; `baseUrl` host templating (also supported by `url`) is the same
  fail-open story when it's a thunk.

#### Breaking-change assessment — **breaking (intended)**

This **tightens an optional argument to required** on any stitch that has a
templated `path` and _no_ params schema. That is the entire point (it converts a
runtime footgun into a compile error), but it can break existing call sites that
relied on the loose type. Hence Gap A lands **after** the opt-in Gap C and is
called out explicitly in §5. Mitigation if needed: gate behind a per-config marker
or a major bump; recommended path is to ship it as the headline of a minor with a
clear changelog, since the "broken" calls were already broken at runtime.

---

### Gap B — `extends` / fragment composition (#76)

#### Current behaviour

`extends` is the composition facade: a config may carry
`extends?: (Partial<StitchConfig> | Stitch | string)[]` (`types.ts:433-434`). At
runtime, `compose` → `flatten` (`stitch.ts:52-62`) walks fragments depth-first and
`deepMerge`s them base→child, last-writer-wins (`stitch.ts:108-147`). So a base
fragment's `input.body` schema **is** in force at runtime.

At the type level it is invisible. `InputOf` / `OutputOf` read **only the
top-level `input` / `output` key** of `C` — the `InputOf` doc says so outright:
"reads only the top-level `input` key, not `extends` fragments" (`infer.ts:126-131`).
So inheriting a body schema from a fragment yields no typed argument.

```ts
const base = { input: { body: z.object({ name: z.string() }) } };
const createUser = stitch({ extends: [base], output: userSchema });
createUser(); // compiles — but the runtime requires a body from `base`
```

#### Proposed types

A type-level mirror of `compose`: flatten `extends` (with the same
string-`→`-`{ path }` coercion `asConfig` uses, `stitch.ts:40-50`), then fold the
`input`/`output` slots base-`→`-child last-wins, then feed the merged shape through
the existing `InputOf` / `OutputOf`.

```ts
// Design sketch (Gap B) — adapted from the implementation work
type AsFrag<F> = F extends string ? { path: F } : F;
type Flatten<Fs extends readonly unknown[]> = Fs extends readonly [
    infer H,
    ...infer T,
]
    ? [...ExpandFrag<AsFrag<H>>, ...Flatten<T>]
    : [];
type ExpandFrag<C> = C extends { extends: infer E extends readonly unknown[] }
    ? [...Flatten<E>, Omit<C, 'extends'>]
    : [C];
```

`ExpandFrag<C>` yields the ordered layer list (base-first, child-last). A small
`MergeSlots<layers, 'input'>` then right-folds the per-slot objects so the child's
`body` wins over a base `body`, and the result is handed to `CallInput` /
`InferOutput`. **Recursion is bounded** (a fixed depth cap, e.g. 8 levels) so the
compiler doesn't blow its instantiation budget on pathological nesting — `extends`
chains are shallow in practice.

#### Before / after

```ts
const base = { input: { body: z.object({ name: z.string() }) } } as const;
const createUser = stitch({ extends: [base], output: userSchema });

// before:  (input?: StitchInput) => StitchResult<User>          // body lost
// after:   (input:  { body: { name: string } }) => StitchResult<User>
```

#### Two sharp findings (why this is the hardest gap)

> [!WARNING]
>
> **(i) The seam-fragment half is a no-op by construction.** `SeamConfig`
> (`types.ts:529-532`) is `StitchConfig` with the per-endpoint keys omitted:
> `path`, `url`, `method`, `query`, `name`, **`input`**, **`output`**, `kind`. It
> **structurally omits `input` and `output`** — by design, those are
> per-endpoint. So a seam's shared fragment can
> never contribute an `input`/`output` schema to fold; only `extends`-array
> fragments and stitch-as-fragment can. Any Gap-B design that tries to thread
> seam-level `input`/`output` is chasing a type that cannot exist. The fold must
> target the `extends` array, not the seam fragment.

> [!WARNING]
>
> **(ii) A `Stitch`-as-fragment contributes loosely.** When a `Stitch` is used as
> a fragment, `asConfig` reads its config as the loose `StitchConfig` (via
> `__rawConfig ?? __config`, `stitch.ts:44-48`), and `Stitch.__config` is typed
> `StitchConfig` (`types.ts:480`) — _not_ the literal config `C` it was built
> from. So `extends: [someStitch]` erases literal types: its `input.body` is the
> wide `SchemaLike`, not `z.object({ name })`. The fold over a stitch fragment
> therefore contributes **loosely** (degrades to `unknown`/`StitchInput`), which
> `RequiredSchemaKeys` correctly treats as _optional_ (fail-open,
> `infer.ts:99-110`). Tightening this would require capturing the literal config
> type on the `Stitch` brand (a `Stitch<TOut, TIn, TConfig>` third parameter) —
> a much larger change, explicitly out of scope here.

The deliverable Gap B can actually achieve: **fold `Partial<StitchConfig>`
object-literal fragments in the `extends` array** (the `base` case above), where
the literal type survives. String and `Stitch` fragments contribute path/loose
respectively. That is the 80% case and is honest about the two ceilings above.

#### Breaking-change assessment — **narrowing-only**

Today inherited schemas yield _no_ requirement; afterwards they yield the _correct_
requirement. This only ever adds/narrows required keys that were already enforced
at runtime — no currently-_type-correct_ program that was also _runtime-correct_
breaks. (A program that compiled but was already shipping a missing inherited body
was runtime-broken; surfacing that is the feature.)

---

### Gap C — GraphQL `variables` (#75)

#### Current behaviour

`variables` is a first-class `StitchInput` field (`types.ts:18`) but has **no
schema slot**: `InputSchemas` is exactly `{ params, query, body, headers }`
(`types.ts:326-331`). In `infer.ts` it is the `ExtraSlots` passthrough —
`ExtraSlots = Exclude<keyof StitchInput, SchemaSlots>` (`infer.ts:90-91`) — carried
through **untyped and always optional** (`CallInput`'s last intersection member,
`infer.ts:123`). So a GraphQL stitch can be called with any `variables` shape, or
none, regardless of the query.

```ts
const gql = api.graphql({ query: 'query($region: String!){ ok }' });
gql({ variables: { anything: 1 } }); // compiles — no shape enforced
```

This is asserted as deliberate today: `test-d/input-inference.test-d.ts:95-97`
("GraphQL `variables` stay an untyped passthrough … see follow-up issue").

#### Proposed types

Add `variables?: SchemaLike` to `InputSchemas`. The existing machinery picks it up
**for free**: `SchemaSlots = keyof InputSchemas` (`infer.ts:89`) gains `variables`,
so `RequiredSchemaKeys` / `CallInput` type and require it exactly like `body`. The
only subtlety is preserving the **optional untyped passthrough when no schema is
declared** — the `ExtraSlots` member must keep covering the no-schema case so
existing GraphQL stitches stay loose.

```ts
// Design sketch (Gap C) — adapted from the implementation work
type CallInputVars<I> = I extends { variables: unknown }
    ? {}
    : { variables?: Record<string, unknown> };
```

`CallInputVars<I>` replaces the unconditional `ExtraSlots` `variables` member:
when an `input.variables` schema is present, the typed `SchemaSlots` path owns it
(so `{}` here, no double-declaration); when absent, the optional
`Record<string, unknown>` passthrough is preserved. Because `variables` then lives
in `SchemaSlots`, a `.with({ variables })` bind is relaxed by the same `RelaxKeys`
path as every other slot.

#### Before / after

```ts
const gql = api.graphql({
    query: 'query($region: String!){ ok }',
    input: { variables: z.object({ region: z.string() }) },
});

// before:  variables?: Record<string, unknown>   (untyped, optional)
// after:   variables:  { region: string }         (typed, required because the schema is non-optional)
gql(); // after: ❌ region is required
gql({ variables: { region: 'eu' } }); // after: ✅
```

#### The runtime change (unlike A/B)

Gaps A and B are **types only** — the runtime already reads path vars and merges
fragments. Gap C also needs a **small runtime change**: `normalizeInput`
(`stitch.ts:94-106`) currently iterates exactly
`['params', 'query', 'body', 'headers']` and would **ignore** an `input.variables`
schema, so the declared schema would type-check but never _validate_. The fix is to
add `'variables'` to that list (and to `validateInput` in the engine) so a declared
`variables` schema is coerced and enforced at call time. Note `mergeInput` already
merges `variables` correctly (`stitch.ts:246-266`, the `.with` path) — only the
_validation_ wiring is missing.

#### Edge cases

- **Optional schema:** `input: { variables: z.object({…}).optional() }` →
  `undefined extends SlotInput` → optional slot (consistent with every other slot,
  `infer.ts:99-110`).
- **No `input` block at all:** `InputOf` returns loose `StitchInput`
  (`infer.ts:132-134`), whose `variables?` is already optional — unchanged.
- **`graphql()` preset:** it forwards `config` through `makeStitch` with
  `InputOf<C>` (`stitch.ts:435-452`), so the new slot flows through with no preset
  change.

#### Breaking-change assessment — **opt-in (+ runtime)**

Purely additive at the type level: nothing changes unless a caller _adds_
`input.variables`. Existing GraphQL stitches keep the loose passthrough. The
runtime change is also opt-in (only a declared `variables` schema triggers
validation), so it cannot reject a payload that previously passed. **Lowest-risk of
the three** → lands first.

---

## 4. expect-type (tsd) test plan

All cases follow the suite's conventions: assert on the **call-argument** type via
`CallArg<S>` (`test-d/_util.ts:20`) and the **unwrapped output** via `output(s)`
(`test-d/_util.ts:9-12`). **Never** `expectType<Stitch<…>>` — tsd's identity check
short-circuits on `Stitch<T>`'s recursive `with(): Stitch<…>` self-reference and
reports any two `Stitch<X>` as identical (`test-d/_util.ts:3-6,14-19`). Positive
"this compiles" cases go in the runtime `*.spec.ts` with `await` (so they aren't
floating promises), mirroring `input-inference.test-d.ts:1-5`.

### Gap A — `test-d/path-vars.test-d.ts`

```ts
const getUser = stitch({ path: '/users/{id}', output: userSchema });
expectType<{ id: string | number }>(
    null as unknown as CallArg<typeof getUser>['params'],
);
expectError(getUser());                       // params.id now required
expectType<User>(output(getUser));            // output inference unaffected

// schema wins over the path-only inference
const branded = stitch({
    path: '/users/{id}',
    input: { params: z.object({ id: z.string().brand<'UserId'>() }) },
});
expectType<string & { __brand: 'UserId' }>(
    null as unknown as CallArg<typeof branded>['params']['id'],
);

// operators & modifiers reduce to bare names
expectType<{ q: string | number; sort: string | number }>(
    null as unknown as CallArg<typeof stitch({ path: '/s{?q,sort}' })>['params'],
);
expectAssignable<CallArg<typeof stitch({ path: '/files{/path*}' })>>({
    params: { path: 'a/b' },
});

// thunk url fails open — no invented required key
const dyn = stitch({ url: () => 'https://x/users/7' });
expectAssignable<CallArg<typeof dyn>>(undefined);
```

### Gap B — `test-d/extends-inference.test-d.ts`

```ts
const base = { input: { body: z.object({ name: z.string() }) } } as const;

// object-literal fragment: body folds in and is required
const createUser = stitch({ extends: [base], output: userSchema });
expectType<{ name: string }>(
    null as unknown as CallArg<typeof createUser>['body'],
);
expectError(createUser());

// child last-wins over a base slot
const childWins = stitch({
    extends: [base],
    input: { body: z.object({ name: z.string(), age: z.number() }) },
});
expectType<{ name: string; age: number }>(
    null as unknown as CallArg<typeof childWins>['body'],
);

// finding (ii): a Stitch-as-fragment contributes loosely (documents the ceiling)
const asFragment = stitch({ extends: [createUser] });
expectAssignable<CallArg<typeof asFragment>>(undefined); // loose, not required

// finding (i): a seam fragment cannot carry input/output — member stays as-declared
const api = seam({
    baseUrl: 'https://x' /* no input/output possible on SeamConfig */,
});
expectAssignable<CallArg<ReturnType<typeof api.stitch<never, {}>>>>(undefined);
```

### Gap C — `test-d/graphql-vars.test-d.ts`

```ts
const typed = api.graphql({
    query: 'query($region: String!){ ok }',
    input: { variables: z.object({ region: z.string() }) },
});
expectType<{ region: string }>(
    null as unknown as CallArg<typeof typed>['variables'],
);
expectError(typed()); // variables required

// no schema → loose passthrough preserved (the existing assertion, kept green)
const loose = api.graphql({ query: 'query { ok }', output: userSchema });
expectAssignable<CallArg<typeof loose>>({ variables: { region: 'eu' } });
expectAssignable<CallArg<typeof loose>>(undefined);

// optional variables schema → optional slot
const opt = api.graphql({
    query: 'query { ok }',
    input: { variables: z.object({ region: z.string() }).optional() },
});
expectAssignable<CallArg<typeof opt>>(undefined);
```

When Gap C lands, update `input-inference.test-d.ts:95-97` (the "stay untyped"
assertion) to the typed expectation above — that comment is the canary for this
gap.

---

## 5. Breaking-change matrix & sequencing

| Gap                         | Type impact                                                                 | Runtime impact                                            | Risk                                      |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| **C** — GraphQL `variables` | additive (opt-in: only when `input.variables` declared)                     | small (validate `variables` in `normalizeInput` + engine) | **lowest**                                |
| **A** — path-template vars  | **breaking** (optional `params` → required on templated paths w/o a schema) | none (engine already reads `input.params`)                | medium                                    |
| **B** — `extends` fold      | narrowing-only (adds requirements already enforced at runtime)              | none (`compose` already merges)                           | high (compiler-budget + the two ceilings) |

### Recommended order: **C → A → B**

1. **C first** — smallest blast radius (opt-in, additive), and it includes the
   only runtime change, so it ships and bakes independently. Flip the
   `input-inference.test-d.ts` canary as part of it.
2. **A second** — types-only but **breaking**; ship it as a deliberate, well-changelogged
   narrowing once C is stable. It is self-contained (one `PathVars` family folded
   into `InputOf`).
3. **B last** — hardest: bounded-recursion compile-budget concerns and the two
   structural ceilings (`SeamConfig` omits `input`/`output`; `Stitch`-as-fragment
   erases literals). Landing it after A means the `params`/path interaction is
   already settled before fragment-folding stacks on top.

Every stage is gated by:

- **`check:types-d`** — the tsd suite (`build` then `tsd`); add the per-gap files
  in §4. Remember the "no `expectType<Stitch<…>>`" rule.
- **the docs twoslash suite** — `build-docs` over the whole tree (the pre-push
  gate runs it repo-wide); any `.mdx` example that newly fails to type-check is a
  real regression, especially around §2.1's examples.

---

## 6. Non-goals / risks

- **Not** reviving `defineStitch` or the fluent Builder — both were removed
  deliberately (#66/#90); inference stays on the config overloads.
- **Not** adding a `Stitch<TOut, TIn, TConfig>` third type parameter to carry the
  literal config — that is the only way to fully fix Gap B finding (ii), and it is
  a far larger, separate change.
- **Not** routing `{?q}` path operators to the `query` slot — Gap A types them as
  `params` to match the single runtime read site (`engine.ts:164`); a query-slot
  refinement is a later, additive step.
- **Compile-budget:** Gap B's recursion must stay bounded (depth cap); a runaway
  `extends` chain must degrade gracefully, not hang `tsc`. The tsd run is the gate.
- **`exactOptionalPropertyTypes`:** all three folds must avoid emitting
  `key: undefined` members — the codebase compiles under
  `exactOptionalPropertyTypes` (see the `mergeInput`/`compose` `delete` dances,
  `stitch.ts:121-126,257-265`), and the new mapped types must honour it.
