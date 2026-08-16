# Proofs — the mock that passed for six months

Runnable evidence for the claims in [`../../stale-fixture.md`](../../stale-fixture.md).

**Both deciding claims came back split, and one of them found more than it was sent for.** C1
predicted that a shared `output` schema would catch a stale fixture; measured, it catches the
fixture drifting from the _schema_ — all four mutations fail — and is structurally blind to the
scenario's actual shape, the _vendor_ drifting while the fixture sits still. C2 was sent to confirm
three known wall-clock features and came back with **six**, including two nobody had recorded:
OAuth2 token expiry and AWS SigV4 signing. Filing those two worked — #664 and #667 moved them onto
the injected clock — so C2 now pins the post-fix split, **eight driven, four wall-clock**, and the
four that remain on the wall are ADR 0010 §4 decisions rather than gaps.

Every script is standalone and offline. Time is load-bearing throughout, so `manualClock()` drives
every wait — except in the two places where the whole point is that it _doesn't_, and those are
measured against a real clock side by side.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/stale-fixture/c2-clock-coverage.ts

# all of them
for f in docs/scenarios/proofs/stale-fixture/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set (the three `@ts-expect-error` lines are the
machine-checked half of C3(f), C6(c) and C6(e) — a `@ts-expect-error` that is _not_ an error fails
`tsc`; `--ignoreConfig` because TypeScript 6 refuses to mix a found `tsconfig.json` with explicit
files):

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/stale-fixture/*.ts
```

### Why this directory imports Zod by path

Same reason as [`../intermittent-drift/zod.ts`](../intermittent-drift/zod.ts): C1's question is
whether the **same** `output` schema guards prod and the double, and "the same schema" only means
something if the schema is real. Hand-rolling a `{ validate }` stub would let this directory invent
which key is required and what `.optional()` does to a removal — which is exactly what C1 is
measuring. The resolved version in this workspace is **Zod 3.25.76**
(`packages/core/node_modules/zod`), which is why C1(c)'s messages read `Required` and
`Expected boolean, received string`. In application code the spelling is `import { z } from 'zod'`.

## What each script establishes

| Script                    | Question                                         | Measured                                                                                                                 |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `c1-fixture-drift.ts`     | can a stale fixture be caught?                   | **Only in the wrong direction.** 4/4 mutations fail; vendor-drift run is `test ok / prod fail`, 0 findings               |
| `c2-clock-coverage.ts`    | does `manualClock` drive every timed feature?    | **8 driven, 4 wall-clock, 2 timeless.** A 1000ms `timeout.total` survived **2700 virtual ms** and returned ok            |
| `c3-mock-fidelity.ts`     | what does `mockAdapter` validate?                | **Status + header case, nothing else.** Serves `Date`/`Map`/class/`bigint`; passes its 9 contract rules (9th since #664) |
| `c4-resilience-events.ts` | resilience with no vendor?                       | **Yes.** Circuit trace from `callCount()` alone. But retry backoff carries **no `waited`**, and `elapsed` is 0           |
| `c5-stub-contract.ts`     | does a stub honour the input contract?           | **No — zero of the `input` slots run.** The `.safe()` sync-throw bug found here is fixed (#664)                          |
| `c6-sandbox-parity.ts`    | can one stitch target sandbox and prod?          | **Targeting yes, scheduling no.** 3 targets from 1 endpoint; 0 env slots, 0 of 8 CLI verbs verify anything               |
| `c7-streams.ts`           | is mid-stream failure deterministic?             | **Yes — 5 runs, 1 distinct outcome.** But a clean early close is byte-identical to success                               |
| `c8-assembled.ts`         | best "fixtures cannot rot" setup, and the price? | **98 executable lines, 5 seams.** Closes 4 of 5 gaps; the 5th needs a live call and cannot be offline                    |

## Files

- `vendor.ts` — the two objects the whole scenario lives between: `RECORDED_2026_02_04` (the
  cassette) and `VENDOR_TODAY` (five keys different — a rename, a removal, a retype, a null). Plus
  `MUTATIONS` (the four drift shapes as separate bodies) and two hand-written in-memory adapters.
  Deliberately does **not** use `mockAdapter`, because C3 puts `mockAdapter` under test.
- `harness.ts` — `check` / `checkSeq` / `checkNear` / `checkAtLeast` / `note` / `heading` / `finish`,
  plus the two this scenario needed: `checkClockDriven` (runs a scenario twice — once with the
  advance the test believes is decisive, once with `advance(0)` — and asserts whether the two
  outcomes DIFFER; identical outcomes mean the advance caused nothing, which is the signature of a
  **vacuous** test) and `row`/`printClockTable` (the C2 table).
- `fixture-guard.ts` — **user code** for C8, between the `>>> BEGIN USER CODE` markers: `stamp` /
  `expired` (a recording date, the one fact the library cannot hold), `jsonOnly` (an adapter wrapper
  that rejects any fixture body a JSON wire could not deliver), `contractStub` (a `stubStitch` that
  runs the real `input` schemas), `assertClockHonest` (refuses a `manualClock` paired with a slot it
  cannot drive), and `parity` (the only export that needs a network call — quarantined, and saying so
  is half its value).
- `zod.ts` — real Zod, imported by path. See above.

## The C2 table

The definitive enumeration. Fourteen rows, every place `packages/core/src` reads time.

| Feature                    | Driven by     | Evidence                                                                                                  |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| retry backoff              | `manualClock` | `advance(5000)` → 3 calls, ok; `advance(0)` → 1 call, pending                                             |
| throttle rate              | `manualClock` | `advance(3000)` → 3 calls; `advance(0)` → 1 call                                                          |
| throttle concurrency       | `manualClock` | holder releases on virtual time → queued callers proceed                                                  |
| `circuit.cooldown`         | `manualClock` | `advance(60_000)` past a 30s cooldown → half-open probe reaches the vendor                                |
| `timeout` (per-attempt)    | `manualClock` | `advance(2000)` past a 1s timeout → error; `advance(0)` → pending                                         |
| `Retry-After` (HTTP-date)  | `manualClock` | `resilience.ts:74` reads `clock.now()` — **and that is the trap**, see below                              |
| OAuth2 token expiry        | `manualClock` | `auth.ts:432` reads `ctx.clock` (#664); `advance(600_000)` past a 60s `expires_in` → refetch              |
| AWS SigV4 signing date     | `manualClock` | `aws-sigv4/src/index.ts:266/324` stamp from `ctx.clock` (#667); an epoch-0 clock signs `19700101T000000Z` |
| **`timeout.total`**        | **wall**      | `engine.ts:502/520/542/564/689`; a 1000ms budget survived **2700 virtual ms**                             |
| **`cache.ttl`**            | **wall**      | `store.ts:30/59`; `advance(600_000)` past a 60s TTL still served the entry                                |
| **`memoryStore` TTL**      | **wall**      | the layer beneath it; a 1s entry survived 60_000 virtual ms                                               |
| **event `at` / `elapsed`** | **wall**      | measured `at=1786786…` while `clock.now()` was `0`; `done.elapsed` reads `0`                              |
| `paginate`                 | no time       | no inter-page delay knob; 3 pages fetched at `clock.now() === 0`                                          |
| `Retry-After` (delta-secs) | no time       | a pure number; `parseRetryAfter('5')` is `5000` on any clock                                              |

Eight driven, four wall-clock, two with no time in them. The OAuth2 and SigV4 rows were **wall**
when this audit first measured them; filing them (#650, #658) got both moved onto the clock (#664,
#667), and the four wall rows that remain are ADR 0010 §4 decisions — control-flow time, not
bookkeeping.

## Reading the numbers honestly

- **C2's `timeout.total` row is not "the clock is ignored".** The engine clamps each attempt's abort
  to `budget.deadline - now()` and hands that to `withTimeout(..., rt.clock)`, so the clamp _does_
  fire on virtual time. What is wall-anchored is the **deadline** — `wallT0 + total`. Virtual sleeps
  never move the wall, so the remaining budget is recomputed as ~the full total at every attempt. The
  budget does not drain; it **resets**. C2(f) measures it as a side-by-side: the same config shape on
  a real clock dies at 101ms after 2 attempts with `timed out after 100ms`; on a manual clock it runs
  3 attempts across 2700 virtual ms and returns `ok`.

- **The `Retry-After` HTTP-date row is a trap, not a gap, and it is arguably worse.**
  `parseRetryAfter` reads the injected clock _faithfully_ — `httpDateEpoch - clock.now()` — and
  `manualClock()` starts at `0`. A server date meaning "5 seconds" therefore becomes a wait of
  roughly **twenty thousand days** (the manual epoch is 1970, so the exact figure grows by one a
  day). The feature honouring the clock is exactly what breaks it.

- **C1 is not a criticism of the schema.** The schema does its job in every direction it can see. The
  gap is epistemic: offline, the only bytes available are the fixture's, so "has the vendor changed"
  is not a question any amount of validation can answer. C8 concedes this and settles for dating the
  fixture (`getInvoice recorded 2026-02-04 (182d old)`), which fails the suite on the calendar rather
  than on the drift — a weaker guarantee, reported as one.

- **Two findings were library bugs rather than design trade-offs, and both are fixed.** Found in
  passing, filed as #650, fixed by #664. `mockAdapter` violated the library's own
  `verifyAdapterContract` rule `abort: a pre-aborted signal rejects` — it consulted `req.signal`
  only inside its `delay` branch; the signal is now checked before any route logic
  (`test-mock.ts:165-170`), so C3 pins 9/9 rules and no spy entry for a cancelled request. And
  `stubStitch(...).safe()` **threw** when the impl threw synchronously; `resolve()` is now an
  `async` function (`test-stub.ts:59-70`), so C5 pins `ok: false` for the sync and async arms
  alike — matching the real stitch, whose `.safe()` always honoured the same situation.

- **C6's answer is a split, and the split is the point.** Targeting is genuinely well served —
  `extends: { baseUrl, adapter }` aims one endpoint definition at a fixture, a sandbox and prod, and
  the same `output` schema makes the difference visible. What is absent is the _schedule_: no
  environment concept on `StitchConfig` (an unknown key is a compile error), none of the 8 CLI
  subcommands verifies anything, and all four `verify*Contract` functions check an implementation of
  one of StitchAPI's **own** seams, never a vendor.
