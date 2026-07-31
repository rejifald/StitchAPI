# ADR 0020 — Declarative auth descriptors: `auth` accepts a descriptor or a factory

- **Status:** **Superseded by [ADR 0021](./0021-auth-strategies-move-to-a-subpath.md)** (2026-07-31), before implementation. Accepted 2026-07-23 in [#486](https://github.com/rejifald/StitchAPI/pull/486); implemented in [#487](https://github.com/rejifald/StitchAPI/pull/487), which was closed unmerged.
- **Date:** 2026-07-23
- **Tags:** auth, config, descriptor, contract-not-dependency, P0-json-config, P16-parity, browser-first, additive

> [!WARNING]
>
> **Superseded — `auth` accepts an `AuthStrategy` only; there is no `AuthDescriptor`.**
> A descriptor is inert data, so the resolver mapping `strategy: 'oauth2'` to its factory has
> to reference all five strategies and be reachable from `stitch()` — measured at **+2.33 KB
> gzip on `import { stitch }`** for every consumer, including the ones with no `auth` at all.
> #487's escape (a resolver seam armed as a side effect of the secret resolvers) bought the
> bytes back, but made a literal-secret descriptor's validity depend on module execution
> order. [ADR 0021](./0021-auth-strategies-move-to-a-subpath.md) withdraws the descriptor and
> moves the auth surface to `stitchapi/auth` instead.
>
> Two conclusions below survived and shipped: **Q7** (`auth` is an atomic `extends` slot,
> never deep-merged — [#544](https://github.com/rejifald/StitchAPI/pull/544)) and the
> symmetric `apiKey({ in, name, value })` it builds on
> ([#485](https://github.com/rejifald/StitchAPI/pull/485)). Everything else here is
> historical. The examples' `stitchapi` imports were rewritten to `stitchapi/auth` so the
> page never teaches a dead import path.

> [!NOTE]
>
> This proposes a **second, declarative intake form** for `auth`, alongside the
> existing strategy factories (`bearer()`/`apiKey()`/`basic()`/`oauth2()`/
> `cookieSession()`). It is **additive and non-breaking** — every factory call
> keeps working. It builds directly on the symmetric `apiKey({ in, name, value })`
> shape landed in #485.

## Context

Today `auth` accepts one thing — a live `AuthStrategy`
([`types.ts:752`](../../packages/core/src/types.ts)) built by a factory:

```ts
import { apiKey, env } from 'stitchapi/auth';

auth: apiKey({ in: 'cookie', name: 'sid', value: env('API_KEY') });
```

The strategy is a live object — `{ name?, scheme?, apply, shouldRefresh?, refresh? }`
— whose `apply` closure captures the secret. On `__config` (the JSON-inspectable
config, P0) the live strategy is **stripped** to `__rawConfig` and only its JSON
`scheme` is surfaced as `__config.authScheme`
([`stitch.ts:691`](../../packages/core/src/stitch.ts); the runtime shape note at
[`types.ts:888`](../../packages/core/src/types.ts) states `__config.auth` is
always absent).

So the config **already round-trips auth _as a descriptor_** — ADR 0011 names
exactly this when it lists what the contract serializes: "_`kind` collapses to a
string id on `__config`, **`auth` to a descriptor**, and so on_"
([ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md),
§"It fails contract-not-dependency"). There is an asymmetry: you **configure**
auth by calling a factory, but you **inspect / export** it as a descriptor. For a
library whose whole style is data-shaped config (`throttle: '10/s' | { rate }`,
`retry`, `cache`, scalar-or-object everywhere), forcing an `import` + call for the
one field that already serializes as data is avoidable ceremony.

This ADR closes that asymmetry: make the descriptor a first-class **intake** form
too. It was grilled against the four objections raised when it was first floated
(P0, all-five scope, descriptor-or-factory, composition); all four resolved in its
favour (see "Grill" below).

## Decision

`StitchConfig.auth` accepts **`AuthStrategy | AuthDescriptor`**.

```ts
// AuthDescriptor — a flat discriminated union on `strategy` (the strategy name).
// Live leaves (Secret thunks, adapters, the cookieSession login stitch) are allowed,
// exactly as StitchConfig already allows url thunks / transform / keyOf.
type AuthDescriptor =
    | { strategy: 'bearer'; token: Secret }
    | {
          strategy: 'apiKey';
          in?: 'header' | 'query' | 'cookie';
          name?: string;
          value: Secret;
      }
    | { strategy: 'basic'; user: Secret; pass: Secret }
    | ({ strategy: 'oauth2' } & OAuth2Options)
    | ({ strategy: 'cookieSession' } & CookieSessionOptions);
```

```ts
// declarative — no import of the strategy factory
auth: { strategy: 'apiKey', in: 'cookie', name: 'sid', value: env('API_KEY') }

// factory — unchanged; still first-class for sharing, BYO, terse bearer
const shared = bearer(env('GH_TOKEN'));
auth: shared
```

At `stitch()` / `seam()` construction, **after** `extends` resolves and **before**
`__config` is built, a normalization step maps a descriptor to its strategy by
calling the matching factory internally. From that point everything is identical
to today: the strategy is stripped to `__rawConfig`, its `scheme` is surfaced, the
raw descriptor (and its secret leaves) never touch `__config`. The factories stay
exactly as they are; the descriptor is sugar that resolves to them.

Both forms are **first-class and permanent** — the descriptor does not deprecate
the factory, and vice versa.

## Why

1.  **It restores a symmetry the contract already half-implements (P16).** The
    config serializes auth as a descriptor (`__config.authScheme`); intake should
    speak the same shape. Descriptors also give **all five** strategies one
    uniform intake — the same parity #485 gave `apiKey`'s three locations.
2.  **It's on-brand, not against it.** "Explicit composition" is about _stitch_
    composition (`pipe`/`linked`/`seam`), not about forcing a call for a config
    field. Every other policy field already takes a data form; auth was the
    exception.
3.  **Generated code gets simpler.** `stitch gen openapi` and `from-curl` can emit
    `auth: { strategy: 'apiKey', … }` — **pure data, no `apiKey` import** in the
    ejected client (see Resolved Q5).
4.  **P0 is preserved by the same mechanism P0 already uses** (Resolved Q1): the
    descriptor is a declarative shell with resolver leaves, and normalization
    routes the live leaves into the strategy closure on `__rawConfig`, exactly as
    url-thunks / `transform` / `keyOf` are routed today. `__config` stays strict
    JSON.

## Grill — the four objections, resolved

**Q1 · "Doesn't a descriptor with a `Secret` leaf break the strict-JSON `__config`?"**
No — and JSON is required either way, which is the point. A `Secret` is
`string | (() => string)`; `env()` returns a thunk. Today that thunk hides in the
`apply` closure; with a descriptor it sits on `value` until normalization builds
the strategy (capturing it into the closure) and strips it. Because normalization
runs **before `__config` is frozen**, even a literal `value: 'sk-…'` never lands on
JSON config. The redaction outcome is byte-identical to today; the only new code is
one intake branch. Defense-in-depth: add `value`/`token`/`clientSecret` to the
trace secret-name stems so a mis-ordered future refactor can't leak them.

**Q2 · "All five strategies, or just `apiKey`?"** All five — a single-strategy
descriptor would violate P16. `bearer`/`basic` keep their positional factory
shorthands (a descriptor is not always terser: `bearer(env('T'))` beats
`{ strategy: 'bearer', token: env('T') }`), so the union earns its keep by giving
the call site the choice.

**Q3 · "Descriptor _or_ factory?"** Yes — `AuthStrategy | AuthDescriptor`. The
factory form is required anyway for **custom / BYO** strategies (an arbitrary
`apply`), which a closed descriptor union can't express. Detection is unambiguous
for every real input: a factory output has `apply` and no `strategy`; a descriptor
has `strategy` and no `apply`.

**Q4 · "How do strategies compose?"** They don't — `auth` is a single strategy;
there is no array and no combinator (grep-confirmed). What DESIGN.md calls
"compose" is _name it_ (`const gh = bearer(…)`), _share it_, _override via
`extends`_ — a plain descriptor object does all three identically. So the
"strategies are composable values" objection dissolves; the only factory-only
capability (custom `apply`) is kept by Q3's union.

## Resolved questions

**Q5 · Discriminant field name → `strategy`.** The value _is_ the strategy's name,
and `strategy:` says exactly that, mirroring the `AuthStrategy` it resolves to —
self-documenting, at the cost of a few characters written once per stitch. `use:`
was the terser runner-up, rejected as less explicit (and it carries a React-hook
connotation). Not `type` (its value-space would collide with `scheme.type`, which
folds bearer/basic under `http` — a reader seeing intake `type: 'bearer'` and
scheme `type: 'http'` is misled). Not `name` (collides with `apiKey`'s `name`).
Not `kind` (the surface selector, loaded by ADR 0005's retirement of the closed
`kind` union). Grilled empirically against `tsc --strict`, `strategy` narrows to
the right arm and gives **arm-localized errors, not union mega-errors**:

| Mistake                              | Diagnostic                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| `{ strategy: 'apiKey', valu: … }`    | `TS2353 … 'valu' does not exist in type … { strategy: "apiKey"; … }` |
| `{ strategy: 'apikey', value }`      | `Type '"apikey"' is not assignable … **Did you mean '"apiKey"'?**`   |
| `{ strategy: 'apiKey', name: 'X' }`  | `Property 'value' is missing … but required`                         |
| `{ strategy: 'bearer', token: 123 }` | `Type 'number' is not assignable to type 'Secret'`                   |

**Q6 · Descriptor-vs-strategy detection + the `{ strategy, apply }` corner.**
Runtime rule: **`typeof auth.apply === 'function'` ⇒ strategy; else `'strategy' in
auth` ⇒ descriptor; else throw** a construction-time error ("auth needs `apply` (a
strategy) or `strategy` (a descriptor)"). The only ambiguous object — one carrying
_both_ `strategy` and `apply` — type-checks (excess-property checking can't reject
it, since each key is known to some union member) and is treated as a **strategy**
(`apply` wins). We do **not** add `strategy?: never` to the public `AuthStrategy`
to force a compile error, because polluting the BYO strategy type to catch a
hand-spliced object isn't worth it; the rule is documented instead.

**Q7 · `extends` merge → auth becomes an atomic slot.** Today `auth` flows through
`deepMerge` ([`stitch.ts:182`](../../packages/core/src/stitch.ts)), which would
blend two strategies (or a strategy and a descriptor) field-by-field — already a
latent bug. Auth joins `hooks`/`store`/`kind` as an **atomic last-writer-wins
slot, never deep-merged**, the exact treatment ADR 0005 Decision 2 gives a
Surface. The winning value is normalized once, afterwards.

**Q8 · Generator emit.** `gen openapi` / `from-curl` **should** switch to emitting
`auth: { strategy: '…', … }` (no strategy import in the ejected client — a real
simplification for generated code). Orthogonal and reversible: both forms compile,
so this can land after the intake feature and be tuned independently.

**Q9 · Public surface.** `AuthDescriptor` (and the `AuthConfig = AuthStrategy |
AuthDescriptor` alias) become **exported public types**, since they are the type of
the public `StitchConfig.auth`. This is the intended, deliberate surface growth —
unlike the option types (`ApiKeyOptions` etc.), which stay local (#485).

## Alternatives considered

- **Key-tagged form `auth: { apiKey: { … } }` / `auth: { bearer: env('T') }`.**
  Terser, but the shape is a lie: one key-per-strategy _invites_ a second key
  (`{ apiKey: …, bearer: … }`) and reads as "combine these" — yet `auth` is a
  **single** strategy with no combinator (Q4). A flat discriminated union on
  `strategy` holds exactly one strategy by construction, so the type matches the
  semantics. (It also diverges from the house discriminated-union convention —
  `StitchEvent` / `SecurityScheme` are flat `{ discriminant, … }`.) Rejected.
- **`type` as the discriminant.** Rejected — see Q5 (value-space collision with
  `scheme.type`).
- **Status quo (factory only).** The motivating ceremony (import + call for a
  field that already serializes as a descriptor) stays. Rejected.
- **Deprecate the factories in favour of descriptors.** Rejected — factories are
  required for BYO/custom `apply`, are terser for `bearer`, and are the natural
  programmatic/shareable form. Both stay first-class.

## Consequences

- `auth` gains a declarative form; no import needed for built-in strategies; the
  intake shape now matches the inspected/exported descriptor.
- `auth` becomes an atomic `extends` slot (fixes a latent strategy-deep-merge
  bug as a side effect).
- One new normalization branch at construction; `__config` stays strict JSON;
  redaction unchanged.
- Surface growth: `AuthDescriptor` / `AuthConfig` exported. Every doc/test that
  shows `auth:` gains a descriptor variant; generators may switch to descriptor
  emit (Q8).
- Additive and non-breaking: every existing factory call is untouched.

## Gates

- **Browser-first:** descriptors add no Node dependency; normalization is pure.
- **Bundle-frugal:** normalization is a small dispatch table over the five
  factories already in the bundle; no new runtime weight beyond the switch.
- **Contract-not-dependency / P0:** `__config` remains strict JSON; live leaves
  stay on `__rawConfig`; `authScheme` export path is unchanged. Aligns with the
  "auth to a descriptor" vision ADR 0011 already records.

## Revisit if

- A sixth strategy or a genuinely composed auth (a combinator over strategies)
  appears — the descriptor union and the "single atomic slot" assumption would
  both need revisiting.
- Standard-Schema-style structural needs push auth config toward something the
  flat union can't express.

## Rollout (proposed, one PR per step, stop between)

1.  `AuthDescriptor` union + `normalizeAuth()` + atomic `extends` slot (Q7) + the
    detection rule (Q6). Tests: every descriptor → same wire behaviour as its
    factory; `{ strategy, apply }` precedence; extends last-writer-wins.
2.  Docs: a descriptor variant beside every `auth:` factory snippet; reference +
    guide updates; CONTRACT note recording `strategy` as the settled discriminant.
3.  Generator emit switch (Q8) for `gen openapi` + `from-curl`, with updated
    golden/emit tests.
