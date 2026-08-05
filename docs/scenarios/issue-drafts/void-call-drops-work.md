# Issue draft — `void call(input)` silently drops the work, and `backoff.base` is clamped without warning

**Status:** ✅ **FILED** as [#660](https://github.com/rejifald/StitchAPI/issues/660)
**Scenario:** [`webhook-receipt`](../webhook-receipt.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `dx`, `footgun`

> The scenario itself resolved cleanly as a **documented boundary** — inbound receipt is out of
> scope by design, and [the-stitch.mdx:44](../../apps/docs/content/docs/concepts/the-stitch.mdx)
> already says so. These two findings are independent of that and apply to any stitch.

Reproduce:

```bash
for f in docs/scenarios/proofs/webhook-receipt/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `void call(input)` makes no request and reports nothing

**Severity: high — silent data loss, and the spelling is the idiomatic one.**

A stitch call is a **lazy thenable**: the run starts on `.then` (`stitch.ts:729,781`). So the
natural fire-and-forget spelling does nothing at all.

Measured: `void call(input)` produced **0 HTTP calls and 0 errors**. No request, no event, no
rejection, no trace — the call simply never happened.

This matters most in exactly the place people write it. In a webhook handler the shape is "ack
the provider fast, do the work after", so `void call(input)` goes in right after
`res.writeHead(200)` — and the work is dropped _after_ the sender has been told it succeeded.
The provider will not retry, because you said 200.

Adjacent behaviours measured alongside:

- `void call(input).then(…)` **does** run it (1 call), and is then unsupervised: unhandled, it
  surfaced as **1 `unhandledRejection`**.
- `call.safe()` in that position produced **0 rejections** and reported the failure **nowhere** —
  no throw, no event, no sink.

**Ask:** the lazy thenable is a deliberate and defensible design (it is what lets `.stream()`,
`.safe()` and `.inspect()` branch off one expression), so the fix is probably not to make it
eager. But _something_ should mark the discard:

- a lint rule or a `no-floating-stitch`-style type trick, or
- a `.detach()` / `.start()` that makes "run it and don't await" explicit and supervised, or
- at minimum, a prominent line in the pitfalls page. `void x()` is a well-known idiom for
  "deliberately not awaiting"; here it means "deliberately not running", which is the opposite.

## 2. `backoff.base` is silently clamped by `backoff.max`

**Severity: low — but it is a silent policy downgrade, and the third of its kind in this pass.**

`backoff: { base: 30_000 }` measured an actual sleep of **10,000 ms** — `max` defaults to 10 s
(`types.ts:972-973`) and silently wins over an explicitly authored `base`.

A user who writes `base: 30_000` has clearly stated an intent; getting a third of it with no
diagnostic is the same class as the two already filed — a `backoff` function that
[vanishes when cast past](body-verdict-footguns.md), and `retry.attempts`
[being inert on a stream while `retry.backoff` is live](sse-reconnect-replays-completed-streams.md).

**Ask:** either raise `max` implicitly when `base` exceeds it, or warn at construction. The
precedent is already in the codebase: an unparseable `throttle.rate` **throws** at construction
rather than degrading.

---

## 3. Smaller notes from the same verification

- **`serve` is unauthenticated by design** (`serve.ts:28,59`) and this is worth stating louder
  in the surfaces docs than it currently is. Measured: an **unsigned, forged body** under the
  size cap ran the stitch and returned 200. It is a local front door; anyone who can reach the
  port can run any registered stitch. The failure mode of someone mistaking it for a webhook
  endpoint is not a 404 — it is an open endpoint.
- **`engine.ts:287` exports `RAW_BODY`**, which is the raw **response** body of an **outbound**
  call. Anyone grepping "raw body" while debugging an inbound signature failure lands on the
  exact opposite thing. Worth a doc comment noting the direction.
- **`xxh128` (`hash.ts:110-113`) is unkeyed and non-cryptographic** — measured arity 1, same
  digest with no secret. It is correctly documented, but it is the nearest-looking primitive to
  "hash the payload", and a verification built on it authenticates nobody while appearing to
  work.
- **`idempotency` is outbound-only** — measured putting `Idempotency-Key` on an outgoing POST.
  It shares a word with inbound event dedup, which is a different problem at the other end of
  the pipe. A cross-reference from the idempotency guide to the store would help.
- **`memoryStore.close()` is `data.clear()`** (`store.ts:59-61`), so any ledger built on the
  default store does not survive a restart — and a deploy inside a provider's retry window
  re-processes everything still in flight. The swap to a durable store is genuinely one line;
  the default just needs to be understood as ephemeral.
- **`get`-then-`set` is not a claim.** Measured with 3 concurrent deliveries of one id:
  `get`+`set` → `[true, true, true]` (three side effects); `increment(key, ttl)` →
  `[true, false, false]`. `increment` is the atomic primitive and deserves to be the documented
  way to build a dedup ledger — this is the same "the store has the right primitive but nothing
  points at it" shape as [`cache-cannot-revalidate`](cache-cannot-revalidate.md).
