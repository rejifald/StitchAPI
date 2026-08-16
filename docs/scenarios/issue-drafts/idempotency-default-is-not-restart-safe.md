# Issue draft — `idempotency: true` double-charges a re-driven job, and adding `retry` silences the warning

**Status:** ✅ **FILED** as [#642](https://github.com/rejifald/StitchAPI/issues/642). Raised by the scenario pass on 2026-08-05.
**Scenario:** [`unconfirmed-write`](../unconfirmed-write.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `idempotency`, `dx`, `money`

> The highest-stakes finding of the pass, because the measurement is charges. Everything here is
> counted against a ledger the fake vendor owns, not inferred.

Reproduce:

```bash
for f in docs/scenarios/proofs/unconfirmed-write/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. The default key is per call, so a re-driven job charges twice

**Severity: high — measured duplicate charges with correct-looking config.**

`engine.ts:172` mints `randomUUID()` when no `keyOf` is given, inside `buildRequest`
(`engine.ts:257`) — i.e. once per **call**, not per **intent**.

Measured, simulating a queue re-driving a job after a crash with identical input:

| config                        | distinct keys | charges | intended |
| ----------------------------- | ------------- | ------- | -------- |
| `idempotency: true` + `retry` | **2**         | **2**   | 1        |
| `idempotency: { keyOf }`      | 1             | **1**   | 1        |

End to end across six workloads (crash-and-re-drive, lost response, TTL expiry, two concurrent
runs, a decline): the default produced **8 charges for 6 intended payments**, two of them
duplicates. A derived key plus a query-first recovery produced **5** (the sixth legitimately
declined).

**And the guard is scoped narrower than readers will assume.** `stitch.ts:386` is:

```ts
// A derived `keyOf` dedupes resubmissions on its own, so only the random default with no
// retry is the inert case.
if (idem.keyOf || cfg.retry) return;
```

The reasoning is sound on its own terms — a random key _does_ protect the retries inside one
call, which is what `retry` adds. But the practical effect is that **following the warning's own
advice ("add `retry`") silences it**, while the restart case it doesn't cover is the one that
costs money. The message says the config "only dedupes its own retries"; that sentence is
accurate and is exactly the limitation, so the fix may be as small as re-wording it.

**Ask:** either warn whenever `keyOf` is absent regardless of `retry`, or re-word to name the
restart case explicitly — something like _"…only dedupes retries **within one process**; a
re-driven job will charge again. Set `idempotency.keyOf` to derive the key from the business
reference."_ Documenting `keyOf` as the default recommendation for writes would also do it.

## 2. A dropped request and a lost response are indistinguishable

**Severity: medium — inherent to timeouts, but the library discards what it does know.**

The two cases with opposite ledger outcomes produced **field-for-field identical** errors:

|                                | dropped request                        | lost response |
| ------------------------------ | -------------------------------------- | ------------- |
| charges on the vendor          | **0**                                  | **1**         |
| `name` / `status` / `attempts` | `StitchError` / `undefined` / `1`      | identical     |
| `message` / `body`             | `timed out after 5000ms` / `undefined` | identical     |

Nothing can be inferred from the error. Three things the library could keep and doesn't:

- **`TimeoutError` is flattened and unexported.** The class survives only in `hooks.onError`
  (`resilience.ts:17,233` never sets `.name`; `errEvt` at `engine.ts:346-355` flattens it;
  `index.ts:86` exports only `RateLimitError`). A caller cannot type-test for a timeout.
- **No event carries the idempotency key.** So with the random default, the standard recovery —
  query the vendor by key — is impossible: you never learned the key that was sent.
- **`StitchError` has no `headers`**, so a vendor's replay marker (the one signal that would say
  "this was a replay, not a fresh charge") is unreachable from the error. It _is_ visible to
  `hooks.onResponse`.

**Ask:** export `TimeoutError` and preserve the class through `errEvt`; put the idempotency key
on the `start` event; consider `headers` on `StitchError`.

## 3. `retry.on` cannot exclude a timeout, and cannot see a replay

- **A transport failure is retried unconditionally** — measured **3 requests with
  `retry: { on: [] }`** (`engine.ts:675-703`). For a non-idempotent write with no key, "retry
  statuses but never a timeout" has no spelling; the only lever is `attempts: 1`.
- **A replayed failure cannot be excluded.** If 500 is added to `retry.on`, all 4 attempts burn
  against the vendor's recording (3 replays). `Surface.interpret` cannot veto it — it runs
  _after_ the retry check (`engine.ts:743` vs `:775`) — and the `retry.on` predicate receives
  only the status, measured `[[500],[500],[500]]`. A `hooks.onResponse` status rewrite cuts 4
  requests to 2 at the cost of lying about the status.

**Good news worth keeping:** the default `retry.on` (`[429, 502, 503, 504]`) means a cached 500
is **not** retried out of the box — 1 request under `attempts: 4`. The capture predicted this
would burn the budget; it does not.

## 4. TTL expiry has no client-side signal

A prune turns a correct, stable key into a second charge: measured **2 charges at a 25 h delay
against a 24 h TTL**, 1 charge at 23 h. The duplicate arrives as a clean `200` with **no replay
marker**, so nothing distinguishes it from the original. `timeout.total` is per call and cannot
bound the gap.

This is genuinely the vendor's semantics, not a library defect — but it is worth a line in the
idempotency guide, because the natural mental model ("the key makes it safe") has an expiry date
that is usually shorter than a dead-letter queue's.

## 5. Footguns

1. ‼ **`keyOf: (i) => JSON.stringify(i.body)`** — the obvious spelling — **fails by charging
   twice, not by erroring.** Key order alone moved the hash: **2 keys, 2 charges, statuses
   `[200, 200, 200]`**, no `409` anywhere, because the vendor never saw the same key twice.
   `refKeyOf` and a canonical sha256 held at 1 key / 1 charge across all three body variants.
   Worth an explicit "derive from a business reference, don't stringify the body" in the guide.
   Note an input **schema does not canonicalise** what `keyOf` sees.
2. ‼ **A `__config` JSON round-trip drops `keyOf`** and leaves `idempotency: {}` — truthy, so the
   random default is silently restored. Measured **2 charges, nothing warned**. Nothing shipped
   rebuilds from `__config`, but it is documented as round-tripping as JSON, so this is a trap
   for anyone who does.
3. **Pagination mints a key per page** — 3 pages, 3 distinct keys (`engine.ts:936,940` rebuild
   per page). Correct for reads; a hazard if anyone paginates a write.
4. **`verdict: { accept: [409], flag: 'ok' }` swallows an idempotency conflict** — `ok: true`,
   error payload returned as data. **Fourth sighting** of the absent-flag rule producing a silent
   success (scenarios 2, 11, 14, 15); see the standing note in the [ledger](../LEDGER.md).
5. **Nothing expresses "sticky for a decline, fresh for a blip."** A stable key makes a recorded
   failure sticky for the whole TTL — measured, a declined card stayed declined — while the
   random key never reaches the record and charges again. Both are defensible; neither is
   selectable, and the choice is currently a side effect of which key strategy you picked.
