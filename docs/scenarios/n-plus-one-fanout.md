# Scenario: one list, a hundred follow-up calls

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `n-plus-one-fanout`

**Verification:** 8 proof scripts (180 checks), run offline, in
[`proofs/n-plus-one-fanout/`](proofs/n-plus-one-fanout/). Published page:
[`scenarios/n-plus-one-fanout.mdx`](../../apps/docs/content/docs/scenarios/n-plus-one-fanout.mdx).
Escalated: [`issue-drafts/coalescing-does-not-share-failures.md`](issue-drafts/coalescing-does-not-share-failures.md).

| Claim                             | Verdict                                            | Measured                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — combinators can't express it | confirmed, **wrong reason**                        | runtime length is fine; the **input broadcast** is the wall — 100 members, 1 input → **100 requests for 1 id**; `all()` bounded nothing (peak 100) and discarded 99 successes            |
| C2 — `cache.coalesce`             | **PASS — strongest positive of the pass**          | 100 concurrent calls / 30 ids → **30 requests**, no response landed. `coalesce: false` → 100. But a coalesced **failure is not shared**: 100 requests for one 404ing id                  |
| C3 — bounded concurrency          | works on one stitch; silently multiplied un-pooled | one stitch → **peak 8** exactly; 100 stitches → **peak 100**; `pool: 'host'` fixes it; **a lease-capable `store` keeps the fix fleet-wide** (ADR 0025) — only a lease-less store reverts |
| C4 — partial failure              | solved by `.safe()`                                | 99 rows kept, failure at index 49; bare `Promise.all` kept **0 rows and still spent all 100 requests**                                                                                   |
| C5 — thundering herd              | **default works**                                  | `expo-jitter` → **~98 distinct ms**; `'expo'` **and** `'fixed'` → **1 ms**. But `Retry-After` re-clusters all 100 into one ms by default                                                 |
| C6 — the trace                    | one tree, wrong shape                              | default 101 roots; `linked` gives 1 trace with per-call inputs — at **depth 101, fan-out 1** for calls that ran at peak 100                                                              |
| C7 — ordering                     | positional and safe; **aliasing** is the finding   | 20 rows / 5 customers → **5 distinct objects**; mutating row 0 changed row 5                                                                                                             |
| C8 — assembled                    | PASS                                               | **45 lines vs 87** hand-rolled — but **44 requests vs 32**, the gap being failure dedupe                                                                                                 |

**The capture was right about C1 and wrong about why.** It said a runtime-length list rules out
the combinators; it doesn't — `all(ids.map(…))` compiles. The input broadcast is what makes
`all()` structurally unable to express a per-id fan-out. **Third scenario to land on that same
broadcast** (7, 10, 16).

**And C2 is the strongest positive result of the pass.** In-flight coalescing is a real
capability most clients lack, it is one config field, and it is exactly the fix this shape
needs. The complement — a coalesced _failure_ releases every joiner — is the one place the
hand-rolled version wins, and it is precisely the shape a dead foreign key takes.

**Re-verified 2026-08-15 against the rebased tree, and ADR 0025 (#630) flips C3 (e).**
`pool: 'host'` + a shared `store` measured **peak 100** when this audit first ran — the store
throttle never read `pool` — and measures **peak 8** now: the engine keys the store throttle
with the same pool-aware host key, and a store with the lease verbs holds ONE budget under it,
fleet-wide (pinned in `packages/core/test/store.spec.ts:456-464`). The peak-100 reversion
survives only on a lease-less store (no `lease`/`release`), where concurrency stays
per-process (spec :466-475). Row, page callout and proof re-recorded; suite re-run green
(8 scripts, 180 checks).

---

## The use case

You `GET /orders` and get 100 back. Each one carries a `customerId`, and you need the customer.
So you make 100 more calls.

This is the most common composition shape in API integration, and every part of it is a
decision: how many at once, what to do when one fails, how to join the results back, and
whether you even need 100 calls.

## Why it is not straightforward

**N is unknown until runtime.** You cannot write the fan-out at authoring time — it comes from
the first response. That rules out any combinator that takes a fixed list of members, and it
means the per-call inputs all **differ**, which rules out anything that broadcasts one input.

Then the four decisions:

- **Concurrency.** All 100 at once will trip a rate limit; one at a time wastes the afternoon.
  And the governance is often **concurrency-based rather than request-rate-based**, so a
  requests-per-second cap doesn't protect you.
- **Partial failure.** `Promise.all` rejects on the first failure **and discards the results
  that succeeded**. One deleted customer 404s and you lose 99 good rows. `allSettled` keeps them
  and gives up fail-fast.
- **The thundering herd on retry.** If all 100 hit a 429 at the same instant and back off by the
  same computed amount, they retry at the same instant. **Deterministic backoff re-clusters the
  burst**; jitter is the only thing that breaks it — and it matters more here than anywhere,
  precisely because the calls started together.
- **Duplicates.** 100 orders commonly reference far fewer distinct customers. Fetching the same
  id 4 times is 4× the quota for one answer, and the fix — collapse in-flight duplicates — is
  not something most clients offer.

And the meta-point: the best fix is often **not to fan out at all**. One team cut 20k calls/day
to 800 by using a batch endpoint. A client library can't invent one, but it should not make the
fan-out so easy that nobody looks.

## Evidence this bites real projects

- **Concurrency vs rate** — [Truto on rate limits across third-party APIs](https://truto.one/blog/best-practices-for-handling-api-rate-limits-and-retries-across-multiple-third-party-apis/)
  notes governance is often concurrency-based, and that a burst of parallel calls throttled
  together will **re-cluster under deterministic backoff** unless there's full jitter.
- **`Promise.all` discards successes** — the standard warning
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all),
  [Beware of Promise.all](https://dev.to/jdorn/beware-of-promiseall-3pph),
  [better handling with allSettled](https://www.coreycleary.me/better-handling-of-rejections-using-promise-allsettled)).
- **Concurrency control is a library** — `p-limit`, `Bottleneck` — because the platform doesn't
  offer one.
- **Batching beats fanning out** — [the 20k → 800 calls/day case](https://truto.one/blog/best-practices-for-handling-api-rate-limits-and-retries-across-multiple-third-party-apis/).

## The common solutions, and what each costs

| Approach                                      | What it is                                   | Where it breaks                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Promise.all(ids.map(fetch))`**             | The one-liner everyone writes.               | Unbounded concurrency, and one failure discards every success.                                                                                        |
| **`Promise.allSettled` + a pool** (`p-limit`) | Bounded, keeps partial results.              | Correct, and it is two dependencies and a hand-rolled join.                                                                                           |
| **Sequential loop**                           | One at a time.                               | Safe, and N× the latency.                                                                                                                             |
| **A batch endpoint**                          | `GET /customers?ids=…`.                      | Strictly best where offered — and then you inherit [partial-failure semantics](batch-partial-failure.md).                                             |
| **Cache / dedupe by id**                      | Don't fetch the same id twice.               | Free quota, and only if in-flight duplicates collapse too — a cache that only helps _after_ a response lands does nothing for a simultaneous fan-out. |
| **Prefetch / expand**                         | Ask the list endpoint to embed the customer. | The real fix where the vendor supports `?expand=`. Rarely does.                                                                                       |

**Summary of the state of the art:** bound the concurrency, keep partial results, jitter the
backoff, collapse duplicate ids, and check whether a batch endpoint exists before writing any of
it.

---

## What to verify against StitchAPI

Two earlier scenarios bear directly on this. [Scenario 7](multipart-upload.md) measured `all()`
**bounding nothing** (peak 8 over 8 members) and handing **every member the same
`StitchInput`** — which, if it holds, means `all()` structurally _cannot_ express this scenario,
where every call needs a different id. [Scenario 10](provider-failover.md) measured the same
input-broadcast on `any`/`race`, and that `Composable` is not user-authorable.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **The combinators are out.** N is a runtime length and the inputs differ, so this is
  `Promise.all(ids.map(…))` territory. The question is what the library contributes _around_
  each call.
- **`throttle: { concurrency }` on the per-item stitch is the pool.** Scenario 9 measured
  `pool: 'stitch'` giving one stitch its own budget — which is exactly right when the same stitch
  is called N times, and exactly wrong if someone builds N stitches.
- **`cache.coalesce` is the untested capability that matters most here.** It is documented as
  `'process' | 'cluster' | false`, and in-flight coalescing is precisely the duplicate-fan-out
  fix: 100 concurrent calls for 30 distinct ids should make 30 requests. Nothing in the pass has
  exercised it.
- **`backoff: 'expo-jitter'` is the default**, which is the right default for this shape. Whether
  it actually de-clusters a simultaneous burst — and how badly `'expo'` or `'fixed'` re-clusters
  — is measurable.

**Claims to test with runnable offline code:**

1. **C1** — confirm the combinators can't do it: a runtime-length list of _different_ inputs.
   Measure what `all()` actually sends.
2. **C2** — **DECIDING CLAIM.** `cache.coalesce`: 100 concurrent calls across 30 distinct ids.
   How many requests reach the server? Does it collapse **in-flight** duplicates, or only serve
   from a completed cache?
3. **C3** — bounded concurrency via `throttle: { concurrency }` on one stitch called N times.
   Measure the peak in-flight. Then the trap: N _separate_ stitches.
4. **C4** — partial failure. One id 404s. With `.safe()` per member, do the other 99 survive, and
   is the failing id identifiable?
5. **C5** — **the thundering herd.** 100 calls 429 simultaneously. Measure the retry arrival
   spread under `'expo-jitter'` vs `'expo'` vs `'fixed'`. Does the default actually de-cluster?
6. **C6** — the trace. Is a 100-call fan-out one tree or 100 unrelated roots? Does `linked` help
   when the members are created at runtime?
7. **C7** — ordering and joining: does the result order match the input order under concurrency?
8. **C8** — assemble the best available answer, run it, report the seam and line count against
   `Promise.allSettled` + `p-limit`.

C2 is the one that could make this scenario a genuine win: in-flight coalescing is a real
capability, most clients don't have it, and it is exactly the fix this shape needs.
