# Scenario: the charge you can't confirm

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `unconfirmed-write`

**Verification:** 8 proof scripts (120 checks), run offline against a fake vendor that owns a
charge ledger, so every number below is counted rather than inferred. In
[`proofs/unconfirmed-write/`](proofs/unconfirmed-write/). Published page:
[`scenarios/unconfirmed-write.mdx`](../../apps/docs/content/docs/scenarios/unconfirmed-write.mdx).
Escalated: [`issue-drafts/idempotency-default-is-not-restart-safe.md`](issue-drafts/idempotency-default-is-not-restart-safe.md).

| Claim                           | Verdict                                | Measured                                                                                                                  |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C1 — same key every attempt     | **PASS, in the library's favour**      | 3 attempts → 1 key, 1 charge; a response lost _after_ processing was **recovered** by the retry replaying the stored 200  |
| C2 — default key restart-stable | **FAIL — deciding, capture confirmed** | re-driven job → **2 keys, 2 charges for 1 intended**; `keyOf` → 1 and 1                                                   |
| C3 — derived key stability      | PASS with a sharp caveat               | `JSON.stringify(body)` moved on **key order alone** → 2 charges, statuses `[200,200,200]`, **no 409**                     |
| C4 — cached failure             | **capture REFUTED**                    | a stored 500 is **not** retried by default — 1 request under `attempts: 4`                                                |
| C5 — key/body mismatch          | PASS                                   | 409 not retried, `idempotency_key_in_use` on `error.body`; but `verdict: {accept, flag}` swallows it                      |
| C6 — TTL expiry                 | **FAIL**                               | 25 h vs a 24 h TTL → **2 charges**, clean `200`, **no replay marker**, no client-side signal                              |
| C7 — timeout ambiguity          | **FAIL**                               | dropped request (0 charges) and lost response (1 charge) → **field-for-field identical** errors; no event carries the key |
| C8 — assembled                  | PASS                                   | **5 charges / 6 intended** (sixth declined) vs the default's **8 / 6** with two duplicates                                |

**The capture's central worry was right, and one hypothesis was wrong in the library's favour.**
The default key is `randomUUID()` per call (`engine.ts:172`, inside `buildRequest` at `:257`), so
a queue re-driving a job mints a new key and charges again. But the cached-500 burn the capture
also feared does **not** happen — 500 isn't in the default `retry.on`.

**The sharpest detail is in the guard, not the gap.** `stitch.ts:386` warns only when there is a
random key **and no `retry`** — the reasoning being that a random key does protect the retries
inside one call, which is true. The effect is that following the warning's own advice ("add
`retry`") silences it, while leaving the restart case open. The message's own wording — "only
dedupes its own retries" — is accurate and is exactly the limitation, so the fix may be a
re-wording rather than a behaviour change.

**And a genuinely subtle one neither side anticipated:** a _stable_ key makes a recorded failure
**sticky** for the whole TTL — a declined card stayed declined — while the random key never
reaches the record and simply charges again. Both are defensible; nothing selects between them.

---

## The use case

You POST a charge. The connection times out. **You have no idea whether the money moved.**

Retry and you may double-charge. Don't, and the customer may have paid for nothing. There is
no third option that involves guessing.

## Why it is not straightforward

**A timeout tells you nothing about the server.** It does not distinguish "the request never
arrived" from "it was processed and the response was lost". That is the whole problem, and no
amount of client-side care removes it — you can only make the _retry_ safe.

Idempotency keys do that, and then bring their own edges:

- **The replay returns the _original_ outcome, including a failure.** Stripe stores the status
  and body of the first request for a key _whether it succeeded or failed_, so a retry after a
  cached `500` returns that same `500` forever. A retry policy that keeps trying is burning
  attempts against a recording.
- **The key has a TTL, and it is shorter than your job queue.** Stripe prunes after ~24 hours
  and then treats the key as fresh. _"If a client retries 25 hours later because of a delayed
  job, a 1-hour TTL means they get double-charged."_
- **The same key with a different body is an error.** Stripe compares the parameters and rejects
  a mismatch. So a payload rebuilt with anything volatile — a timestamp, a re-serialised map
  with different key order — turns a safe retry into a hard failure. `stripe-ruby#431` exists
  because the client didn't handle the resulting `409`.
- **The key must survive the process, not just the call.** A key minted per call is retry-safe
  _within_ that call and useless if the process dies and a queue re-drives the job. The second
  run mints a new key, and the second key is a second charge.
- **Recovery has its own race.** "Query to see whether it landed" is the standard fallback, and
  between the query and the decision the original request can still land.

## Evidence this bites real projects

- **Stripe's own reference** — [idempotent requests](https://docs.stripe.com/api/idempotent_requests):
  the stored result is replayed _"regardless of whether it succeeds or fails"_, keys are pruned
  after ~24 hours, and a reused key after pruning generates a new request.
- **`stripe-ruby#431`** — ["Stripe.request does not retry on a 409 response"](https://github.com/stripe/stripe-ruby/issues/431):
  the client-side gap around key conflicts.
- **`medusajs#4798`** — [Stripe webhook processing fails with 409 Conflict](https://github.com/medusajs/medusa/issues/4798).
- **Brandur's [implementing Stripe-like idempotency keys](https://brandur.org/idempotency-keys)**
  is the canonical write-up of the server side, including the parameter-comparison rule.
- **The TTL trap** — a 25-hour retry against a 1-hour TTL double-charging — is called out
  explicitly in the practitioner guidance, along with the expiry race (two requests arriving as
  a key expires can both pass the existence check).

## The common solutions, and what each costs

| Approach                                           | What it is                                                           | Where it breaks                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry blindly**                                  | Treat a timeout like any failure.                                    | Double-charges. The failure mode the whole scenario exists to prevent.                                                                                                |
| **Never retry a write**                            | Surface the timeout to a human.                                      | Safe and expensive: every transient blip becomes a support ticket, and the customer still doesn't know if they paid.                                                  |
| **Idempotency key, minted per call**               | A uuid per logical call.                                             | Correct for retries inside the call; **useless across a restart**, which is exactly when a queue re-drives the job.                                                   |
| **Idempotency key derived from the business fact** | Hash the order id / invoice ref.                                     | The right answer — stable across processes, restarts and queues. Requires a genuinely unique business key, and colliding keys merge two different writes into one.    |
| **Query-then-decide**                              | On timeout, look for the record; create only if absent.              | The standard recovery, and racy: the original can land between the query and the decision. Needs the query to be authoritative and the create to still carry the key. |
| **Persist intent first**                           | Write "I am about to charge X" locally, then charge, then mark done. | The durable answer, and now you own a two-phase workflow and its own recovery.                                                                                        |

**Summary of the state of the art:** derive the key from the business fact so it survives a
restart, keep the body byte-stable for that key, don't retry into a cached failure, and set the
TTL longer than your slowest retry path.

---

## What to verify against StitchAPI

The [`idempotent-writes` recipe](../../apps/docs/content/docs/recipes/idempotent-writes.mdx)
covers attaching a key. This scenario is about the cases where that isn't enough.
[Scenario 1](oauth2-refresh-token-rotation.md) noted in passing that the default key is _"a
random uuid generated once per call — already retry-safe"_, and `keyOf` derives a stable value
from the input. Retry-safe within a call is not the same as restart-safe.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **The default key is minted per call.** If so it survives a retry and _not_ a restart — and a
  queue re-driving a job is the single most likely way this scenario actually happens.
- **`keyOf` should be restart-stable**, being a pure function of the input. Worth confirming,
  including whether the _body_ it derives from is byte-stable (key order, number formatting).
- **The cached-failure interaction is untested.** If the vendor replays a stored `500`, does
  `retry` burn every attempt against it? `retry.on` includes 500 by default in some
  configurations, and scenario 14 measured a skew 403 being retried into the ground.
- Scenario 14 measured `auth.apply` runs per attempt and the throttle wait precedes it. The
  parallel question here: **is the idempotency header applied per attempt, and is it the same
  value each time?**

**Claims to test with runnable offline code:**

1. **C1** — is the same key sent on every attempt of one call? Measure the header across a retry.
2. **C2** — **DECIDING CLAIM.** Is the default key stable across a **process restart**? Build the
   same stitch twice with identical input and compare. If it differs, a re-driven job
   double-charges.
3. **C3** — is a `keyOf`-derived key restart-stable, and is it stable against **body
   re-serialisation** (key order, number formatting, an added timestamp)?
4. **C4** — the **cached failure**: the vendor replays a stored `500` for the key. Does `retry`
   burn all attempts against it? Can that be distinguished from a fresh `500`?
5. **C5** — the **key/body mismatch**: same key, changed body → the vendor's `409`/`422`. Is it
   retried (it must not be), and does the caller get something actionable?
6. **C6** — the **TTL expiry**: a retry after the key is pruned creates a second charge. Is there
   anything client-side that could notice — and can a `keyOf` key be made to encode the intent so
   the second charge is at least detectable?
7. **C7** — the **timeout itself**: can the caller distinguish "never sent" from "sent, outcome
   unknown"? What do `attempts`, the error, and the event stream carry?
8. **C8** — assemble the safest available answer: derived key, no retry into a cached failure,
   and a recovery path. Report the seam and line count.

C2 decides this one. A key that doesn't survive a restart protects against the failure mode you
can see and not the one that costs money.
