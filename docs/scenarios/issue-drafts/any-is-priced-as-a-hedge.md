# Issue draft — `any()` is named for failover and priced as a hedge, and a per-call header reaches every member

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`provider-failover`](../provider-failover.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `pipe`, `docs`, `footgun`

> Two findings. The first is a naming/pricing mismatch with a real bill attached. The second is
> a **cross-vendor credential leak** and is the one I would fix first.

Reproduce:

```bash
for f in docs/scenarios/proofs/provider-failover/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. A per-call header is broadcast to every member

**Severity: high — one vendor receives another vendor's credential.**

`runMember` (`pipe.ts:75-86`) spreads one `StitchInput` across every member. Everything the
stitch _declares_ stays per-member (verified: `Bearer pk-primary` and `x-api-key: sk-backup`
never crossed). Everything the **caller passes** is broadcast.

Measured: a per-call `headers: { authorization: 'Bearer per-call-primary-jwt' }`, written for
the primary, **arrived at the backup verbatim**. Config headers merge _under_ input headers
(`engine.ts:232`), and each auth strategy only overwrites its own header name — so nothing
reclaims it. No type error, no warning.

The same broadcast sends the primary's `model` to the backup, and a member whose template param
wasn't supplied is not an error: `/v1/{deployment}/complete` with no `deployment` expanded to
`/v1//complete` (`util.ts:453-482`, RFC 6570 drops undefined vars), the provider 404'd, and
**the call still succeeded** because the other member answered — a silent misconfiguration that
presents as a permanently-degraded-but-green failover.

**Ask:** at minimum document that call input is broadcast and per-member credentials must live
in `auth`. Better: a per-member input shaper (`any([{ node, input }])` or a mapping function),
which would also fix the `model`/template-param cases.

## 2. `any()` calls every member on every call

**Severity: medium-high — silent double spend, and every test passes.**

The docstring (`pipe.ts:274-291`) reads as fallback — _"failover across interchangeable
sources… a primary and a mirror, two regions, two providers"_ — while the first line says
CONCURRENTLY and the implementation is `Promise.any` over eagerly-started members
(`pipe.ts:148-152`).

Measured: **10 calls in which the primary succeeded every time cost 20 provider requests.** The
same providers under `try`/`catch`: `[10, 0]`. Against a metered API that is the backup vendor's
entire bill, on the happy path.

Three compounding details:

- **"The losers are auto-cancelled" reads as "the losers are free", and is neither.** The abort
  is raised in a `finally` _after_ the winner settles (`pipe.ts:154-156`), so the request always
  arrives — 10/10 backup requests measured `completed`, **0 aborted**. When the loser _is_
  cancelled it is still billed for the winner's latency (100 ms loser vs 40 ms winner → 40 ms
  billed). Two equally-fast providers → **80 ms of work for one answer, 0 saved**. The better
  the backup, the less the cancel saves.
- **`any` has no preferred member.** A healthy primary that was 10 ms slower _lost_ — winner
  measured `served_by: 'backup'`, healthy primary aborted mid-flight. Member order carries no
  priority, so the construction silently routes away from the provider you chose.
- **Hedging a POST is a correctness bug the types won't catch.** `race` over a POST delivered
  the identical `{ charge: { amount: 4200 } }` to **both** providers; nothing in the combinators
  inspects `method`.

**Ask:** the behaviour is defensible — it is a hedge, and hedges are useful. The problem is that
the docstring sells it as the _other_ technique. Either
(a) rewrite the docstring to lead with the cost ("every member is called on every call; this is
hedging, not fallback — for fallback use `linked` + `try`/`catch`"), or
(b) add a genuine sequential combinator and point `any`'s docs at it. A `hedge({ after })`
variant would also close the delayed-hedge gap in §3.

## 3. Gaps this scenario ran into

- **No sequential-fallback combinator.** `all`/`any`/`race` are one eager implementation with
  three joins (each measured `[1, 1]` on one call). `linked` + `try`/`catch` is the correct
  default and works — measured `[10, 0]` healthy, correct failover on 503, **one traceId** with
  a `primary ← root, backup ← primary` spine (a bare `try`/`catch` gives two unrelated root
  traces). But `linked` returns a **Promise, not a `Composable`** (`pipe.ts:357-369`), so the
  flow runs once at the point of definition and cannot be nested in a combinator, handed to a
  seam, or introspected.
- **No classification for routing.** `retry.on` is exactly the right vocabulary aimed at the
  wrong target (the same endpoint). Of five declarative spellings probed, only `retry.on` and
  `verdict.accept` compile.
- **`AggregateError` drops `status` and `body`.** `Promise.any` (`pipe.ts:152`) replaces the
  `StitchError` the engine populated (`types.ts:1657-1691`), so every field a catch block routes
  on is gone; the actionable 400 survives only in `.errors[0]`, which no `StitchError` API points
  at. Interestingly `race` _does_ surface a real `StitchError` 400 with body — and is unusable as
  failover, since a 500 primary against a healthy backup also yields 500.
- **No winner identity, and no group span.** `any` resolves to the raw body with no envelope or
  index; the per-stitch `pick` that normalises two envelopes destroys the only attribution; and
  the group emits **zero** events (`makeComposable`, `pipe.ts:210-220`, is not a span). Note
  `all` accepts a **named bag** and returns a keyed object — the one combinator whose semantics
  never need member names is the only one that carries them.
- **A cancelled member emits nothing terminal** — `start`, `progress`, then silence; 0 `error`,
  0 `done`, because the cancellation rejects outside the engine (`swallowLateRejections`,
  `pipe.ts:90-92`). A span-based backend reads that as a leak or a timeout.
- **No hedge threshold at any level.** `race` measured **2.00×** amplification healthy _and_
  degraded. A breaker can't bound it either — it is a health gate, not a budget gate (10 healthy
  calls with `circuit` on both members still measured `[10, 10]`).
- **`Composable` is not user-authorable.** `makeComposable` is unexported and the member gate
  (`pipe.ts:188-189`) checks only the brand — a hand-branded node **compiles** and then throws
  `TypeError`. So the 30 lines of routing this scenario needed cannot be given back to the
  library as a node.

## 4. A second sighting of a known issue

Two `url`-only stitches have neither `name` nor `path`, so both key their breaker on the literal
string `'stitch'` (`resilience.ts:353`, `engine.ts:140,265-274,860`). Measured: **one** key
`circuit:stitch` for the pair, and the primary's outage opened the **backup's** breaker —
outcomes `ok, ok, AggregateError, AggregateError, AggregateError`, with the healthy backup
receiving only 2 of 5 requests and the caller's error carrying `status: undefined`, so nothing
even said "circuit open". Setting `name` fixes it (5/5 ok).

This is the same root cause as [`resilience-has-no-tenancy`](resilience-has-no-tenancy.md),
reached from a different direction — the breaker's partition key is a **diagnostic label**
anyone might "clean up", and there is no warning when two unrelated stitches collide on it.
Worth folding into that issue's fix: a default key that cannot silently collide.
