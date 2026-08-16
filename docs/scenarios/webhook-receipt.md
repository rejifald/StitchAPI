# Scenario: receiving a signed webhook

**Researched:** 2026-08-05 · **Status:** VERIFIED — **split: receipt out of scope by design, reaction in scope** · page shipped
**Slug:** `webhook-receipt`

**Verification:** 7 proof scripts, run offline against a real local `node:http` server, in
[`proofs/webhook-receipt/`](proofs/webhook-receipt/). Published page:
[`scenarios/webhook-receipt.mdx`](../../apps/docs/content/docs/scenarios/webhook-receipt.mdx).
Escalated: [`issue-drafts/void-call-drops-work.md`](issue-drafts/void-call-drops-work.md).

| Claim                               | Verdict          | Measured                                                                                                                                                              |
| ----------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — raw bytes at an arbitrary path | **out of scope** | 404 at all 5 paths; body pre-`JSON.parse`d; **inbound headers dropped entirely**; 162 signed bytes vs 153 after a round-trip                                          |
| C2 — inbound signature primitive    | **none**         | 72 runtime exports enumerated; the 4 matches are BYO conformance suites; `aws-sigv4` key has `usages: ['sign']`                                                       |
| C3 — a seam on the serve path       | **none**         | `serve` exports 3 things; an **unsigned forged body ran the stitch, 200**; `createServeHandler` mounts anywhere but reading the stream to verify deadlocks `readBody` |
| C4 — fetch-on-receipt               | partly           | payload order moot (converged, 2 calls / 2 events); **write order is not** (concurrent v2/v3 landed on v2); `.deleted` → 404, indistinguishable from never-existed    |
| C5 — `StitchStore` as dedup ledger  | PASS             | 3 deliveries → 1 side effect; `get`+`set` under concurrency → **[true,true,true]**, `increment` → **[true,false,false]**                                              |
| C6 — fast 2xx                       | **no**           | no queue/detach stage; `serve` acked only at attempt 3 after **exactly 10 virtual seconds**; `void call(input)` → **0 HTTP calls, 0 errors**                          |
| C7 — the boundary as a number       | PASS             | receipt **154 lines, zero `stitchapi` runtime imports**; reaction **63 lines**, mostly config                                                                         |

**The capture's framing held, which is a first — but three things it missed matter.** It
predicted `serve` wouldn't work and asked for the boundary to be stated precisely. Right. What
it did not anticipate:

- **The inbound headers are dropped**, not just the raw bytes. Even with the bytes there is no
  `stripe-signature` to verify against — the gap is wider than "body already parsed".
- **`serve` is unauthenticated**, so mistaking it for a webhook endpoint isn't a 404, it's an
  open endpoint that runs your stitches on a forged body.
- **Fetch-on-receipt fixes payload order but not write order.** The capture treated it as the
  clean answer to ordering; concurrent handlers still need a version guard.

**The honest shape: 71% of the code by line, 100% by concern, is the half StitchAPI does not
participate in** — and that is by design. [`the-stitch.mdx:44`](../../apps/docs/content/docs/concepts/the-stitch.mdx)
already states it: inbound webhooks stay the application's job. This scenario's value is making
that boundary concrete and measured rather than asserted.

---

## The use case

Stripe, GitHub, Slack, Shopify — they all push events to an endpoint you host. A payment
succeeded; a PR opened; a subscription changed. You verify the signature, decide it's genuine,
and act on it.

This is the other direction from every other scenario in this section: **someone is calling
you.**

## Why it is not straightforward

**Signature verification needs the exact bytes.** The provider signs the raw payload. If any
middleware parses the JSON before you get to it, re-stringifying gives _logically identical_
JSON with different bytes — whitespace and key order shift — and verification fails. In Express
this is the notorious `express.raw()`-must-precede-`express.json()` ordering rule, and it is the
single most-reported webhook bug there is.

Then the delivery semantics:

- **At-least-once means duplicates are normal, not exceptional.** The sender can't distinguish
  "you didn't process it" from "you did and the ack was lost", so it retries. Your handler must
  be idempotent, keyed on the event id.
- **The dedup TTL must exceed the retry window.** Stripe retries for up to 3 days; a 1-hour
  dedup cache is a duplicate waiting to happen. That means durable storage, not memory.
- **Order cannot be trusted.** `subscription.updated` can arrive before `subscription.created`.
  The standard fix is to treat the webhook as a _hint_ and fetch current state from the API —
  which turns an inbound problem into an outbound call.
- **Replay windows.** Stripe's signature header carries a timestamp; you reject deliveries
  outside a tolerance (5 minutes by default) so a captured payload can't be replayed later.
- **Comparison must be constant-time**, or the HMAC check leaks via timing.
- **You must return 2xx fast.** Providers time out in seconds and retry on slowness, so any
  real work has to be queued rather than done inline — which _creates_ the duplicate problem
  you just solved, one layer down.

## Evidence this bites real projects

- **Stripe's own docs** have a page dedicated to it — [resolve webhook signature verification
  errors](https://docs.stripe.com/webhooks/signature) — and the raw-body rule is its headline.
- The failure is common enough to have a genre of writeups:
  [why yours keep failing](https://medium.com/@amanjaved421/why-your-stripe-webhooks-keep-failing-verification-in-n8n-a6eb53b4584b),
  ["are you passing the raw request body?"](https://sukhadagholb.medium.com/webhook-signature-verification-for-stripe-are-you-passing-raw-request-body-received-from-stripe-3b2deed6a75d),
  and [the payload must be a string or Buffer](https://dev.to/nerdincode/debugging-stripe-webhooks-in-nodejs-the-payload-must-be-a-string-or-buffer-error-4a60).
- **Delivery semantics** are documented consistently across providers and infrastructure
  vendors — [Svix on idempotency and deduplication](https://www.svix.com/resources/webhook-university/reliability/idempotency-and-deduplication/),
  [Hookdeck](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency),
  [Postmark on why idempotency matters](https://postmarkapp.com/blog/why-idempotency-is-important) —
  all making the same two points: duplicates are guaranteed, and order is not.

## The common solutions, and what each costs

| Approach                                                     | What it is                                                    | Where it breaks                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Provider SDK verifier** (`stripe.webhooks.constructEvent`) | The vendor hands you a verifier.                              | Correct, and the right answer for that vendor. One per provider, each with its own header format and tolerance.                                  |
| **Framework raw-body middleware**                            | `express.raw()` scoped to the webhook route.                  | The standard fix, and entirely about _ordering_ — get it wrong and it fails silently in the direction of "invalid signature".                    |
| **Hand-rolled HMAC**                                         | `createHmac` + `timingSafeEqual`.                             | Fine, and easy to get subtly wrong: constant-time comparison, the timestamp tolerance, and the exact string being signed all matter.             |
| **Webhook gateway** (Svix, Hookdeck)                         | Offload receipt, dedup, retry and replay.                     | The most complete answer at scale. A third party in the path, and a bill.                                                                        |
| **Dedup on the event id**                                    | Store ids, skip repeats.                                      | Necessary, and the TTL is the trap — it must outlive the provider's retry window.                                                                |
| **Fetch-on-receipt**                                         | Treat the payload as a hint; read current state from the API. | Makes ordering irrelevant and is widely recommended. Costs an API call per event, and that call needs its own auth, retry and rate-limit budget. |

**Summary of the state of the art:** verify raw bytes in constant time inside a timestamp
window, dedup on the event id with a TTL longer than the retry window, ack fast, and fetch
current state rather than trusting payload order.

---

## What to verify against StitchAPI

This is the first scenario where the honest answer may be **"that's not what this library is"** —
and if so, the useful output is a documented boundary, not a stretched workaround.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **`serve` is not a webhook receiver.** It exposes _your_ registry over a thin front door:
  `GET /` lists stitch names, `POST /stitch/:name` runs one with the JSON body as its **input**
  (`serve.ts:206,283`). Fixed routes, JSON-parsed body — the opposite of "hand me the raw bytes
  at my own path". If that holds, the receipt half is out of scope by construction.
- **No HMAC verification primitive exists in core.** The only signing code in the repo is
  `@stitchapi/aws-sigv4`, which signs **outbound** requests. Nothing verifies an inbound one.
- **The half that _is_ StitchAPI's job** is the reaction: fetch-on-receipt is an outbound call,
  and it is the recommended fix for out-of-order delivery. `StitchStore` is also exactly the
  shape a dedup ledger needs (`get`/`set` with TTL, pluggable, durable) — though scenario 4
  measured that the store is engine state, so whether a user can borrow it cleanly is open.
- `idempotency` exists but is for outbound writes — a different problem wearing the same word.

**Claims to test with runnable offline code:**

1. **C1** — can `serve` receive a POST at an arbitrary path with the **raw body bytes**
   preserved? Measure what a handler actually gets. If the body is JSON-parsed before any user
   code, say so and show the byte difference that breaks a signature.
2. **C2** — is there **any** inbound-signature primitive in the packages? Grep exhaustively.
3. **C3** — can a signature be verified at all through `serve` — e.g. by a surface, a hook, or
   the `ServeBodyOptions` seam? Or must the user bring their own server?
4. **C4** — the reaction half: does fetch-on-receipt work well as a stitch, and does it actually
   make out-of-order delivery moot? Model two events arriving reversed and show the outcome
   with and without the fetch.
5. **C5** — can `StitchStore` serve as the dedup ledger — durable, TTL beyond the retry window,
   usable from user code? Measure a duplicate delivery being skipped, and what happens at the
   TTL boundary.
6. **C6** — does anything in the library help with the fast-2xx requirement (ack now, work
   later)?
7. **C7** — assemble the most honest end-to-end answer: a real Node server for receipt, plus
   StitchAPI for everything after it. Report which half is which, and the line count of each.

The deliverable here is the **boundary**, stated precisely. If receipt is out of scope, the page
should say that plainly and point at what to use instead — that is more useful than a clever
workaround that makes a client library pretend to be a server.
