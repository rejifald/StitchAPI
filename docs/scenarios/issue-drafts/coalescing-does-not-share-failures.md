# Issue draft — a coalesced failure is not shared, and a `store` silently un-pools `pool: 'host'`

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`n-plus-one-fanout`](../n-plus-one-fanout.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `cache`, `throttle`, `enhancement`

> **Leading with the strongest positive result of the pass.** `cache.coalesce` genuinely
> collapses **in-flight** duplicates: 100 concurrent calls over 30 distinct ids made **30
> requests** — one per id, exactly the floor — with every call in flight and **no response
> landed**, from a single `cache: { ttl }` block. 70 callers were served without a request of
> their own; `coalesce: false` on the same cache made 100. Most clients do not have this, and the
> N+1 fan-out is precisely the shape it fixes.
>
> Two findings sit beside it, and one is a silent un-fix.

Reproduce:

```bash
for f in docs/scenarios/proofs/n-plus-one-fanout/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. A coalesced failure releases every joiner to re-run

**Severity: medium — it costs a wasted request per duplicate reference to a broken id.**

A leader that _succeeds_ serves its joiners. A leader that _fails_ releases them
(`engine.ts:1646-1649`, `:1656-1659`), and each re-runs the whole chain independently.

Measured: 100 concurrent calls for one id that 404s made **100 requests in two waves** — 1
leader, then 99 followers. Every joiner got its own honest `HTTP 404` (never a leader artefact),
which is the right _error_ at the wrong _price_: the correct diagnosis is bought by asking the
vendor 100 times for a resource that does not exist.

End to end this is the only place the hand-rolled control beats the library — **44 customer
requests against 32**, and a deleted customer cost **4 requests against 1**. A plain
`Map<id, Promise>` shares the rejection. This is exactly the shape a dead foreign key takes, and
it multiplies with how many rows reference it.

**And coalescing does not protect a herd.** With 100 calls over 20 ids and only the 20 leaders
429'd, the run made **100 requests** — 80 followers re-fanned at full width. The cohort that
just tripped the limit is exactly the cohort that fans back out.

**Ask:** share the leader's rejection with its joiners, at least for a short window, or offer
`coalesce: { shareFailures: true }`. If failures must not be shared (a defensible position — a
transient failure shouldn't be broadcast), a negative-cache window would cover the two cases that
actually recur: a 404 that will stay a 404, and a 429 the whole cohort just caused.

## 2. A `store` silently un-pools `pool: 'host'` concurrency

**Severity: medium-high — a declared bound of 8 measured a peak of 100, config unchanged.**

Three constructions, one declared budget of `concurrency: 8`:

| construction                                  | peak in-flight                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| one stitch called 100 times                   | **8** ✅                                                                                                |
| 100 separate stitches, each declaring 8       | **100** — the limiter is per stitch (`stitch.ts:985-988` over closure-local state, `resilience.ts:107`) |
| 100 stitches + `pool: 'host'`                 | **8** ✅ (module-level `hostStates`, `resilience.ts:84`)                                                |
| 100 stitches + `pool: 'host'` **+ a `store`** | **100** ❌                                                                                              |

`createStoreThrottle` never reads `opts.pool` and keeps `inFlight` in a closure-local Map
(`store.ts:137-151`). The store is exactly what you add to make the **rate** budget
cross-process, and it un-pools the **concurrency** on the way past.

The 100-stitch shape isn't hypothetical: it is the only construction that lets `all()` express a
per-id fan-out at all (see §4), so the two findings compose into "the way you're pushed to write
it is the way the bound stops working."

**Ask:** honour `pool` in the store-backed throttle, or reject `pool: 'host'` + `store` at
construction rather than accepting it and ignoring it. A seam-level `concurrency` does survive
both (`seam.ts:51-69`) and is worth documenting as the answer for a stitch-per-item shape.

## 3. Two backoff/slot interactions worth documenting

- **A backing-off call holds its concurrency slot.** The retry sleep sits inside the `try` the
  release `finally` guards (`engine.ts:760-765`, `:834-837`). Measured with a bound of 4, a
  429'd first wave and a 1 s backoff: the fifth call left at **t=1050** rather than t=50, with
  ~95% of the declared budget occupied by calls that were asleep and issuing nothing. The retry
  then re-queues at the **back** of the FIFO — the first call's retry left at t=4200, behind
  every other call's first attempt.
- **`Retry-After` defeats `expo-jitter` by default.** The default `expo-jitter` genuinely
  de-clusters — 100 calls 429'd in one instant retried across **~98 distinct milliseconds**,
  where `'fixed'` and `'expo'` both put all 100 in **one millisecond**. But `retry.respect`
  defaults on and takes the header verbatim (`engine.ts:748-761`), so `Retry-After: 2` put all
  100 back into one millisecond at t=2000 with jitter still declared. `respect: false` restores
  the spread and is all-or-nothing — there is no "honour the header, then jitter around it",
  which is the behaviour a herd wants.

## 4. The combinators can't express a per-id fan-out, and not for the obvious reason

The runtime length is fine — `all(ids.map(…))` compiles, because `membersFrom` takes a plain
array (`pipe.ts:226-229`). **The input is the wall**: `runMember` spreads one `StitchInput` into
every member (`pipe.ts:75-86`), so 100 members called with one input made **100 requests for one
distinct id**, 99 of them waste.

Of seven candidate spellings, **two** compile (`all(array)`, `all(a, b, c)`); `all(one, inputs)`,
`all.map`, `allSettled`, `.safe()` members and `all(members, { concurrency })` are all compile
errors. `Member` is brand-gated on `__stitch` (`pipe.ts:188-189`), so the suggestion to compose
`.safe()` members by hand does not typecheck.

This is the third scenario to land on the input broadcast (7, 10, 16) and the second to want
`allSettled`. **Ask:** a per-member input — `all([{ node, input }])` or a mapping function —
would close all three at once. It is the same ask as
[`any-is-priced-as-a-hedge`](any-is-priced-as-a-hedge.md) §1, now with a second motivating shape.

## 5. Footguns

1. ‼ **`cache: { ttl: 0 }` caches forever.** It is the obvious spelling for "dedupe but don't
   cache", and `expires === 0` reads as live (`store.ts:15-16,45`) — a later fan-out added **0
   requests**. There is no coalesce-only spelling.
2. ‼ **Coalesced and cached callers share one object by reference** (`engine.ts:1645`, `:1662`).
   20 rows over 5 customers gave **5 distinct objects**; mutating row 0 changed row 5, and a
   cache hit aliases the same way for the whole TTL. Any normalise/enrich step that writes onto a
   joined record writes onto every row sharing it — and the aliasing arrives _with_ the
   optimisation.
3. **`sensitive: true` silently disables coalescing** (`engine.ts:1020`) — back to 100 requests
   for 30 ids with the `cache` block still reading as if it coalesces.
4. **Coalescing is GET/HEAD only** — a POST lookup deduped nothing until `methods: 'POST'`.
5. **`cluster` silently degrades to `process`** (`cache.ts:396-397`).
6. **`verdict: { accept: [404] }` succeeds on a missing record**, handing the error envelope back
   as `data` so the join writes a row with no name. **Fifth sighting** of this shape.
7. **`StitchError.url` comes from the transport** — an adapter that doesn't echo it leaves the
   failing id unidentifiable from the error alone. The array index is the only identifier that
   always holds.
