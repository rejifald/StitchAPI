# Proofs — one list, a hundred follow-up calls

Runnable evidence for the claims in [`../../n-plus-one-fanout.md`](../../n-plus-one-fanout.md).

**The deciding claim was C2 and it goes the library's way — emphatically.** `cache.coalesce`
**genuinely collapses in-flight duplicates**: 100 concurrent calls over 30 distinct customer ids
made **30 requests**, one per id, from a single `cache: { ttl }` block and no user code. Every call
was in flight simultaneously and not one response had landed, so no read-through cache could have
helped; `coalesce: false` on the same cache put it straight back to 100. 70 of the 100 callers were
served without a request of their own. This is the capability the capture hoped for and most
clients do not have, and it is on by default the moment a `cache` block exists.

The rest of the fan-out is four decisions, and three of them are also configuration. **Bounded
concurrency works exactly** on one stitch called N times (peak 8 in-flight against a declared 8,
where the unbounded baseline is 100). **The default backoff genuinely de-clusters a herd**: 100
calls 429ed in the same instant retried over ~98 distinct milliseconds under `expo-jitter`, against
all 100 in ONE millisecond under `expo` and `fixed`. **Partial failure** is `.safe()` and an array
index. The end-to-end answer is **45 executable lines against a hand-rolled control's 87**.

What the capture did not anticipate, and what a docs page has to say out loud, is that **each of
those wins has a default that undoes it**:

- A **coalesced FAILURE is not shared.** A failed leader releases its joiners to run independently
  (engine.ts:1646-1659), so 100 concurrent calls for one id that 404s made **100 requests in two
  waves** — and in the assembled run the deleted customer cost StitchAPI **4 requests to the
  hand-rolled control's 1**.
- A vendor that sends **`Retry-After` re-clusters the herd**, because `retry.respect` defaults ON
  (engine.ts:748-761): `expo-jitter` stayed configured and all 100 retries landed in one
  millisecond.
- Building **one stitch per id** — the only construction `all()` can express this with — multiplies
  the concurrency budget by the number of stitches (peak 100 against a declared 8) until the state
  is pooled. `pool: 'host'` fixes it, and since ADR 0025 (#630) a lease-capable **`store`** keeps
  that fix — fleet-wide — instead of silently breaking it; only a lease-less store still reverts
  concurrency to per-process.
- Under coalescing every joiner is handed the **leader's object by reference**, so rows that share
  a customer share one mutable object.

Every script is standalone and offline. The measurement is always one of two numbers: **how many
requests reached the server**, and **the peak number open at once**. Each script prints one
`PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c2-coalesce.ts

# all of them
for f in docs/scenarios/proofs/n-plus-one-fanout/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle. The whole suite takes about twelve seconds:
every wait is on a `manualClock`, and nothing here does real I/O.

They typecheck under `packages/core`'s full strict set — `--ignoreConfig` because TypeScript 6
makes a file list alongside a `tsconfig.json` an error (TS5112), and here the flags are the
whole config:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/n-plus-one-fanout/*.ts
```

## What each script establishes

| Script                      | Question                                               | Measured                                                                                                                       |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `c1-combinators.ts`         | can `all()` express N different inputs?                | **No — but not for the reason the capture gives.** Runtime length is fine; 100 members + 1 input = **100 requests for ONE id** |
| `c2-coalesce.ts`            | **DECIDING** — does `cache.coalesce` dedupe in-flight? | **YES. 100 calls, 30 ids, 30 requests.** And a failed leader releases 99 joiners: **100 requests for one dead id**             |
| `c3-bounded-concurrency.ts` | is `throttle: { concurrency }` a real bound?           | **On one stitch, exactly** (peak 8/8). On 100 stitches, **peak 100**. `pool: 'host'` + a lease-capable `store` holds (peak 8)  |
| `c4-partial-failure.ts`     | does one 404 cost the other 99?                        | **Only without `.safe()`.** Bare `Promise.all`: 0 rows kept, 100 requests spent. `.safe()`: 99 rows, failure at index 49       |
| `c5-thundering-herd.ts`     | does `expo-jitter` de-cluster a 429ed burst?           | **Yes: ~98 distinct ms vs 1 for `expo`/`fixed`.** `Retry-After` puts all 100 back in one ms                                    |
| `c6-trace.ts`               | one tree or a hundred roots? does `linked` help?       | **101 roots by default; 1 tree with `linked`** — drawn as a **101-deep chain** over calls that ran concurrently                |
| `c7-ordering.ts`            | does result order survive concurrency?                 | **Positional, always** (completion order reversed, results in input order). Coalesced rows **share one object**                |
| `c8-assembled.ts`           | the whole job, end to end, against a hand-rolled pool  | **45 vs 87 executable lines**, identical outcomes — and **44 requests vs 32**, all of the difference on the failure path       |

## Files

- `fake-vendor.ts` — the vendor. `GET /orders` returns N orders whose `customerId`s round-robin over
  a smaller pool (100 orders, 30 customers ⇒ every id 3 or 4 times, a flat and exact duplicate
  distribution). `GET /customers/{id}` counts requests **per id**, records each arrival with its
  **in-flight count** and its time on the injected clock, and tracks the **peak**. Named ids can 404
  or 429 persistently; `burst429(n)` rate-limits the first `n` requests whatever their id, which is
  how a simultaneous cohort gets throttled together. `slow` gives per-id latencies so completion
  order can be made to disagree with call order. `echoUrl` and `retryAfter` exist because two
  findings turn on whether the transport echoes `res.url` and whether the vendor sends `Retry-After`.
- `harness.ts` — `check` / `checkSeq` / `checkRequests` / `checkPeak` / `checkAtMost` /
  `checkAtLeast` / `note` / `heading` / `finish`. `checkRequests` prints requests **and** the
  distinct-id floor together, because `100 requests for 30 distinct ids` is the finding and `100`
  alone is not; `checkPeak` prints the peak **and** the declared bound for the same reason.
- `trace-probe.ts` — a `TraceSink` recording `(name, type, traceId, spanId, parentSpanId, url)`,
  reduced to trace count, root count, **max chain depth** and **max fan-out**. The `url` is there
  because one stitch called 100 times emits 100 spans with one name.
- `type-probe.ts` — hands the compiler seven candidate fan-out spellings and reports which compile.
  "The combinator can't" and "I couldn't find the spelling" are different findings.
- `fanout.ts` / `hand-rolled.ts` — the assembled answer and the control, both over the same
  `Adapter` and the same `Clock`, both delimited by `BEGIN`/`END USER CODE` markers so the line
  count is of code someone maintains.
- `virtual-time.ts` — `drain` / `runOut`, so a claim can say "advance past everything" instead of
  hand-computing a hundred backoff schedules.

## Reading the numbers honestly

- **C2 is the headline and it deserves to be read carefully.** The saving is real and it is
  specifically an **in-flight** saving: with all 100 calls issued in the same tick, a TTL cache
  cannot help any of them, and `coalesce: false` proved that (100 requests, same cache, same TTL).
  What made it 30 is `InflightCoalescer.join` (cache.ts:207-262) handing the first caller per key a
  leader claim and everyone else a shared promise, awaited at engine.ts:1634-1663. `'cluster'` is
  accepted and **silently degrades to `'process'`** in v1 (cache.ts:396-397).
- **The coalescer is a SUCCESS-path optimisation, and the failure path is its exact inverse.** When
  the leader fails, `claim.fail` rejects and each follower's `catch` re-runs the whole chain
  independently (engine.ts:1646-1659). Measured: 100 concurrent calls for one 404ing id → **100
  requests in two waves, 1 then 99**. Every caller got its own honest `HTTP 404` (never a
  leader-failure artefact), which is the right error at the wrong price. In C8 this is **4 requests
  for the deleted customer against the hand-rolled `Map<id, Promise>`'s 1**, and it scales with the
  number of order rows naming a broken id, not with the number of broken ids.
- **C1 refutes the capture's stated reason while confirming its conclusion.** The capture says a
  runtime length "rules out any combinator that takes a fixed list of members". It does not:
  `membersFrom` (pipe.ts:226-229) reads a plain array and `all(ids.map(…))` compiles and runs. The
  wall is the **input** — `runMember` spreads one `StitchInput` into every member (pipe.ts:75-86),
  measured as **100 requests for `cust-001` and 99 wasted**. Of seven candidate spellings only
  `all(array)` and `all(a, b, c)` compile; `all(one, inputs)`, `all.map`, `allSettled`, `.safe()`
  members and `all(members, { concurrency })` are all compile errors.
- **`all()`'s auto-cancel prevented zero requests.** It aborts the losers on the first failure
  (pipe.ts:114-117), but in a fan-out they have all already left: measured 100 requests made, 99
  customers fetched, and every one discarded by the fail-fast.
- **C3's good news is narrow and its trap is the construction C1 forces.** One stitch, 100 calls,
  `concurrency: 8` → **peak 8**. One hundred stitches each declaring 8 → **peak 100**, because
  `makeStitch` builds a limiter per stitch (stitch.ts:1042-1046) over closure-local state
  (resilience.ts:111). `pool: 'host'` repairs it via the module-level `hostStates` registry
  (resilience.ts:88) — and since ADR 0025 (#630) a lease-capable **`store` keeps the repair**
  (peak 8): the engine hands the store throttle the same pool-aware host key (engine.ts:642,
  274-283) and the store owns one counting semaphore under it (store.ts:90-106), a budget
  `packages/core/test/store.spec.ts:456-464` pins fleet-wide. A lease-less store (no
  `lease`/`release`) still keeps concurrency per-process (spec :466-475) — the one place the old
  peak-100 reversion survives. A **seam** also survives with nothing else declared: 100 members
  under a seam-level `concurrency: 8` measured peak 8 (seam.ts:51-69).
- **This proof's own hypothesis about the throttle was wrong, in the library's disfavour.** It
  assumed a call sleeping on a retry backoff had released its slot. It has not: the backoff sleep
  is inside the `try` whose `finally` releases (engine.ts:760-765, 834-837). Measured with a bound
  of 4, a 429ed first wave and a 1s backoff, the **fifth call left at t=1050 rather than t=50** —
  four of four slots held by calls that were asleep and issuing nothing, ~95% of the declared
  budget idle. And a retry re-queues at the **back** of the FIFO: the first call's retry left at
  t=4200, behind every other call's first attempt.
- **The coalescer sits outside the throttle, which is the right layering.** 100 calls over 30 ids at
  a bound of 8 fired exactly **22 `throttled` events** (30 real requests minus the first 8), not 92.
  The joiners never reach the limiter, so the bound governs **requests**, not callers.
- **C5's default is correct and a well-behaved vendor cancels it.** `expo-jitter` is the default
  curve (resilience.ts:45) and it spread a 100-call cohort over ~98 distinct milliseconds across the
  full window, all ten 100ms slices occupied; `expo` and `fixed` both put all 100 in **one**
  millisecond, because attempt 2 is `base·2^0` and doubling a constant is a constant. A bare
  `retry: { attempts: 2 }` de-clusters with nothing configured. But `Retry-After` is preferred over
  the computed backoff and `retry.respect` defaults ON (engine.ts:748-761), so a vendor sending
  `Retry-After: 2` put all 100 retries back into **one millisecond at t=2000** with `expo-jitter`
  still declared. `retry: { respect: false }` restores the spread and is all-or-nothing.
- **The jitter is FULL, not equal** (`Math.random() * computed`, resilience.ts:54): the earliest of
  100 retries measured 2-8ms against a base/2 floor of 500. Aggressive, and correct here.
- **C6 answers the capture's `linked` question yes, with a caveat that matters.** `ScopedRun` takes
  the stitch's **own** input per call (pipe.ts:355-361), so `linked` is the only construction that
  gets a runtime-length fan-out of **different** ids into one trace: measured 1 traceId, 1 root, 101
  spans over the list and all 100 lookups. The shape is wrong, though — `run` chains each call under
  the **previous** one (pipe.ts:360-367), so the same run measured **depth 101, max fan-out 1** while
  the calls genuinely ran concurrently (peak 100 in flight). A viewer draws 100 simultaneous lookups
  as a queue. `linked(...)` is a `Promise`, not a `Composable`, confirming scenario 10.
- **C7's ordering answer is boring and its aliasing answer is not.** Completion order reversed
  end-to-end, results still in input order, under concurrency and under coalescing alike. But every
  joiner is handed the leader's object **by reference** (engine.ts:1645,1662): 20 rows over 5
  customers measured **5 distinct objects**, and mutating row 0's customer changed row 5's. The same
  fan-out with no cache measured 20 distinct objects, so the aliasing arrives with the optimisation.
  A cache **hit** aliases the same way for the whole TTL.
- **C8's 45 vs 87 lines attributes cleanly.** What became configuration: the FIFO pool, the
  retry-with-jitter loop, the retryable-status set, the non-2xx throw and the URL assembly. What did
  **not** shrink: the per-row `problem` branch and the positional join. Partial failure is user code
  on both sides, and it is the only user code the StitchAPI version needs.

## The footguns

- **`cache: { ttl: 0 }` caches FOREVER.** It is the obvious spelling for "I want the in-flight
  dedupe, not the staleness", and `memoryStore` stores `expires: ttl ? now() + ttl : 0` and treats
  `expires === 0` as live (store.ts:15-16,45). Measured: a second fan-out long after the first added
  **0 requests**. There is no "coalesce only" spelling.
- **`sensitive: true` silently disables coalescing.** `ensureCache` returns null on it
  (engine.ts:1020), so a config that still reads `cache: { ttl: '60s' }` went back to **100 requests
  for 30 ids** with nothing warning. The same holds for `.inspect()`, which bypasses the cache by
  default (ADR 0016) and therefore runs its own uncoalesced request.
- **Coalescing applies only to the CACHEABLE METHOD set.** A POST-shaped lookup coalesced nothing
  (100 requests) until `methods: 'POST'` was named (30). The default is `['GET','HEAD']`
  (cache.ts:367-369).
- **A declared `concurrency` is multiplied by the number of stitch objects.** 100 stitches each
  declaring 8 measured peak 100. This is not hypothetical: it is the construction C1 shows is the
  _only_ way `all()` can express a per-id fan-out.
- **A lease-less `store` un-pools `pool: 'host'` concurrency.** With a lease-capable store the
  bound holds (peak 8, and fleet-wide — ADR 0025); with a store that lacks `lease`/`release`
  (an eventually-consistent KV, a minimal custom store) the rate budget still becomes
  cross-process while the concurrency bound quietly stays per-process
  (store.ts:226-233, spec :466-475) — this construction's old measured reversion, peak 100
  against a declared 8, with the config unchanged.
- **A backing-off call holds its concurrency slot.** With `concurrency: N` and a long backoff, N
  slots can be occupied by N sleeping calls issuing nothing (measured ~95% idle over a 1s backoff).
  A retry then re-queues at the back of the FIFO, so a retried call finishes after every call that
  started later.
- **`Retry-After` defeats `expo-jitter` by default.** Obeying the server is the right default in
  general and the wrong one for a simultaneous cohort, and the two policies cannot be combined:
  `retry.respect` is a boolean, so it is obey-and-cluster or ignore-and-spread.
- **Coalesced and cached callers share one mutable object.** Any normalise/enrich step that writes
  onto a joined customer writes onto every row sharing it — and, through the cache, onto every later
  hit for the TTL.
- **`verdict: { accept: [404] }` does not classify a missing customer, it succeeds on it.** Measured
  `ok: true` with `{ error: 'customer_not_found', id }` handed back as the customer, so the join
  writes a row with an undefined name and nothing says so. (The same trap was measured on an
  idempotency 409 in `unconfirmed-write` and an AWS skew 403 in `expiring-signatures`.)
- **`StitchError.url` comes from the TRANSPORT.** `rebuildError` copies `res.url`, so a custom
  adapter that does not echo it leaves the caller unable to say which id failed from the error
  alone (measured `undefined`). `fetchAdapter` does set it (http-adapter.ts:98,111,145). The array
  index is the only identifier that always works.

## What is NOT measured here

- **A batch endpoint.** The capture's own best advice is not to fan out at all where
  `GET /customers?ids=…` exists. Nothing here measures that path; the partial-failure semantics you
  inherit from it are [`batch-partial-failure`](../batch-partial-failure/).
- **Cross-process coalescing.** `coalesce: 'cluster'` is accepted and degrades to `'process'`
  (cache.ts:396-397); no measurement here involves two processes, so nothing establishes what a
  real cluster protocol would or would not collapse.
- **A shared `store` behind the cache.** Every measurement uses the default `memoryStore`. Whether a
  Redis-backed store changes the coalescing arithmetic (it should not — the coalescer is in-process
  by construction) is untested.
- **Real latency distributions.** Holds are exact virtual durations, so the concurrency measurements
  are free of the scheduling noise a real transport has. The peak-in-flight numbers are therefore
  upper bounds on tidiness, not predictions.
- **Memory.** 100 concurrent calls means 100 live run states, 100 event streams and a joined array;
  nothing here measures the footprint. See [`large-response-memory`](../large-response-memory/).
- **`store`-backed cross-process concurrency, across real processes.** C3 (e) establishes that a
  lease-capable store holds ONE budget in-process under the shared host key; the fleet-wide claim
  rests on `packages/core/test/store.spec.ts:456-464` (four throttle instances over one store,
  peak 3 of a declared 3), which simulates workers in one process. Nothing here runs two real
  processes.
