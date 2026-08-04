# ADR 0022 — Response classification is one decision in two phases; merge them at `interpret`

- **Status:** Accepted and implemented (2026-08-04) — all six rollout steps in this PR. Resolves [#529](https://github.com/rejifald/StitchAPI/issues/529) and keeps [#155](https://github.com/rejifald/StitchAPI/issues/155) whole. Builds on [ADR 0005](./0005-surfaces-and-the-authoring-model.md) Decision 3 (the `Surface` seam) and [ADR 0008](./0008-non-http-surfaces-and-pipe.md) Decision 1 (`execute` inside the resilience chain). All five open questions resolved as implemented.
- **Date:** 2026-08-03
- **Tags:** engine, surfaces, resilience, api-surface, P0, P7, P14, P21, P24, breaking, P19-pre-GA

> [!NOTE]
>
> Two changes, one thesis. **Internally:** `interpret` moves inside the attempt
> loop and becomes the single place a response is classified. **At the authoring
> site:** the flat `acceptStatus` slot folds into a `verdict` envelope —
> `verdict: { accept: [404] }` — so the config declares what that stage decides
> instead of floating a status rule at the root. Pre-GA hard break (rc channel,
> CONTRACT.md D5/P19), mechanical to migrate.

## Context

The engine decides what a response _is_ in two places, at two times, and neither
can see what the other sees.

```
── phase 1 · inside attemptLoop (engine.ts:612–754) ─────────────────
   sees      status · attempt number · delegate mode
   can do    refresh · delegate · retry · accept · throw
   blind to  the body
      │
      │ returns AdapterResponse — a 2xx, or a non-2xx `acceptStatus` allowed through
      ▼
── phase 2 · interpretResponse (engine.ts:882 paginated, :1113 buffered) ─
   sees      the body
   can do    say ok / not-ok. That is the whole vocabulary.
   blind to  attempts, and every non-2xx phase 1 already threw on
```

Every open question in this area is one of those two blind spots:

| symptom                                                                              | which blindness                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [#155](https://github.com/rejifald/StitchAPI/issues/155) → `acceptStatus` was minted | phase 1 needed a success verdict and could only match status                 |
| [#529](https://github.com/rejifald/StitchAPI/issues/529) → body-aware retry          | phase 2 can read the body but cannot ask for another attempt                 |
| a surface's `interpret` never sees a `404`                                           | phase 1 throws at [`engine.ts:754`](../../packages/core/src/engine.ts) first |
| the five-outcome ladder is hard to discover                                          | it is half in phase 1, half in phase 2, and no artifact renders both         |

Proposals so far — fold the status slots into a `status` envelope, fold
`acceptStatus` into `wire`, replace them with a `classify` callback, remove
`acceptStatus` outright — all rearrange **phase 1's** furniture. None of them
touches the split, which is why each one either loses something real (atomicity,
P0, ergonomics) or relocates the problem without shrinking it. They are recorded
under _Alternatives_.

### The root cause: `httpSurface` is empty

```ts
export const httpSurface: Surface = { id: 'http' };
```

[`surface.ts:100`](../../packages/core/src/surface.ts) — no hooks at all. The
default interpretation is hard-coded in the engine instead:

```ts
return cfg.kind?.interpret
    ? cfg.kind.interpret(res, cfg)
    : { ok: true, data: res.body };
```

[`engine.ts:1067`](../../packages/core/src/engine.ts). So `http` — the surface
almost every stitch uses — is the one surface with **no interpretation of its
own**. That is why its interpretation policy had nowhere to live and ended up as a
top-level config slot patching an unnamed hard-coded default.

`acceptStatus` is not a misplaced resilience knob. **It is the http surface's
`interpret`, homeless.** The config anatomy has been saying so: every pipeline slot
carries a `stage`, **stage 4 is the surface's `interpret`**
([`config-summary.ts:78`](../../packages/core/src/config-summary.ts)), and
`acceptStatus` is declared with no stage at all
([`config-anatomy.ts:122`](../../packages/core/src/config-anatomy.ts)) — it does a
pipeline stage's job and is invisible in the pipeline.

## Decision

### 1. `interpret` moves inside the attempt loop

It runs at the terminal decision point of each attempt, on **every** response
including non-2xx, instead of once after `runAttempts` has finished. The ladder
becomes, per attempt:

```
1. run the attempt                                   → res
2. auth refresh.on(status)      → refresh, redo the attempt, don't count it   ── unchanged
3. throttle.on(status) + delegate → throw RateLimitError                       ── unchanged
4. retry.on(status) && attempts remain → sleep + retry                         ── unchanged
5. interpret(res, cfg)                               → outcome                 ── MOVED HERE
6. outcome asks to retry && attempts remain → sleep + retry                    ── new (#529)
7. outcome.ok  → return outcome.data
8. otherwise   → throw
```

Steps 2–4 are untouched: they are **status-based policy deciding an action**, and
they keep matching on the raw status exactly as they do now. Step 5 is the
**terminal verdict**, and it is the only step this ADR moves.

> [!IMPORTANT]
>
> This ordering preserves today's behaviour exactly, including the subtle case.
> "A status in both `retry.on` and `acceptStatus` is retried while attempts remain,
> then accepted on the final attempt" (case D of
> [`accept-status.spec.ts`](../../packages/core/test/gaps/accept-status.spec.ts))
> still holds: step 4 retries the `503` while attempts remain; on the final attempt
> step 4 falls through and step 5's `interpret` accepts it.

**`interpret` does not start running N times.** Steps 2–4 `continue` before
reaching step 5, so a status-driven retry never invokes `interpret` for that
attempt. It still runs once per run in every case that exists today; it runs more
than once only when `interpret` _itself_ asks for another attempt (step 6), which
is new capability, opted into by the surface. This is the cost #529 flagged as
needing scoping — under this ordering it largely does not materialise.

### 2. `httpSurface` gains a real `interpret`, over an exported `verdictOf`

The status verdict stops being an engine branch and becomes a named, exported,
composable function. It is split in two, because **a status implies a failure but
never a success value**:

```ts
// The STATUS alone — transport health. Takes a number, not a response.
export const classifyStatus = (
    status: number,
    cfg: ResolvedStitchConfig,
): Extract<SurfaceOutcome, { ok: false }> | undefined =>
    status < 400 || acceptsStatus(cfg.verdict?.accept)(status)
        ? undefined
        : { ok: false, message: `HTTP ${status}`, status };

// The whole declarative verdict — the status, then `verdict.flag`. What a surface composes.
// Says nothing about what a success CONTAINS; that is not knowable from a verdict.
export const verdictOf = (
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): Extract<SurfaceOutcome, { ok: false }> | undefined =>
    classifyStatus(res.status, cfg) ?? flagFailure(res, cfg);

// The http surface's own interpretation: the verdict, then ITS choice of result.
export const httpInterpret = (
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): SurfaceOutcome => verdictOf(res, cfg) ?? { ok: true, data: res.body };

export const httpSurface: Surface = { id: 'http', interpret: httpInterpret };
```

#### Why the status is its own function

`classifyStatus` takes a bare `number` because two callers need **only transport
health**, and asking them the fuller question is a bug rather than a nicety:

- **the ladder's circuit routing.** A `200` the surface rejected — graphql's
  `errors`, a falsy `verdict.flag` — is an application-level rejection of a healthy
  transport. Routing it through the body-aware verdict opens the breaker on it, so
  one bad payload takes down every call to that host.
- **the streaming gate.** At open time there is no buffered body to rule on. Only the
  status is known, so only the status can be asked, and the signature says so instead
  of a comment promising it.

This was found the hard way: the first cut asked `verdictOf` at the routing site,
and a `verdict.flag` failure on a `200` tripped the circuit. The narrow signature is
what makes that class of mistake unrepresentable.

The split is what makes the function genuinely composable. Every surface agrees a
`500` is a `500`; **none of them agree on what a `200` yields** — `http` means the
raw body, `download` a `{ blob, filename }`, `llm` the provider's parsed
completion, `shell` a decoded stdout. Folding `data: res.body` into the shared
function would make it assert a response format on behalf of surfaces that mean
something else, so each composing surface would have to build that success value
and immediately discard it. Only the failure arm is universal, so only the failure
arm is shared.

`interpret` already receives `(res, cfg)`, so this needs no new plumbing. Stage 4
stops being conditional on `kind !== 'http'` in the pipeline read-out — the http
surface now has an interpretation worth rendering.

#### The default has to be SELECTED, not fallen back to

Giving `httpSurface` a hook is not enough on its own, and it is worth being precise
about why: **nothing selects `httpSurface` today.** `compose` leaves `kind` unset
when the caller omits it, so `cfg.kind` is `undefined` for the surface almost every
stitch uses, and the engine supplies the interpretation itself:

```ts
cfg.kind?.interpret
    ? cfg.kind.interpret(res, cfg)
    : { ok: true, data: res.body };
```

Hanging `interpret` off `httpSurface` while that line stands makes the hook
**decorative** — it names the default without moving it, and the engine still holds
an opinion about what a response means. So `compose` resolves the slot instead:

```ts
merged.kind = kind ?? httpSurface; // an omitted surface IS the http surface
```

`ResolvedStitchConfig.kind` becomes required, the engine's call site collapses to
`interpretOf(cfg.kind)(res, cfg)`, and the "no hook ⇒ inherit http's
interpretation" rule (`sse`, `stream`, `postmessage`, `shell` — surfaces whose job
is transport or decoding, not deciding what a response means) lives in the surface
model rather than as a `??` in the engine. There is then no branch anywhere that
decides what a response means outside a surface, which is the whole of _Context_'s
root cause.

The visible cost is one key: `__config.kind` reads `'http'` for a plain stitch
instead of being absent. That is a P0-visible shape change, and it is the honest
one — the surface was always there; only its name was missing.

### 3. `acceptStatus` folds into a `verdict` envelope

```ts
// before                     // after
acceptStatus: [404],          verdict: { accept: [404] },
```

The slot was flat and top-level because the decision it belongs to had no name at
the config surface — there was nothing to nest it under. Decision 2 makes that
decision a real, named stage, so the config can now declare it:

```ts
export interface VerdictOptions {
    /** Status(es) that are a NORMAL result rather than an error (P7). */
    accept?: StatusMatch;
    /**
     * Dot-path to a body flag that is EXPLICITLY falsy on failure — `{ ok: false, code }`.
     * Narrowed against `output`'s inferred type when one is declared (see below). An absent
     * path is no signal, never a failure: the status verdict stands, and a drift finding
     * records that the flag was not there.
     */
    flag?: string;
}
```

`accept` is today's `acceptStatus`, unchanged in type and meaning. `flag` is the
second member, and it is what makes the envelope's name exhaustive over its
contents rather than an envelope of one: it turns the third body-aware case #529
enumerates — "a `200` envelope with `{ ok: false, code: … }` (common in older
APIs)" — into **declarative data** that `verdictOf` reads, instead of requiring
a hand-authored surface. Data, so P0 and the introspection story hold; a dot-path,
so it is the same shape as `pick`.

`flag` lives in `verdictOf` rather than in `httpInterpret`'s http-specific half
because it is the caller's declaration, not the surface's: a stitch that sets
`verdict: { flag }` means it on whatever surface it selected. It reads the raw body
to render a **failure**, which is the arm every surface shares — and it never
constructs a success value, so the split holds.

#### Why `verdict` and not `interpret`

Naming the slot after the stage was the first instinct, and it is wrong on P1's
_one value-space_ clause. The stage keeps its verb: `Surface.interpret` is the
hook, `httpInterpret` its default. The config slot is the **declarative input that
hook reads**, and it is an object, not a function. Spelling both `interpret` puts
two value-spaces on one token, and it reads badly at the site that matters most —
inside `httpInterpret`, `cfg.interpret` (data) would sit two lines from
`cfg.kind.interpret` (the hook).

`verdict` is the noun that verb produces, so the pair states the relationship:
**`interpret` renders the `verdict`.** It is unclaimed anywhere in the surface, it
is one word (P1), and at the authoring site it sits naturally with the other
declarations — `retry`, `throttle`, `timeout`, `verdict`.

`classify` was considered and rejected: it implies sorting a response into one of
many tiers, which is what _Alternative C_'s callback promised and this ADR
deliberately does not do. The engine renders one verdict; it does not classify.

#### `flag` is checked against `output`'s inferred type

A dot-path typo (`meta.succes`) is the realistic failure, and it is silent: the
path resolves to `undefined`, the flag reads falsy, and every response becomes a
failure. The `output` schema already describes the response, so the authoring site
can catch it.

**At the type level, yes.** [`infer.ts`](../../packages/core/src/infer.ts)'s
`InferOutput<S>` already recovers the validated result type from any schema form —
`~standard.types.output`, Zod's `_output` phantom, a `drift()` wrapper, a hand-rolled
`Validator`, a type guard. `flag` narrows from `string` to a union derived from that
type, and a miss is a compile error carrying the house `ConfigError<Message>` brand
(#591's idiom, adopted by [#584](https://github.com/rejifald/StitchAPI/pull/584) /
[#585](https://github.com/rejifald/StitchAPI/pull/585)) rather than a bare `never`.

**At runtime, no — and this is a hard constraint, not an omission.** After
`compose()` the schemas are opaque Standard Schema `Validator`s;
[`openapi.ts:8`](../../packages/core/src/openapi.ts) says so, which is why
`export --openapi` needs a bring-your-own `toJsonSchema` converter to emit
field-level shapes at all. Core is zero-dep and cannot walk a validator. So this is
an authoring-time check only.

**The rule is containment, not position:** the path must exist _somewhere_ in the
inferred type, not at a fixed place. That looseness is required for soundness, not
convenience — `output` describes a **different value** than `flag` indexes:

```
interpret (stage 4) → transform → pick (stage 6) → output validation (stage 7)
      ▲                                                      ▲
   flag reads the RAW body here          output describes the value AFTER both
```

With no `transform` and no `pick` the two coincide and an exact path check would be
sound. With `pick: 'data.items'`, `output` describes a narrow slice and a perfectly
valid `flag: 'meta.success'` sits outside it. With `transform`, the relationship is
an arbitrary function and nothing can be concluded — so the constraint applies only
when `output` is a schema and `transform` is absent, and relaxes to `string`
otherwise. That is the same conditional-guard shape as `MultipartOnlyOnMultipartBody`.

#### An absent `flag` is silence, never a failure

The check above kills the typo at authoring time. It cannot settle the runtime
case, because a server sends what it sends: the same endpoint returns
`{ meta: { success: true }, data }` on Tuesday and a bare `{ data }` on Wednesday —
a different version, a cache tier, a partial rollout, a path someone forgot to wrap.
This library exists to survive that, so it must not be the thing that breaks on it.

`flag` is therefore **three-state, and only one state is a verdict**:

| at the path                       | verdict                                             |
| --------------------------------- | --------------------------------------------------- |
| present, truthy                   | success — the flag confirms it                      |
| present, falsy (`false` `0` `''`) | **failure** — the flag says so. The feature.        |
| `null`                            | **no signal** — see below                           |
| absent (`undefined`)              | **no signal** — falls through to the status verdict |

So `flag` can only ever turn a would-be success into a failure **when it explicitly
says so.** It cannot manufacture a failure out of silence, and a `200` carrying no
flag is still a `200`.

`null` sits with absence rather than with `false` on the same reasoning: APIs spell
"not applicable" and "unknown" as `null` constantly, and JS truthiness would read
that as a declaration of failure it never made. The rule stays one sentence — the
flag must _say_ failure — but this is the line most likely to be argued, so it is
stated rather than inherited from `!value`.

That mirrors `accept` exactly, one direction each: `accept` only ever turns a
failure into a success, and its docs already pin the same discipline — "additive,
never a blanket _ignore failures_." Neither member invents a verdict from absence.
It is the same rule twice, which is what makes the envelope teachable.

**Strictness has a home already, and it is not here.** If the envelope is genuinely
guaranteed, declare `meta.success` in `output` and let validation enforce it. That
is what the schema is for, it produces a real error with a real path, and it means
`flag` needs no strict mode — one less axis.

Absence still emits a **drift finding** ([ADR 0015](./0015-schema-anchored-drift.md),
[ADR 0016](./0016-inspect-raw-and-findings.md)) at `info`, alongside `undeclared`.
That is the whole point of findings: diagnostic, not control flow. A silently inert
`flag` — a typo that slipped past the type check because `output` was absent, or an
API that quietly dropped its envelope — shows up in `.inspect()` and the drift
report without anyone's call failing.

#### Why `flag` and not `ok`

`ok` is already the discriminant on `SurfaceOutcome` (`{ ok: true }`, a boolean).
Reusing it for a **dot-path string** is the same P1 collision one level down.
`flag` names what lives at the path, the way `pick` names what it does, and the
JSDoc carries that the value is a path — the house pattern for a unit that does not
fit in a field name (D3). `indicator` says the same thing in three more syllables,
and P1 asks for the shortest unambiguous token.

Properties this keeps:

- **Atomic in `extends`.** `verdict` is its own top-level slot, deep-merged
  independently of `retry` / `throttle` / `auth`. Nothing is hoisted out of another
  policy envelope, which is what sank _Alternative A_.
- **P0.** Both members are plain JSON. `verdict` inherits `acceptStatus`'s
  `redact-if-fn` treatment for the predicate form of `accept`.
- **P24 / #591's test.** Every member is an input to the verdict, so the name is
  exhaustive over its contents — the property `wire` was bought with, and the one
  _Alternative B_ failed.
- **P20.** The opaque `verdict: {}` is rejected (`AtLeastOne`).

No P12 scalar shorthand: `verdict: [404]` would not tell a reader what the list
means. `wire` and `input` set the same precedent. The cost is that #155's one-liner
gains one level of nesting — the only consumer-visible regression in this ADR, and
a mechanical migration.

### 4. Every built-in surface composes `verdictOf`

This is load-bearing, not tidiness. Today `graphqlSurface.interpret`
([`surface.ts:144`](../../packages/core/src/surface.ts)) reads `body.errors` and
returns `{ ok: true }` when it finds none — and `downloadSurface.interpret`
([`download.ts:86`](../../packages/core/src/download.ts)) returns `{ ok: true }`
unconditionally. Both are correct **only because the engine guarantees they never
see a non-2xx.** Step 1 removes that guarantee. Without composition, a `500` would
be interpreted as a successful GraphQL response, or wrapped as a downloaded Blob.

```ts
// a 500 is a failure before it is a graphql payload / a downloaded Blob
interpret: (res, cfg) =>
    verdictOf(res, cfg) ?? { ok: true, data: /* …the surface's own value… */ },
```

`verdictOf`, not `httpInterpret`: the composing surface wants the verdict and
supplies its own success value, so nothing it does not mean is ever constructed.
`??` rather than an `if (!base.ok) return base` guard falls out of the verdict
being absent-or-failure instead of an outcome that always has an arm.

`shell` and `sse` declare no `interpret` today and inherit `httpInterpret` by
falling through to the http default, so their behaviour is unchanged — including
ADR 0008 Decision 4's non-zero-exit mapping and its accept escape, now spelled
`verdict: { accept: [...] }`.

### 5. `SurfaceOutcome` gains the retry arm

```ts
export type SurfaceOutcome<T = unknown> =
    | { ok: true; data: T }
    | { ok: false; retry: true; message: string; after?: number }
    | { ok: false; message: string; status?: number };
```

This is #529's proposal, and step 1 is what makes it expressible: a surface can now
say "this `200` carries `{ status: 'PENDING' }` — go again" because it is being
asked inside the loop. It shares the `retry.attempts` budget (step 6 checks the
same `attempts remain` condition), and `after` is honoured the way `Retry-After`
is. The body-aware cases #529 enumerates — in-payload rate limits, `{ ok: false,
code }` envelopes — fall out with no new config key and no second mechanism.

## What this preserves

The three constraints the earlier proposals kept trading against each other are all
kept, because the trade was never necessary — it was forced by the phase split.

| constraint                           | how it survives                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Atomicity of the `extends` slots** | `retry.on` / `throttle.on` / `refresh.on` do not move. Nothing is hoisted out of a policy envelope. |
| **P0 — `__config` is JSON**          | `accept` stays data; no function-valued config key is added.                                        |
| **#155's ergonomics**                | still declarative, still one line — `verdict: { accept: [404] }`. One level of nesting is the toll. |
| **P21 — one seam per capability**    | classification has exactly one home (`interpret`) instead of two at different altitudes.            |
| **No flat root slot**                | the stage has a name at the config surface, and its parameters live under it.                       |

## Alternatives considered

### A. Fold the four status slots into one `status` envelope — **rejected: atomicity**

`status: { refresh, throttle, retry, accept }` makes the ladder visible in one
place, which is #529's genuine pull. It splits `retry` in two (`on` belongs with
`attempts`/`backoff` — they are one policy), and `refresh.on` cannot be folded at
all: it lives on the `AuthStrategy`, which [ADR 0021 §4](./0021-auth-strategies-move-to-a-subpath.md)
made an **atomic, non-deep-merged** `extends` slot precisely because splicing two
strategies produced a chimera. Consolidating four things whose only shared property
is `StatusMatch` trades a real composition property for a presentational one.

### B. Fold `acceptStatus` into the `wire` envelope — **rejected: wrong addressee**

Every member of `wire` is the authoring spelling of an adapter-facing codec field,
converted at the transport edge (P22): `body`→`bodyType`, `response`→`responseType`,
`array`→`arrayFormat`, `multipart`→`multipart`. `acceptStatus` has no
`AdapterRequest` counterpart and never reaches the adapter. `wire` tells the
transport how to turn values into bytes; `acceptStatus` tells the engine what the
transport's answer means.

That is also the licence [#591](https://github.com/rejifald/StitchAPI/issues/591)
bought the envelope with — "every member of `wire` is a wire-format choice, so the
name is **exhaustive over its contents**," which is why it rejected `request` /
`response` as names that promise more than they hold. It collides with work in
flight too: [#584](https://github.com/rejifald/StitchAPI/pull/584) and
[#585](https://github.com/rejifald/StitchAPI/pull/585) are narrowing `wire` member
by member per surface, while `acceptStatus` is meaningful on every surface —
including the two losing `wire` members.

### C. A `classify` / `triage` callback replacing the slots — **rejected**

#529's own conclusion, affirmed here. Function-valued config is sugar that lives
off `__config` (P0), so the opaque form cannot be primary; it duplicates `interpret`
at a second altitude (P2/P21); and the verdict is not a function of status alone —
a `503` is _retry_ on attempt 1 and _accept_ on attempt 3 — so the honest signature
`(status, ctx) => verdict` hands every caller the job of hand-rolling the ladder.
This ADR reaches the same seam the callback was groping for, without minting a
config key: `interpret` **is** the classifier, it already exists, and it is
per-surface rather than per-stitch.

### D. Remove `acceptStatus` and let surfaces own it entirely — **rejected: worse than the disease**

Drafted in full before this thesis, and worth recording. It removes a real
duplicate mechanism, but the replacement for `acceptStatus: [404]` is "author a
`Surface`", which reverts #155 part A — the one-liner that exists specifically to
keep expected control flow off the `catch` path. The escape hatch (ship an
`accept()` helper surface) is `acceptStatus` with an import and a bundle cost.

Two things sank it. First, P21 **requires** every contract to have an extension
seam; a declarative slot plus a functional seam is the pattern it mandates, not a
P2 collision — the library already ships that shape as `pick` (data) / `transform`
(code). Second, the removal case leaned on "the precedence is discoverable only by
reading source comments," which is not true: it is in the `acceptStatus` JSDoc at
[`types.ts:956`](../../packages/core/src/types.ts) (IDE hover) and in
[`accept-status.mdx`](../../apps/docs/content/docs/guides/resilience/accept-status.mdx)'s
_Interaction with retry_ section with a worked example.

Verified while drafting it, and it cuts the same way: **no introspection consumer
reads `acceptStatus`** — `openapi.ts`, `mcp.ts`, `diagram.ts`, `config-summary.ts`
and `cli.ts` have zero references. The P0-introspection argument for the slot
describes something unbuilt. That is a reason to build it, not to delete the data.

### E. Add the retry arm to `SurfaceOutcome` and change nothing else — **subsumed**

#529's minimal proposal. It cannot work on its own: `interpret` runs after
`runAttempts` has finished, so a retry arm returned from there has no loop left to
re-enter. #529 names this ("a real reordering of the engine, not a type change")
and defers it. This ADR is that reordering, and Decision 5 is this alternative,
landed on top of it.

### F. Keep `acceptStatus` flat at the config root — **rejected: it names nothing**

The zero-migration option, and what the first draft of this ADR chose. Decisions 1
and 2 stand without it, so the fold is genuinely separable.

It is rejected because it leaves the tell in place. A flat root slot is what a
capability gets when the stage it belongs to has no name at the config surface —
which is exactly the diagnosis in _Context_, and exactly why `acceptStatus` has no
`stage` in the anatomy today while every other pipeline slot does. Fixing the
engine and leaving the config surface still saying "there is a status rule, floating
at the root, next to `headers` and `timeout`" would keep the artifact that made the
problem hard to see.

It also forecloses `verdict.flag`, which has nowhere to live under a flat spelling
short of a second root slot — and two flat root slots for one stage is the thing
[#591](https://github.com/rejifald/StitchAPI/issues/591) folded four of.

### G. Put the parameters on the surface — `kind: http({ accept: [404] })` — **rejected: P0**

The most literal reading of "it is the surface's parameter." It fails on
introspection: `kind` is redacted to its `id` string on `__config`
([`config-anatomy.ts:99`](../../packages/core/src/config-anatomy.ts),
`project: true`), so `accept` would vanish from the public view entirely — the
opposite of what keeping it as data is for. `kind` is also an atomic
last-writer-wins slot in `compose`, so a fragment setting an accept rule and a child
selecting a different surface cannot both survive. Configuration belongs in config;
the surface reads it through the `cfg` argument `interpret` already receives.

## Consequences

**Consumers migrate one slot.** `acceptStatus: [404]` → `verdict: { accept: [404] }`,
mechanical and greppable. `__config` changes shape at that key, so anything
snapshotting it re-baselines. Everything else at the authoring site is untouched.

**`__config.kind` is always present.** A plain stitch reports `kind: 'http'` where
the key used to be absent (Decision 2 — the default surface is selected rather than
implied). No authoring change, but it is a second reason a `__config` snapshot
re-baselines, and any consumer using `'kind' in cfg` / `cfg.kind ?? 'http'` as a
proxy for "is this a plain HTTP stitch" should compare the id instead.
`RedactedStitchConfig.kind` stays optional in the types — a present string still
satisfies it — so no consumer breaks at compile time.

> [!WARNING]
>
> **This was drafted as a migration with no compile-time safety net, and
> [#601](https://github.com/rejifald/StitchAPI/pull/601) removed that problem while
> this ADR was in flight.** The original reasoning still explains the hazard:
> `stitch`'s `const C extends Partial<StitchConfig>` generic captures the argument
> type, which suppresses excess-property checking, so a stale `acceptStatus:` would
> be silently ignored and the status would quietly start throwing again — the shape
> that made #591 find 2 files by typechecking and 30 by running the suite.
>
> `NoUnknownConfigKeys` reads `keyof C` rather than relying on excess-property
> checking, so a stale `acceptStatus:` is now a **compile error naming the slot** —
> verified on the config literal, on a hoisted `const` (which EPC misses entirely),
> and through an `extends` fragment. #601's own type test anticipated this rename and
> now pins the real spelling. The grep below is kept as a belt-and-braces gate, not
> because `tsc` cannot be trusted.

**Surface authors are broken, deliberately.** An `interpret` hook now runs on
responses it was previously guaranteed never to see. The two built-in hooks
(`graphql`, `download`) are fixed by Decision 4; any third-party surface must
compose `verdictOf` or handle non-2xx itself. This is a real break with no
compile-time signal — the hook's signature is unchanged — so it needs a release
note, not just a changelog line.

**The pipeline read-out gains a stage for every stitch.** Stage 4 stops being
`kind !== 'http'`-only, so `stitch diagram`, the `mcp` teaching list and
`config-summary` start rendering interpretation on plain HTTP stitches. That is the
discoverability fix #529 asked for, delivered as a rendered stage rather than a
config reshuffle.

**The streaming path is unified too.** The hard-coded gate at
[`engine.ts:1279`](../../packages/core/src/engine.ts) calls `classifyStatus` instead
of reading the status rule directly, so streaming keeps today's behaviour (including
case E of the spec file) through the same function as the buffered path — and it is
the status-only half it wants, since a live body has neither an interpreted value nor
a `verdict.flag` to read at open time. The retry
arm does not apply there — there is no buffered body to rule on at open time — and
that stays a documented limit rather than an open question.

**What does not change:** `retry` / `throttle` / `circuit` / `timeout` /
`idempotency` behaviour, `refresh.on`, the delegate-backoff path, `StitchError`'s
field set (P10), `StatusMatch` (P7), `AdapterRequest`/`AdapterResponse`, and
redaction — `verdict.accept`'s predicate form is `redact-if-fn`, exactly as
`acceptStatus`'s is.

### Blast radius (verified against `d687afb`)

| area      | sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| engine    | [`engine.ts:612`, `:754`](../../packages/core/src/engine.ts) (the ladder + the throw), `:882` / `:1113` (both `interpretResponse` call sites move into the loop), `:1063`–`1069` (the hard-coded default goes), `:1276`–`1279` (streaming gate delegates)                                                                                                                                                                                                                                                                   |
| surfaces  | [`surface.ts:100`](../../packages/core/src/surface.ts) (`verdictOf`/`httpInterpret`/`interpretOf`; `httpSurface` gains `interpret`), `:144` (graphql composes), [`download.ts:86`](../../packages/core/src/download.ts) (composes), `SurfaceOutcome` at `surface.ts:20` (the retry arm)                                                                                                                                                                                                                                     |
| selection | [`stitch.ts:315`](../../packages/core/src/stitch.ts) (`compose` resolves an omitted `kind` to `httpSurface`), `:336` (the idempotency nudge asks WHICH surface, not whether there is one), `:893` (redaction always projects the id), [`types.ts:1240`](../../packages/core/src/types.ts) (`ResolvedStitchConfig.kind` becomes required)                                                                                                                                                                                    |
| the fold  | [`types.ts:956`](../../packages/core/src/types.ts) (`acceptStatus` → `VerdictOptions`, exported per P14), [`stitch.ts:832`, `:861`](../../packages/core/src/stitch.ts) (`REDACTED_IF_FN_SLOTS` — the fn-strip moves one level down, into the envelope)                                                                                                                                                                                                                                                                      |
| anatomy   | [`config-anatomy.ts:122`](../../packages/core/src/config-anatomy.ts) (`acceptStatus` → `verdict: { stage: 4; dropped: 'redact-if-fn' }`), [`config-summary.ts:78`](../../packages/core/src/config-summary.ts) (stage 4 unconditional)                                                                                                                                                                                                                                                                                       |
| tests     | [`accept-status.spec.ts`](../../packages/core/test/gaps/accept-status.spec.ts) — all 6 cases must pass with **only the slot spelling changed**; that is the regression gate for the reordering. [`contract-p0.spec.ts:92`, `:115`, `:219`](../../packages/core/test/contract-p0.spec.ts) (nested predicate). New cases for the retry arm, `verdict.flag`, and graphql/download meeting a `500`                                                                                                                              |
| docs      | [`accept-status.mdx`](../../apps/docs/content/docs/guides/resilience/accept-status.mdx) (rename + pipeline framing), [`errors/index.mdx:38`](../../apps/docs/content/docs/errors/index.mdx), a surface-authoring note on `verdictOf`/`httpInterpret`, ADR 0005 Decision 3's `interpret` description, the playground completions (regenerated)                                                                                                                                                                               |
| tethers   | [`CONTRACT.md:216`–`217`, `:810`](../CONTRACT.md) (P7's _Resolved_ list), [`README.md:287`](../../README.md), [`packages/core/README.md:422`, `:425`](../../packages/core/README.md), [`packages/shell/README.md:41`](../../packages/shell/README.md), [ADR 0008 Decision 4](./0008-non-http-surfaces-and-pipe.md), [`shell/src/index.ts:58`](../../packages/shell/src/index.ts), [`llm.ts:127`](../../packages/core/src/llm.ts), [`resilience.ts:22`](../../packages/core/src/resilience.ts) — all comment/prose spellings |

## Open questions

_All five are resolved as implemented. The reasoning is kept so the choices are not
relitigated._

1. **The public export's name.** _Resolved: `verdictOf`._
   [ADR 0012](./0012-integration-symbol-naming.md) governs cross-package symbol
   naming, and this is the one new public export a surface author imports. It is
   named for **what it produces**, and it pairs with the config slot that feeds it —
   `verdict` is the declaration, `verdictOf(res, cfg)` is that declaration applied to
   a response. Decision 3 already fixed the pair as _`interpret` renders the
   `verdict`_; this closes it at the call site.

    `httpFailure` was the working name and is the one thing lost: it advertised the
    `Failure | undefined` return, where `verdictOf` reads as though a verdict always
    comes back. The `??` at every call site carries that instead —
    `verdictOf(res, cfg) ?? { ok: true, data: mine }` — and the type makes a misread a
    compile error rather than a runtime surprise. Alternatives weighed and dropped:
    `isAcceptable` / `rejectByStatus` name the question rather than the answer, and
    the `http` prefix was misleading once the function also read `verdict.flag` off
    the body.

    It lives in `surface.ts`, already on the root barrel that `@stitchapi/shell`
    imports from, so nothing drags the engine in.

    **Only one of the three scopes is public**, and that is the answer to "don't they
    all serve the same purpose?" — they do, which is exactly why the barrel carries
    one. `classifyStatus` answers the engine's transport-health question at two
    internal call sites and has no surface-author use; `httpInterpret` is the http
    surface's own hook, reachable as `httpSurface.interpret`. Three names for one
    decision on the barrel invites composing the wrong one, which is precisely the
    mistake that first routed a flag-failed `200` through the circuit's
    transport-failure path. `public-api-surface.spec.ts` pins the absence of both.

    `classifyStatus` rather than a bare `classify` is deliberate even internally: _Alternative C_
    rejected `classify` for the config callback because it "implies sorting a response
    into one of many tiers", and a bare `classify` would still promise that while
    returning two states. Qualifying it with what it classifies — a **status** — makes
    the two-tier reading the honest one, and keeps the rejected callback's name free.

2. **Does the body-driven retry share `retry.attempts`?** _Resolved: yes._ One budget
   is easier to reason about than two, and the counter — that a polling `PENDING`
   loop and a flaky-`503` loop are different failure modes — is better answered by
   the surface returning `after` than by a second attempt cap. Revisit if a caller
   is found needing to bound them separately.
3. **Which event does the body-driven retry emit?** _Resolved: the existing
   `progress`/`retry` event, with a distinguishable `detail`._ A status-driven retry
   reads `status 503`; a body-driven one reads `interpret: <message>`, so a trace
   consumer can tell them apart without a new phase to teach.
4. **Idempotency.** _Resolved: held to the same rule, by construction._ The key is
   stamped once in `buildRequest` and every attempt is a `cloneReq` of that request,
   so a body-driven retry replays the identical `Idempotency-Key` exactly as a
   status-driven one does. Nothing was needed to make this true — but it is now
   pinned by a test rather than left to be inherited by accident.
5. **What does the `flag` path constraint cost `tsc`?** _Resolved: ~1%, so the full
   containment check stands rather than degrading to a leaf-name check._ `PathsIn`
   carries a **depth cap of 4** and indexes arrays through their element type (so a
   tuple cannot fan the union out by length). Measured on `pnpm check:types`
   (workspace-wide, including the docs twoslash pass — the deepest inferred types in
   the repo), three runs each: **14.93 / 14.94 / 15.00 s before, 15.14 / 15.09 /
   15.12 s after** — about +0.16 s. Four levels covers the realistic envelope
   (`meta.success`, `result.status.code`); past that the guard yields `string` and
   stops constraining rather than costing seconds.

_Settled while drafting, recorded so the reasoning is not relitigated:_ the
envelope is `verdict`, not `interpret` (P1 value-space — see Decision 3) and not
`classify` (it implies many tiers, which is _Alternative C_'s promise, not this
one). Its second member is `flag`, not `ok` (already `SurfaceOutcome`'s boolean
discriminant) and not `indicator` (P1 — shortest unambiguous token). `verdict.flag`
ships **in this ADR** rather than as a follow-up: it is what makes the envelope more
than a rename, and it closes a #529 case declaratively.

## Gates

- [`accept-status.spec.ts`](../../packages/core/test/gaps/accept-status.spec.ts)
  passes with **only the slot spelling changed** — all six cases, including D
  (retry-then-accept) and E (streaming). Any case needing a behavioural edit means
  the reordering changed semantics and the ADR is wrong. Do the rename in step 5,
  so step 3 has an untouched fixture to prove itself against.
- `contract-p0.spec.ts` — `__config` still round-trips, with the predicate form of
  `accept` stripped one level down.
- New: `graphql` and `download` interpret a `500` as a failure; a surface returning
  the retry arm re-attempts within `retry.attempts` and stops at the cap.
- **`flag`'s three states, each pinned separately** — and the one that matters most
  is the negative: a `200` whose body does **not** carry the configured path
  **resolves**, with an `info` finding. Same for `null`. Only an explicitly falsy
  value fails. A regression here silently breaks working calls, so it is a test, not
  a doc sentence.
- `check:contract` baseline 0; `pnpm -r check:types` incl. docs twoslash;
  `check:types-d`; core `test`; `build:typed-deps`; `check:size` (a new export on
  the lean path).
- A repo-wide `grep -rn 'acceptStatus:'` returning nothing. Belt-and-braces since
  #601: `NoUnknownConfigKeys` makes the stale spelling a compile error, so `tsc`
  catches it too (see the note in _Consequences_).
- **`check:types` wall-clock measured before and after the `flag` constraint**, on
  the docs twoslash pass (the deepest inferred types in the repo). A `.d.ts` type
  test pinning both directions: a good path compiles, `meta.succes` is a
  `ConfigError`, and `flag` stays `string` when `transform` is set or `output` is
  absent.

## Rollout — six steps

> [!NOTE]
>
> Drafted as one PR per step, stopping between. Landed as **one PR carrying all six**,
> at the maintainer's direction. The step boundaries were still worked and verified in
> order — the whole suite was green at each one, and step 3 (the reordering) was gated
> on `accept-status.spec.ts` before anything after it was written — so the sequencing
> below is a description of how the change was built, not a plan.

Decisions 1–2 (the engine) and Decision 3 (the fold) are independent. The engine
lands first so the risky step is measured against a fixture nobody has touched.

1. **`verdictOf` + `httpInterpret` + a SELECTED `httpSurface`, engine still
   authoritative.** Extract the status verdict into the exported functions; have the
   engine's hard-coded branch call `verdictOf` (the ladder returns `res` itself, so
   it wants the verdict, not a value); and resolve an omitted `kind` to `httpSurface`
   in `compose` so the engine's interpretation branch goes away rather than being
   renamed. Behaviour-neutral on every call path; the one visible change is
   `__config.kind: 'http'` on a plain stitch.
2. **Compose `verdictOf` into `graphql` and `download`.** Still no reordering —
   they simply gain a guard that cannot fire yet. Add the `500` tests now, so step 3 lands with
   its safety net already in place.
3. **Move `interpret` into the loop** (Decision 1) and delete the hard-coded throw.
   The risky step, landing alone, gated on `accept-status.spec.ts` passing
   unmodified. Streaming gate delegates in the same PR.
4. **`SurfaceOutcome` retry arm** (Decision 5) + the anatomy `stage: 4` + the docs.
   Additive on top of a settled engine.
5. **The fold** (Decision 3) — `acceptStatus` → `verdict: { accept }`, plus
   `verdict.flag` with its three-state runtime semantics (explicit falsy only;
   absent and `null` are silence + an `info` finding) but typed
   as a plain `string`. Mechanical, wide, and deliberately last, so a repo-wide
   rename never shares a diff with a semantic change. The predicate's fn-strip moves
   with it: `verdict` joins the `fns` (nested-strip) slots beside `retry` / `throttle`
   rather than staying a top-level `redact-if-fn`.
6. **The `flag` path constraint** — the `InferOutput`-derived narrowing and its
   `ConfigError` brand, landing alone because it is the only step whose cost is
   measured in `tsc` seconds rather than bytes (Q5). Behaviour is already correct
   without it; this makes a typo unrepresentable.

## Revisit if

- A surface author is found composing `verdictOf` in every hook with no
  exceptions — then the composition should be the engine's default and the hook
  should be a narrower "additional rules" seam, not a full replacement.
- Q2 resolves toward separate budgets, which would make the body-driven retry a
  policy in its own right and put a fifth arm back on the ladder — at which point
  the envelope question in _Alternative A_ deserves a second look, on better
  evidence than it had here.
