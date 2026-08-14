# Scenario: failing over to the backup provider

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `provider-failover`

**Verification:** 8 proof scripts, run offline (165 checks), in
[`proofs/provider-failover/`](proofs/provider-failover/). Published page:
[`scenarios/provider-failover.mdx`](../../apps/docs/content/docs/scenarios/provider-failover.mdx).
Escalated: [`issue-drafts/any-is-priced-as-a-hedge.md`](issue-drafts/any-is-priced-as-a-hedge.md).

| Claim                                | Verdict                                     | Measured                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — does `any` call both on success | **confirmed, worse than predicted**         | 10 successful primary calls → `[10, 10]`, **20 requests for 10 answers**; loser **completed** (0 aborted); `any` has **no preferred member** — a 10 ms-slower healthy primary lost |
| C2 — sequential fallback             | expressible; capture wrong pessimistically  | `linked` + try/catch → `[10, 0]`, **one traceId** `primary ← root, backup ← primary`; bare try/catch → 2 unrelated root traces                                                     |
| C3 — classification                  | no built-in; aggregate worse than predicted | `AggregateError` has `status` **and** `body` `undefined`; the 400 survives only in `.errors[0]`. `race` _does_ surface a real 400 — and is unusable as failover                    |
| C4 — one input for every member      | shared, and it splits config/input          | declared auth stayed per-member; a **per-call `authorization` for the primary arrived at the backup verbatim**                                                                     |
| C5 — winner identity                 | not recoverable                             | result is the raw body; `pick` destroys attribution; group emits **0** events; a cancelled member emits nothing terminal                                                           |
| C6 — cancellation                    | cancelled ≠ free                            | loser's request always arrives; billed for the winner's latency; two equal providers → **80 for one answer, 0 saved**                                                              |
| C7 — hedging amplification           | unconditional                               | `race` **2.00×** healthy _and_ degraded; a breaker is a health gate not a budget gate; two `url`-only stitches shared one breaker                                                  |
| C8 — assembled                       | PASS                                        | `[10, 0]` healthy, 400 stops the chain, 503 fails over, one trace tree — **30 lines vs 104**                                                                                       |

**Hypotheses: the headline held, two were wrong.**

- C1's prediction was right and understated. The unpredicted parts: the loser **completes**
  (the abort is in a `finally` after the winner settles), and `any` prefers the _faster_ member,
  not the first — so it silently routes away from the provider you chose.
- "Sequential fallback may be the one shape the library doesn't offer" — **wrong
  pessimistically**. `linked` + try/catch is the correct default and carries the trace properly.
- The `AggregateError` guess was right about the loss and wrong about the scale: it drops
  `body` too, so _nothing_ a catch block routes on survives.

**The framing worth keeping:** the library carries ~71% of this scenario and **all of it is per
member** — auth, retry, breaker, timeout, normalisation, trace identity. Its contribution to the
routing _between_ members is zero, and the 30 lines that fill the gap cannot be given back:
`Composable` is not user-authorable, so a hand-branded node compiles and then throws.

---

## The use case

You depend on a provider that will eventually be down: an LLM API, an SMS gateway, a payment
processor, a geocoder. So you line up a second one of the same shape and fail over when the
first fails.

Two different techniques wear similar clothes:

- **Failover** — try the primary; on failure, try the backup. One call in the happy path.
- **Hedging** — send to _both_ immediately, take whichever answers first. Two calls, always,
  in exchange for a better tail latency.

Choosing the wrong one is a bill, not a bug report.

## Why it is not straightforward

**The trigger has to classify the failure, not just notice it.** The consensus is sharp and
consistent: `404`, `429` and `5xx` are _availability_ errors — try the next provider. A `400`
is a _bad request_ — stop the chain, because your payload is malformed and the next provider
will reject it identically. A failover that treats all failures alike turns one bad request
into N bad requests, N bills, and an aggregate error that hides the actionable one.

Then the shape-specific hazards:

- **Hedging amplifies outages.** When a backend degrades, _every_ request crosses the hedge
  threshold, so every request doubles — [doubling traffic to a backend that was already
  failing](https://blog.alexoglou.com/posts/hedging/). Hedging is only safe coupled to a
  circuit breaker.
- **Hedging requires idempotency.** Two in-flight copies of a non-idempotent write is two
  writes. Cancelling the loser is a latency optimisation, not a correctness one — the request
  may already have landed.
- **Cancelling doesn't refund.** With an LLM, a cancelled request is still billed for the
  tokens generated before the cancel. "The loser is auto-cancelled" saves latency and not money.
- **The providers aren't actually interchangeable.** Different auth, different rate limits,
  different response shapes, different error vocabularies — so each leg needs its own config,
  and the results need normalising before the caller sees them.
- **You need to know who served it.** Cost attribution and telemetry both need the winning
  provider's identity, and a combinator that returns "the value" tends to lose it.

## Evidence this bites real projects

- **The classification rule** is stated the same way across the ecosystem —
  [Bifrost](https://dev.to/kuldeep_paul/adaptive-model-routing-and-fallback-logic-routing-around-llm-provider-outages-with-bifrost-4g3m),
  [MixRoute](https://mixroute.ai/blog/handle-llm-api-failures/),
  [Portkey](https://portkey.ai/blog/failover-routing-strategies-for-llms-in-production/):
  availability errors fail over, a `400` must stop the chain.
- **Provider identity on the response** is called out as essential for cost attribution — you
  cannot bill or debug what you cannot attribute.
- **Hedging's outage amplification** is the standard warning in every write-up on it
  ([Costa](https://blog.alexoglou.com/posts/hedging/),
  [OneUptime on Envoy](https://oneuptime.com/blog/post/2026-02-09-envoy-request-hedging/view)),
  along with "hedge only idempotent operations".
- **A whole product category exists for this** — OpenRouter, Portkey, Bifrost — which is itself
  the evidence that rolling it yourself is not a one-liner.

## The common solutions, and what each costs

| Approach                                   | What it is                                   | Where it breaks                                                                                                 |
| ------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Sequential fallback**                    | `try A; catch { try B }`.                    | The correct default: one call in the happy path. Adds the primary's full timeout to the failure path's latency. |
| **Concurrent "first success"**             | Fire both, take the first that works.        | Best latency and **double spend on every call** — including the 99% that didn't need it.                        |
| **Hedge after a delay**                    | Fire the backup only if the primary is slow. | The nuanced answer. Needs a threshold, and amplifies an outage exactly when you can least afford it.            |
| **Gateway / router** (OpenRouter, Portkey) | Someone else owns the routing.               | Complete, and a third party in the path plus a bill.                                                            |
| **Retry, not failover**                    | Just retry the primary harder.               | Right for a `429` or a blip; useless when the provider is genuinely down.                                       |
| **Classify then route**                    | Availability errors fail over, `400`s stop.  | What everyone converges on, and the part hand-rolled failover usually skips.                                    |

**Summary of the state of the art:** classify the error before routing, prefer sequential
fallback unless latency genuinely justifies hedging, hedge only idempotent calls, couple
hedging to a breaker, and record which provider served the request.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **`any()` is documented as failover but implemented as concurrent.** Its docstring
  (`pipe.ts:275-281`) says _"failover across interchangeable sources… a primary and a mirror,
  two regions, two providers"_ — the vocabulary of fallback — while the first line says **"Run
  nodes CONCURRENTLY."** If that holds, using `any` for provider failover calls **both**
  providers on **every** call. For an LLM that is double spend on the happy path, and the
  documented auto-cancellation does not help, because tokens already generated are billed
  (established in [scenario 5](mid-stream-failure.md)).
- **`race()` is the hedge** — first to settle, winner or loser (`pipe.ts:296-300`).
- **Neither classifies.** `any` "waits past failures for a success", so a `400` from the primary
  makes it wait for the backup's `400` too, and surfaces an `AggregateError` rather than the
  actionable bad-request error.
- **There is no sequential-fallback combinator.** `all`/`any`/`race` are all concurrent;
  `linked` is sequential but is a scope for plain `await`s, not a fallback. So the correct
  default may be the one shape the library doesn't offer.
- Scenario 7 measured that `all()` hands **every member the same input** and bounds nothing —
  worth checking whether `any`/`race` share that.
- Scenario 9 measured the circuit breaker is shared by default — which matters here, since
  hedging is only safe with a breaker.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Does `any()` call every member on a **successful** primary?
   Measure requests reaching each provider on a happy path. If both are called, that is the
   cost finding.
2. **C2** — sequential fallback: is it expressible at all? Try `linked`, plain `try/catch`,
   `any` with a delayed member. Measure calls to the backup when the primary succeeds.
3. **C3** — classification: can failover be made to trigger on `429`/`5xx` but **not** `400`?
   Measure what the caller receives for a `400` — the actionable error, or an aggregate?
4. **C4** — do `any`/`race` share `all()`'s one-input-for-every-member behaviour? Two providers
   with different auth and different paths is the normal case.
5. **C5** — is the winner's identity recoverable? Cost attribution needs it.
6. **C6** — cancellation: is the loser actually cancelled, and does the cancelled request still
   reach the provider? (It will — the question is what the proof measures at the server.)
7. **C7** — hedging safety: does `race` amplify against a degraded backend, and can a breaker
   be scoped to just the hedge?
8. **C8** — assemble the best available answer for "primary with a backup", run it, report the
   seam and line count.

C1 decides whether the docstring's framing is safe. "Failover" that costs double on every
successful call is a materially different product from what the word implies.
