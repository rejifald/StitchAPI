# Proofs — batch endpoints that report per-item failure inside a 200

Runnable evidence for the claims in
[`../../batch-partial-failure.md`](../../batch-partial-failure.md).

Every script is standalone, offline, and deterministic: it injects a fake DynamoDB
`BatchWriteItem` / Elasticsearch `_bulk` through StitchAPI's `adapter` seam and drives every wait
off an injected `manualClock()`, so the gaps below are exact virtual time — no wall-clock sleeps,
nothing flaky, no network. The one deliberate exception is C7(d), which measures `timeout.total`;
that budget is wall-clock **by design** (engine.ts:482), so it runs on real timers with bounds set
4× clear of the real numbers.

**The fake providers count writes per item.** `db.writeCount('a')` is 3 if the client wrote row `a`
three times, so "the retry re-applied rows that had already succeeded" is a measured number
(`duplicateWrites`), not an argument.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c1-retry-replays-the-batch.ts

# all of them
for f in docs/scenarios/proofs/batch-partial-failure/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path,
so they test the working tree, not the published bundle.

## What each script establishes

| Script                          | Question                                       | Measured                                                                                                           |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `c1-retry-replays-the-batch.ts` | can built-in `retry` handle a partial failure? | **No.** 1 request under `attempts: 5`; forced with `on: 200` it replays all 5 items — **6 duplicate writes**       |
| `c2-paginate-residue-loop.ts`   | can `paginate.next` resend only the residue?   | **Yes** — 3 requests, **0 duplicates**, all 6 rows land. But a zero-item page ends the run **ok** with 4 rows gone |
| `c3-backoff-between-pages.ts`   | can anything wait between rounds?              | **No built-in.** 6 rounds at t=0; `throttle` gives a **fixed** spacing only; growth = user code in a hook          |
| `c4-surface-rewrite.ts`         | can a `Surface` rewrite the request?           | **No** — `SurfaceOutcome.retry` resends the identical body (4 duplicates). **`hooks.onRequest` can**               |
| `c5-terminal-vs-retryable.ts`   | can 429 and 400 per-item failures be split?    | **Yes** — the 400 doc is sent **once**, vs **5×** for "resend everything that failed"                              |
| `c6-residue-reachability.ts`    | when it gives up, where is the residue?        | **Nowhere the engine owns.** ok result, no error, absent from events/trace/`inspect`/`report`                      |
| `c7-assembled-solution.ts`      | what is the best answer, and is it worth it?   | 4 rounds, 0 duplicates, exponential wait, residue returned as data — in **50 lines vs 28** hand-rolled             |

## Files

- `fake-batch.ts` — the providers. `FakeDynamo` answers `200 { Processed, UnprocessedItems }` and can
  be driven by a real **write-capacity bucket** refilling off the clock (AWS's actual cause of
  `UnprocessedItems`, so "retry immediately and you throttle again" is measurable). `FakeElastic`
  answers `200 { errors: true, items: [{ index: { status } }] }` with a mix of `429` and `400`.
  Both count writes per item.
- `harness.ts` — `check` / `checkAtMost` / `note` / `heading` / `finish`. No test framework.
- `batch-retry-surface.ts` — **user code** for C7: `batchRetry()`, the `Surface` + `hooks` + ledger
  triple that carries the assembled solution.

## Reading the numbers honestly

- **C2(d) and C6 are the same bug seen twice, and it is the scenario's own failure mode.**
  `paginated` breaks on `items.length === 0` **before** calling `next` (engine.ts:984), and breaking
  on `page >= max` falls straight through to the `result` event. Both end the call **successfully**
  with the residue discarded. A batch endpoint answers "nothing landed this round" exactly when the
  table is out of capacity — the normal case AWS tells you to back off from — so this is not an
  exotic corner. It is elastic/logstash#1631 reproduced inside the library that was supposed to fix it.
- **C6(g) is worse than "incomplete".** The obvious place to build a residue ledger is `paginate.next`,
  and it is **wrong**, not merely short: on a 3-round run capped at 3, `next` sees the residue after
  rounds 1 and 2 only, so it reports `cdef` when the true residue is `def`. It names a row that
  landed. `hooks.onResponse` sees every response and reports `def`.
- **C3's "no backoff" is a property of the type, not just the run.** The `@ts-expect-error` blocks on
  `paginate: { delay }` / `{ backoff }` and `throttle: { backoff }` are machine-checked: a
  `@ts-expect-error` that is _not_ an error fails `tsc`, and these files typecheck clean under
  `packages/core`'s full strict set.
- **C3(c)'s exponential curve is user code, and the engine goes blind to it.** A sleep in an async
  `onRequest` hook really does pace the rounds (0, 100, 300, 700, 1500, 3100 ms), but no `throttled`
  event fires and no `waited` is reported: the run says it never waited while 2.5s of virtual time
  passed. A `throttle` wait of the same length is reported.
- **C4(a) refutes scenario 2's answer for this scenario.** `SurfaceOutcome.retry` + `after` was the
  seam that solved the cost-limit case. Here it is actively harmful: the re-attempt resends the same
  six items, so it re-applies the rows that already succeeded. The seam that works is a _hook_.
- **C7(f) is the footgun the assembled solution ships with.** The ledger lives on the stitch, so two
  concurrent calls through one stitch cross-contaminate: measured, both callers were handed the
  other batch's items, both resolved `ok`, and rows `b` and `c` were never written by anybody. It
  typechecks, it reads correctly, and it silently loses data — the same class of bug the scenario is
  about.
- **C7(g)'s line counts are the honest comparison.** 50 lines for the loop alone (types and options
  excluded; 71 for the whole file) against 28 for the hand-rolled `while`. What the extra 22 lines
  buy is measured, not asserted: one `start` event instead of three, `attempts: 3` instead of three
  calls each reporting `attempts: 1`, a circuit that opens on a broken host, and `timeout.total`
  bounding the whole operation instead of each round.
