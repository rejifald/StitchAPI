# Proofs — cost-based rate limits reported in the response body

Runnable evidence for the claims in
[`../../cost-based-rate-limits.md`](../../cost-based-rate-limits.md).

Every script is standalone, offline, and deterministic: it injects a fake Shopify GraphQL Admin API
through StitchAPI's `adapter` seam and drives refill off an injected `manualClock()`, so every
number below is exact virtual time — no wall-clock sleeps, nothing flaky, no network.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c1-retry-on-200-throttled.ts

# all of them
for f in docs/scenarios/proofs/cost-based-rate-limits/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path,
so they test the working tree, not the published bundle.

## What each script establishes

| Script                          | Question                                   | Measured                                                                              |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `c1-retry-on-200-throttled.ts`  | can `retry` fire on a 200-with-THROTTLED?  | **No.** `retry.on` is handed **1** argument, the number `200`                         |
| `c2-computed-wait.ts`           | can the wait be computed from the body?    | **Not via `backoff`** — but `SurfaceOutcome.after` is honoured exactly (6000ms)       |
| `c3-extensions-reachability.ts` | is `extensions.cost` reachable?            | **Only via `hooks.onResponse`.** Error, event stream and `.inspect().raw` all lose it |
| `c4-delegate-on-200.ts`         | does `throttle.delegate` trip on a 200?    | **No** (default `[429]`). `on: 200` trips on **successes** too                        |
| `c5-throttle-rate-cost.ts`      | can `throttle.rate` express a cost budget? | **No.** 10 calls the bucket takes instantly are spread over **18s**                   |
| `c6-assembled-solution.ts`      | can a user assemble correct behaviour?     | **Yes** — a custom `Surface`, **73 lines**, 8/8 queries survive a hostile neighbour   |

## Files

- `fake-shopify.ts` — the provider: a 1000-point leaky bucket refilling 50/s, per-operation cost,
  200-with-`THROTTLED` on over-spend, `extensions.cost` on **every** response, and `drain()` to
  simulate a third-party app spending the shop's shared bucket.
- `harness.ts` — `check` / `checkNear` / `note` / `heading` / `finish`. No test framework.
- `shopify-cost-surface.ts` — **user code** for C6: the `CostLedger`, the cost-aware `Surface`, and
  the `costGate` proactive hook.

## Reading the numbers honestly

- **C1(f) and C2(a2) are hacks, not seams.** Mutating `ctx.res.status` inside `onResponse` really
  does drive the retry matcher (the hook fires at `engine.ts:705`, the matcher reads at `:743`) —
  but it rewrites the status every later stage sees, and the final `StitchError.status` comes back
  as the invented `429` rather than the wire's `200`. They are measured because "I couldn't find the
  spelling" and "the built-in can't do it" are different claims, and both needed ruling out.
- **C2's `@ts-expect-error` blocks are the proof, not decoration.** A `@ts-expect-error` that is
  _not_ an error fails `tsc`. These files typecheck clean under `packages/core`'s full strict set,
  so every "this is a type error" claim is machine-checked.
- **C5's 18s is not a strawman.** `'1/2s'` is the _most generous_ spacing that never outruns a 50/s
  refill at 100 points per query. The comparison is against the same 10 queries with no throttle at
  all, which the 1000-point bucket absorbs at t=0.
- **C6 measures one process.** It proves the _logic_ is expressible on the public API. A deployment
  with several workers on one shop needs the ledger in a shared store — the surface seam is
  unchanged, but `CostLedger` would have to become async, and `interpret` is **synchronous**
  (`surface.ts:61-64`), so a distributed ledger cannot live inside it. That is a real limit of this
  design, not a detail.
- **C6(f)'s adapter alternative works but goes blind.** The engine reported `attempts: 1` and **0**
  `retry` progress events for a call that really made two requests and slept 6s, because the loop
  ran below the resilience chain. `timeout.total` does not bound it either.
