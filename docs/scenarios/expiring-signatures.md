# Scenario: the signature that expired in your own queue

**Researched:** 2026-08-05 · **Status:** VERIFIED — **ACHIEVABLE** (the first outright) · page shipped
**Slug:** `expiring-signatures`

**Verification:** 8 proof scripts (105 checks), run offline, stable across 24 runs, in
[`proofs/expiring-signatures/`](proofs/expiring-signatures/). Published page:
[`scenarios/expiring-signatures.mdx`](../../apps/docs/content/docs/scenarios/expiring-signatures.mdx).
Escalated: [`issue-drafts/sigv4-ignores-the-injected-clock.md`](issue-drafts/sigv4-ignores-the-injected-clock.md).

| Claim                             | Verdict                                   | Measured                                                                                                                                                    |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — signed per attempt?          | **per attempt**                           | 3 attempts 6 min apart → 3 distinct signatures, ages `[0,0,0]` ms; a 10-min `Retry-After` park still arrived fresh. Signed-once control: 6 min old, **403** |
| C2 — wait before or after signing | **BEFORE — the deciding claim, positive** | 4 calls behind `rate: '1/2m'` → ages `[0,0,0,0]`, all `200`. Pre-signed control: `[0,2,4,6]` min and a **403**                                              |
| C3 — concurrency                  | same                                      | held 6 min behind `concurrency: 1` → **0 ms**                                                                                                               |
| C4 — circuit cooldown             | breaker queues nothing                    | 3 blocked calls → **0 signings**; half-open trial signed fresh                                                                                              |
| C5 — injected clock?              | **library loses**                         | 600 virtual seconds moved the stamp **0 s**; under a default `manualClock()`, **0 of 3** accepted                                                           |
| C6 — skew 403                     | not retried (good); classification fails  | 1 request at `attempts: 4`. But it **counts as a circuit failure**, and `verdict: {accept, flag}` **swallows** it                                           |
| C7 — skew correction              | reachable                                 | `shouldRefresh`/`refresh` learned **600,000 ms** from the `Date` header and re-signed the same attempt to `200`, costing no retry budget                    |
| C8 — assembled                    | PASS                                      | **4 of 4** through 10-min drift + 6-min queue + breaker, worst age **0 ms**; 26 lines, all for the drift half                                               |

**The first scenario in the pass to come out ACHIEVABLE outright for its deciding claim**, and
the reason is structural: `acquireWithin` (`engine.ts:629`) sits above `cfg.auth.apply` (`:649`)
inside the attempt loop, and `cloneReq` gives each attempt fresh headers off the _unsigned_
base. **A StitchAPI throttle cannot expire a signature** — botocore#149 is unreachable here.

**The capture's hypotheses held**, which is also a first. What it did not anticipate is the
inverse footgun: `hooks.onRequest` runs _after_ signing (`:652`), so a hand-rolled pacing gate
there **re-creates the bug inside a library that doesn't have it** — measured, a 6-minute wait
in `onRequest` aged the signature 6 minutes and got a 403.

---

## The use case

You call a service that requires **signed requests** — S3 or any AWS API via SigV4, or any
vendor whose auth embeds a timestamp. The signature covers the clock, and the server rejects
anything more than **five minutes** from its own time. That window exists to stop replay
attacks, and it is not negotiable.

## Why it is not straightforward

There are three separate ways to fall outside the window, and only one of them is your clock.

**1. The clock drifts.** Containers inherit the host's time at start and do **not** re-sync
after. A drifting host, a VM resumed from suspend, a laptop out of NTP — and every request
fails with `RequestTimeTooSkewed`. **Retry makes it worse, not better**: the same stale clock
produces the same invalid timestamp on every attempt, so a retry policy burns the budget and
fails identically. AWS's own SDKs have shipped bugs here —
[`aws-sdk-net#3463`](https://github.com/aws/aws-sdk-net/issues/3463), "clock skew correction
causes repeated retries."

**2. The signature ages in a queue — yours.** This is the sharp one, and it has nothing to do
with your clock being wrong. Sign the request, then hold it: behind a rate limiter, behind a
concurrency cap, behind a retry backoff. The timestamp was minted at _sign_ time and the
request reaches the wire minutes later. As one AWS answer puts it plainly: _"The SDK signs the
request, and then puts the request in a queue. If the queue becomes too large and the request is
pending for more than 5 minutes, then the signature expires."_ The fix filed against botocore
([`#149`](https://github.com/boto/botocore/issues/149)) is exactly this: generate the timestamp
**per signing operation**, not once at construction.

**3. The retry replays a stale signature.** If signing happens once per _call_ rather than once
per _attempt_, then attempt 2 carries attempt 1's timestamp plus however long the backoff was.
A long backoff — or a circuit-breaker cooldown — guarantees the replay is stale.

The compounding detail: **a skew failure looks transient.** `RequestTimeTooSkewed` is a 403,
and the natural reading is "auth problem, retry it." So the failure mode most likely to be
retried is the one retry cannot fix.

## Evidence this bites real projects

- **`aws-sdk-net#3463`** — [clock skew correction causes repeated retries](https://github.com/aws/aws-sdk-net/issues/3463).
- **`botocore#149`** — the cached-signature-timestamp bug, whose fix is to regenerate the
  timestamp per signing operation.
- **Lambda "Signature expired"** — [AWS's own knowledge-centre article](https://repost.aws/knowledge-center/lambda-sdk-signature)
  names the sign-then-queue case directly.
- **Containers** — [signature expired when running from Docker](https://www.w3tutorials.net/blog/aws-invalidsignatureexception-signature-expired-when-running-from-docker-container/)
  and [RequestTimeTooSkewed: the S3 error that brings teams to a halt](https://www.tech-reader.blog/2025/09/requesttimetooskewed-s3-error-that.html).
- **AWS's clock-skew-correction blog** documents the mitigation SDKs implement: learn the offset
  from the server's `Date` header on a skew error, then re-sign with the corrected clock.

## The common solutions, and what each costs

| Approach                            | What it is                                                           | Where it breaks                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fix the clock (NTP/chrony)**      | Keep the host in sync.                                               | The correct root fix, and it is infrastructure — not something a client library can do, and not available in every environment.                 |
| **Sign per attempt**                | Re-sign on every retry rather than once per call.                    | Necessary and cheap. Easy to get wrong by hoisting the signing above the retry loop.                                                            |
| **Sign after the wait, not before** | Move signing below the throttle/concurrency queue.                   | The fix for case 2, and it requires the signing hook to run at the _last_ moment before the wire.                                               |
| **Clock-skew correction**           | Read the server's `Date` on a skew error, store the offset, re-sign. | What the AWS SDKs do. Needs somewhere to persist the offset and a way to feed it back into signing.                                             |
| **Don't retry a skew error**        | Classify 403-skew as terminal.                                       | Correct, and the opposite of the natural reading — this is the "classify before routing" lesson from [provider failover](provider-failover.md). |
| **Widen the window**                | Ask the vendor for longer validity.                                  | Not on offer. Five minutes is a security property.                                                                                              |

**Summary of the state of the art:** sign as late as possible, sign again on every attempt,
don't retry a skew error blindly, and correct from the server's clock when it tells you.

---

## What to verify against StitchAPI

This scenario pulls on a thread three earlier ones brushed. Scenario 6 measured
`Surface.buildRequest` running **once per run** while `hooks.onRequest` runs **once per
attempt**, and located `cfg.auth.apply` at `engine.ts:649` — _inside_ the attempt loop. So
per-attempt signing looks likely. The untested part is **where the throttle wait sits relative
to it**.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **`@stitchapi/aws-sigv4` is the one package this pass hasn't touched.** It signs outbound
  requests and was measured in [scenario 8](webhook-receipt.md) producing an
  `AWS4-HMAC-SHA256` header with a key imported `usages: ['sign']`.
- **The sharp question is ordering.** If the throttle's wait happens _before_ `auth.apply`, the
  library is already correct for case 2 and that is worth saying loudly. If it happens _after_,
  a stitch with `throttle: { rate: '1/s' }` and a queue signs at t=0 and arrives minutes later.
- **Does signing use the injected `clock`?** Scenarios 4 and 6 found `timeout.total` and
  `cache.ttl` reading `Date.now()` while their neighbours use `clock`. If SigV4 does the same,
  clock skew is untestable on a virtual clock — and it would be the **third** instance of one
  inconsistency.
- **Nothing in the config vocabulary suggests skew correction**, so the "learn the offset from
  the server's `Date`" mitigation is presumably user code — the question is whether there is a
  seam that can reach the signing input at all.

**Claims to test with runnable offline code:**

1. **C1** — is the request signed **per attempt** or once per call? Capture the timestamp on the
   wire across a retry with a long backoff. If attempt 2 carries attempt 1's timestamp, that is
   the finding.
2. **C2** — **DECIDING CLAIM.** Does the throttle wait happen **before or after** signing?
   Configure `throttle: { rate }` so a call queues for a long virtual interval, and measure the
   age of the signature when it reaches the adapter.
3. **C3** — same question for `throttle: { concurrency }` — a request held behind a busy pool.
4. **C4** — does the circuit breaker's half-open delay interact the same way?
5. **C5** — does SigV4 signing read the **injected clock** or `Date.now()`? Advance a
   `manualClock` and check whether the signature's timestamp moves.
6. **C6** — a `RequestTimeTooSkewed` 403: is it retried by default? Can it be classified as
   terminal without swallowing it? (Scenario 9 measured `verdict: { accept, flag }` doing this
   for a 401.)
7. **C7** — clock-skew correction: is there any seam that can read the server's `Date` on a
   failure and feed a corrected clock back into signing for the next attempt?
8. **C8** — assemble the best available answer, run it, report the seam and line count.

C2 decides this one. Signing before a wait you control is a bug the client can fix; signing
after it is a property worth advertising.
