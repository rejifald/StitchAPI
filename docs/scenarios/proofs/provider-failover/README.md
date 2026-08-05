# Proofs — failover, hedging, and the difference between them on the bill

Runnable evidence for the claims in [`../../provider-failover.md`](../../provider-failover.md).

**The scenario's answer is a pair of integers, and it is `[10, 10]` against `[10, 0]`.** Ten calls in
which the primary succeeded every single time: `any(primary, backup)` — the combinator whose
docstring says _"failover across interchangeable sources… a primary and a mirror, two regions, two
providers"_ — sent **ten requests to the backup**. The corrected construction sent **zero**. Every
other number here is the distance between those two, or a reason the distance is bigger than it
looks.

Every script is standalone and offline. Where a claim is about time — how much of a cancelled
request's work was already done, when a hedge's second leg fires, a 30-second circuit cooldown — it
runs on an injected `manualClock()`, so the numbers (`40`, `60`, `t=0`) are exact rather than
approximate. Where a claim is about whether a spelling EXISTS, it runs the TypeScript compiler over
candidate statements and reports which ones compile, so "there is no sequential-fallback combinator"
is measured rather than grepped.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/provider-failover/c1-any-calls-both.ts

# all of them
for f in docs/scenarios/proofs/provider-failover/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/provider-failover/*.ts
```

## What each script establishes

| Script                         | Question                                                   | Measured                                                                                                             |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `c1-any-calls-both.ts`         | does `any()` call every member on a SUCCESSFUL primary?    | **`[10, 10]` — 20 requests for 10 answers.** And the loser COMPLETES (0 aborted), and a slower healthy primary LOSES |
| `c2-sequential-fallback.ts`    | is sequential fallback expressible? at what cost?          | **Yes — `linked` + try/catch, `[10, 0]`, and ONE traceId.** No combinator: 9 of 13 spellings refused                 |
| `c3-classification.ts`         | can failover trigger on 429/5xx but not 400?               | **No built-in.** `AggregateError` with `status`/`body` both `undefined`; one bad payload → 2 bills                   |
| `c4-one-input-every-member.ts` | do `any`/`race` share `all()`'s one-input behaviour?       | **Yes — config survives, INPUT is broadcast.** A per-call bearer for the primary ARRIVED AT THE BACKUP               |
| `c5-winner-identity.ts`        | is the winner's identity recoverable?                      | **No.** Both members emit `result`; a cancelled one emits NOTHING terminal — a dangling span                         |
| `c6-cancellation.ts`           | is the loser cancelled, and what does that save?           | **Billed for the WINNER's latency, every time.** Equal-speed providers: 80 virtual ms, **0 saved**                   |
| `c7-hedging-amplification.ts`  | does `race` amplify? can a breaker be scoped to the hedge? | **2.00× healthy AND degraded — no threshold.** And two `url`-only stitches share **one** breaker                     |
| `c8-assembled.ts`              | the best available answer, priced                          | **`[10, 0]`, classified, attributed, one trace — 30 lines vs 104 hand-rolled**                                       |

## Files

- `fake-provider.ts` — the two providers as plain `Adapter`s over the injected clock. Deliberately
  NOT interchangeable on the wire (different origin, path, auth header, success envelope, error
  vocabulary), because that is the normal case. Each keeps its own ledger, and the four integers
  every claim reads are `received` (the request arrived — the billable event), `completed`,
  `aborted` (arrived and was cancelled mid-flight) and `workedMs` (virtual ms of work done, aborted
  requests included — the "tokens generated before the cancel" proxy). `hits(pair)` reduces the pair
  to the `[primary, backup]` spine every claim prints.
- `providers.ts` — `rig()`: both providers, both stitches, one clock, with hooks for per-member and
  shared config. One place so that eight scripts measure the same construction.
- `trace-probe.ts` — a `TraceSink` recording `(name, type, traceId, spanId, parentSpanId)` per event.
  Load-bearing for C2 and C5: whether the failover is one trace tree or two, and whether anything
  downstream can name the provider that served the call, are both facts about the event stream and
  not about the returned value.
- `probe-store.ts` — a `StitchStore` that records every key the engine touches. C7(e) turns on it:
  whether the pair shares a breaker is a fact about what STRING the state was keyed on.
- `type-probe.ts` — hands the TypeScript compiler one candidate statement per spelling and reports
  which compile. `typescript` is `require`d through a path anchored at `packages/core` (the workspace
  package that declares it) — a bare `import ts from 'typescript'` resolves under `tsx` and not under
  plain Node from `docs/`, which would make the script run one way and typecheck another.
- `failover.ts` — the assembled answer C8 runs. The region between the `<count:begin>`/`<count:end>`
  markers is what C8's line count measures.
- `hand-rolled.ts` — the same feature set with no library at all (per-provider auth, retry with a
  status set and backoff, per-provider breaker with cooldown, an error carrying status and body,
  normalisation, lifecycle events), against the same fake providers. The baseline C8 prices against.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C1 is the finding, and the docstring is the footgun.** `any`'s first line is "Run nodes
  CONCURRENTLY" and its second sentence is "failover across interchangeable sources — a primary and a
  mirror, two regions, two providers" (pipe.ts:274-280). Measured over ten calls where the primary
  succeeded every time: **10 primary requests, 10 BACKUP requests, 20 for 10 answers**. A `try`/`catch`
  over the same two providers measured **[10, 0]**. The difference between the two constructions is
  the backup vendor's entire bill.
- **Three things about C1 the capture does not predict.** (1) The loser does not merely get called, it
  **completes**: 10/10 backup requests measured `completed`, **0 aborted**, because `ctrl.abort()` is
  in `runAny`'s `finally` (pipe.ts:154-156), one microtask after the winner settled. (2) `any` has
  **no preferred member** — it is `Promise.any` (pipe.ts:152), so with a healthy primary that was
  merely 10ms slower the winner measured `served_by: "backup"` and the healthy primary was aborted
  mid-flight. If the backup is a cheaper model, that is a silent quality regression as well as a
  double bill. (3) `all`, `any` and `race` each measured **[1, 1]** on one call: they are one eager
  implementation with three joins (pipe.ts:96-175), identical in spend, different only in which
  result they keep.
- **C2 refutes the capture in the PESSIMISTIC direction.** "There is no sequential-fallback
  combinator… so the correct default may be the one shape the library doesn't offer." There is no
  combinator — the compiler refused **9 of 13** candidate spellings, and the four that exist are three
  concurrent joins plus one sequential SCOPE — but the correct default is fully available and it is
  `linked` + `try`/`catch`: **[10, 0]** on a healthy primary, correct failover to a backup-served
  answer on a 503.
- **And `linked` earns its place for a reason the capture never raises: the trace.** The failover
  measured **ONE traceId**, spine `primary<-<root>, backup<-primary` — the chain an on-call engineer
  wants. The bare `try`/`catch` measured identical request counts and **TWO unrelated root traces**.
  The cost is that `linked` returns a Promise, not a `Composable` (pipe.ts:357-369): the flow is a
  statement that runs once, not a node you can nest, hand to a seam, or introspect.
- **Nothing delays a member's first request.** A `throttle: '1/10s'` on the backup did NOT hold it
  back — it left at **t=0** and the pair measured [1, 1] — because a throttle is a minimum spacing
  between SUCCESSIVE calls. A hedge delay is not expressible on a member.
- **C3's aggregate is worse than "an AggregateError hides the actionable one".** Measured: `status`
  **`undefined`**, `body` **`undefined`**, message `"All promises were rejected"`. Every field a catch
  block routes on is dropped at the combinator boundary — the engine populates
  `StitchError.status`/`.body`/`.url`/`.attempts` (types.ts:1657-1691) and `Promise.any` replaces it
  with a builtin carrying none of them. The actionable 400 (`invalid_request`) survives only inside
  `.errors[0]`, which no `StitchError` API points at. And the malformed payload cost **two** bills:
  the backup received the identical body and 400'd on it.
- **One built-in does surface the actionable error — the wrong one.** `race` handed the caller a real
  `StitchError` **400** with the body intact, because first-to-SETTLE means the primary's rejection
  wins. That same property makes it unusable as failover: a 500 primary against a healthy backup also
  measured **500**.
- **Classification is small, and it is user code.** A 6-status `Set` and one `if` over
  `StitchError.status` inside a `linked` body measured **[1, 0]** on a 400 (chain stopped, actionable
  error preserved) and **[1, 1]** on both 429 and 500. `retry: { on: [...] }` (types.ts:981-986) is
  exactly the right vocabulary scoped to the wrong target — it re-hits the SAME endpoint, and `any`'s
  own docstring draws that distinction and then offers no `on` of its own.
- **C4 splits along the CONFIG / INPUT line, which is the useful way to say it.** Everything DECLARED
  is per-member and works with zero user code: `/v1/complete` + `Authorization: Bearer pk-primary`
  against `/generate` + `x-api-key: sk-backup`, neither credential on the other provider, and a
  per-stitch `pick` (`choices.0.text` vs `output`) normalising two different response envelopes.
  Everything PASSED is broadcast (pipe.ts:75-86).
- **The broadcast leaks credentials.** A per-call `headers: { authorization: 'Bearer …' }` intended
  for the primary was measured **arriving at the backup verbatim** — one vendor handed another
  vendor's credential, silently, no type error — because config headers merge under input headers
  (engine.ts:232) and each strategy only overwrites its own header name.
- **A member's missing template param is not an error, it is a malformed URL.**
  `/v1/{deployment}/complete` with no `deployment` expanded to `/v1//complete` (util.ts:453-482, RFC
  6570 drops undefined vars), the provider 404'd, and **the call still succeeded** because the other
  member answered. `any` converts a silent misconfiguration into a permanently-degraded-but-green
  failover.
- **C5: the winner is unnameable, and normalising makes it worse.** `any` resolves to
  `OutputOf<M[number]>` (pipe.ts:281-286) — the member's own value, no envelope, no index, no name.
  The `pick` that normalises the two vendors DESTROYS the only attribution there was: the winner
  measured as the bare string `"answer from primary"`, indistinguishable from the backup's.
- **The trace cannot break the tie either, for a reason the capture does not anticipate.** On a happy
  path BOTH members emitted a terminal `result` (measured `["backup","primary"]`) with nothing marking
  the one the caller received; the group emitted **0** events because `makeComposable`
  (pipe.ts:210-220) is not a span. And a member that IS auto-cancelled emits `start` and `progress`
  and then **nothing** — 0 `error`, 0 `done` — because the cancellation rejection is caught by
  `swallowLateRejections` (pipe.ts:90-92) outside the engine. A hedge's trace is one closed span and
  one span that simply stops.
- **The sharpest detail in C5.** `all` accepts a NAMED bag and returns a keyed object
  (pipe.ts:252-260); `any` and `race` accept only arrays and bare arguments. The one combinator that
  carries member names through to its result is the one whose semantics never need them. The fix for
  `any` is `transform` — one line per member, measured returning `{ provider: 'primary' }` and
  `{ provider: 'backup' }` across a failover.
- **C6: "auto-cancelled" never means "not sent", and the saving is a fraction.** Every measurement
  confirms the loser's request ARRIVES. What the cancel saves is set by the latency gap: a 100ms loser
  against a 40ms winner was billed **40** virtual ms and saved 60 — **the loser is billed for the
  winner's latency, every time**. Two equally-fast 40ms providers burned **40 each, 80 for one
  answer**, and although the loser IS recorded as aborted, the work the abort saved measured **0**.
  The better a backup is, the less cancellation saves.
- **Two writes for one intent, measured.** `race` over a POST delivered the identical
  `{ charge: { amount: 4200 } }` to BOTH providers, method `POST` at each, with the cancel arriving
  after both landed. Nothing in the combinators inspects `method`.
- **The half of cancellation that works exactly as documented:** an external abort at t=30 reached
  BOTH members (1 and 1 aborted, 30 virtual ms billed each) via `linkedController` (pipe.ts:57-71),
  with **0** timers left pending.
- **C7 refutes the capture in the OPTIMISTIC direction, twice over.** "Hedging amplifies outages" is
  the standard warning and it understates this: `race` has **no threshold**, so amplification measured
  **2.00× healthy** and **2.00× degraded** — identical. The doubling is the steady state, and there is
  nothing to tune. Against a degraded backend the hedge also buys nothing: two 500ms legs answered in
  **500** virtual ms, exactly one call's latency, for **1000ms** of provider work.
- **A breaker cannot bound hedge spend, because it is a health gate and not a budget gate.** Ten
  healthy calls with `circuit: [2, '30s']` on both members still measured **[10, 10]**. No resilience
  primitive in the library counts successful requests.
- **What the breaker DOES buy is real.** With the primary returning 500, `any` + per-member `circuit`
  wasted exactly **2** requests on the dead leg and then stopped, while the backup served all **6**
  calls. This is the one construction in the scenario that works as you would hope.
- **THE TRAP: a `url`-only failover pair shares ONE breaker.** Neither stitch has a `name` or a
  `path`, so both key on the literal string `'stitch'` (resilience.ts:353 over engine.ts:857-861;
  `hostKey` → `nameOf` → `cfg.name ?? cfg.path ?? 'stitch'`, engine.ts:140,265-274). Measured **one
  key `circuit:stitch`** for the pair, and the primary's outage opened the BACKUP's breaker:
  `ok, ok, AggregateError, AggregateError, AggregateError`, with the healthy backup receiving only 2
  requests and fast-failed unasked on the other 3. The caller's `AggregateError` carries
  `status: undefined`, so nothing even says "circuit open". Setting `name` fixes it completely (5 of 5
  ok) — **the partition key is a diagnostic label**.
- **The delayed hedge everyone actually recommends is outside the vocabulary.** Hand-rolled, it
  measured the right profile — **[10, 0]** healthy, **[10, 10]** degraded — in ~11 lines of raw
  `AbortController` + `Promise.race` + a clock sleep. No combinator contributes to it, and it gets
  none of `linked`'s trace linkage.
- **C8, as one sentence: the library carries everything PER MEMBER and nothing BETWEEN members.** The
  assembled answer measured **[10, 0]** with every call credited to the primary; a 400 stopped the
  chain at [1, 0] with a real `StitchError` 400, `attempts: 1`, body intact; a 503 retried the primary
  twice and then failed over ([2, 1]) returning `{ provider: 'backup', value: 'answer from backup' }`
  in **one** trace tree; both providers down gave the LAST real error (`StitchError` 503 naming
  `backup`) rather than a statusless aggregate. Price: **30 counted lines against 104** for the same
  feature set hand-rolled — the library carries ~71%, all of it auth/retry/breaker/timeout/
  normalisation/trace identity.
- **And the 30 lines cannot be given back.** A `Composable` is not user-authorable: `makeComposable`
  is unexported and `__runWith` is not on the public type, while the member gate
  `Member = { __stitch } | { __composable }` (pipe.ts:188-189) checks only the BRAND. A hand-branded
  node **compiles** and then throws `TypeError` at runtime — measured. So the failover is not a node:
  no span of its own, not nestable, not introspectable, not exportable.

## The footguns

- **`any` is named and documented as failover and priced as a hedge.** "Failover across
  interchangeable sources — a primary and a mirror, two regions, two providers" describes a
  one-call-on-the-happy-path cost model; the implementation sends every member on every call.
  Measured 20 requests for 10 answers against a provider that never failed. **A combinator whose
  docstring implies one cost model while implementing another is the sharpest kind of footgun,
  because the bill arrives monthly and the tests all pass.**
- **"The losers are auto-cancelled" reads as "the losers are free".** It is neither. The request
  always arrives; the loser is billed for the winner's latency; and against a backup that is not
  slower it completes in full (10/10 measured). For a token-metered API, cancelling refunds the tail.
- **`any` prefers the FASTER member, not the FIRST one.** Member order carries no priority. A healthy
  primary that is 10ms slower loses, silently, to a backup that may be a different model at a
  different price and quality.
- **A `400` through `any` costs two bad requests and yields an error with no status.** `status` and
  `body` are both `undefined` on the `AggregateError`; a catch block written against `err.status`
  silently sees nothing. Reach into `.errors[0]`, or do not use `any` for failover.
- **A per-call header goes to every provider.** Including `Authorization`. Anything vendor-specific —
  a per-call JWT, `anthropic-version`, `OpenAI-Organization`, an idempotency key minted for one vendor
  — is broadcast to the other one.
- **A member whose template param you forgot is not an error, and `any` hides it.** The mis-addressed
  member 404s, the other member answers, the call returns green, and you are paying for a failover
  pair with one permanently broken leg.
- **`pick` normalises the two vendors and erases the attribution.** Use `transform` instead if you
  need to know who served the call — it does both in one line per member.
- **Two `url`-only stitches share one circuit breaker, keyed `circuit:stitch`.** The primary going
  down fast-fails the backup, which is the exact opposite of what a failover pair is for. Set `name`
  (or `circuit.key`) on every member — and note that the fix is a diagnostic label, so anyone
  "cleaning up" the names can re-break it.
- **`race` has no hedge threshold, so it doubles your traffic permanently.** It is not "hedge when
  slow", it is "always hedge". Against a degraded shared backend it also buys no latency at all.
- **Hedging a POST is a correctness bug the type system will not catch.** Nothing in `any`/`race`
  inspects `method`; both providers received the identical charge body.
- **A cancelled member leaves an unterminated span.** No `error`, no `done`. A span-based backend will
  report every hedge as a leaked or timed-out operation.
