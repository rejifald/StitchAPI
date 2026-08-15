# Proofs — submit, poll, download: the async job triangle

Runnable evidence for the claims in
[`../../async-job-polling.md`](../../async-job-polling.md).

Every script is standalone, offline, and deterministic: it injects a fake three-endpoint job API
through StitchAPI's `adapter` seam and drives every wait off an injected `manualClock()`, so an
hour-long poll is exact **virtual** time — no real sleeping, nothing flaky, no network. The one
deliberate exception is C5(a), which measures `timeout.total`; that budget is wall-clock **by
design** (engine.ts:453-483), so it runs on real timers at 250ms with bounds set 4× clear of the
real numbers.

**The fake provider counts submissions.** `api.submits` is 2 if the client POSTed `/jobs` twice, so
"a duplicate job was created" is a measured number, not an argument — and `api.gaps(id)` is the
exact virtual spacing between polls, so "it honoured the server's pacing" is a list of integers.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/async-job-polling/c5-one-deadline.ts

# all of them
for f in docs/scenarios/proofs/async-job-polling/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path,
so they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set (the `@ts-expect-error` blocks are the
machine-checked half of several claims — a `@ts-expect-error` that is _not_ an error fails `tsc`):

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/async-job-polling/*.ts
```

## What each script establishes

| Script                      | Question                                   | Measured                                                                                                                                                        |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1-location-header.ts`     | can `Location` become the next call's URL? | **Yes, through `hooks`.** `POST /jobs → 3× GET /jobs/job-1` in ONE stitch, 1 submit. Nothing built-in follows it                                                |
| `c2-poll-surface.ts`        | can a `Surface` express the poll loop?     | **Yes.** 5 polls at 30s spacing, `attempts: 5`; `Failed` stops on the first terminal body with 17/20 unspent                                                    |
| `c3-retry-after.ts`         | can the wait come from `Retry-After`?      | **Not by itself.** `respect: true` gave 7ms, not 30s. The surface can read it — and `after: raw` is **1000× off**                                               |
| `c4-paginate.ts`            | can `paginate` express it?                 | **It loops** (capture refuted) — at gaps `0,0,0`. The natural `items` ends the run `ok` with `[]` after 1 poll                                                  |
| `c5-one-deadline.ts`        | ONE deadline over the triangle?            | **Yes, two ways.** `timeout.total` on a one-stitch triangle (251ms); or one `AbortSignal` through `linked`, whose abort now surfaces the caller's reason (#674) |
| `c6-linked-trace.ts`        | does `linked` draw one trace chain?        | **Yes.** 3 starts, 1 traceId, spans chained. But no operation-level span — a failure names the STEP                                                             |
| `c7-single-use-download.ts` | does `retry` hammer a spent link?          | **Not by default** (200,404). Widen `on` to 404 and it does (200,404,404,404). Per-stitch split works                                                           |
| `c8-resume.ts`              | can a stitch reattach after a restart?     | **Entirely user-side.** 0 store keys written; `cache` on the submit stops the dup and **loses the job id**                                                      |
| `c9-assembled-solution.ts`  | best answer, and is it worth it?           | 1 submit, 5 polls at the server's pacing, 1 download, resume, deadline — in **110 lines vs 49** hand-rolled                                                     |

## Files

- `fake-jobs.ts` — the provider. `POST /jobs` → **202** + `Location` (+ optional `Retry-After`);
  `GET /jobs/{id}` → **200** `{ state }` cycling `InProgress` then `JobComplete`/`Failed`;
  `GET <resultUrl>` → the payload, **single-use** (the second fetch 404s). Records every hit with
  the virtual timestamp, so `submits`, `polls(id)` and `gaps(id)` are all measurements.
- `harness.ts` — `check` / `checkAtMost` / `note` / `heading` / `finish`. No test framework.
- `job-triangle.ts` — **user code** for C9: `jobPollSurface()`, `retryAfterMs()`,
  `operationDeadline()` and `jobTriangle()`, the assembled answer.

## Reading the numbers honestly

- **C4 refutes the research capture, and the refutation is worse than the prediction.** The capture
  expected `paginate` to fail immediately because a job-status body has no items array. It does not
  fail: the default `items` wraps a non-array value as `[value]` (engine.ts:967-971), so
  `items.length` is 1 every round and the loop runs to a clean `next → undefined` termination. What
  it cannot do is **wait** — measured gaps `0,0,0`, and `PaginateOptions` has no `delay`/`backoff`
  field (machine-checked). Then C4(d) is the real trap: a caller who writes `items` to pull the
  result rows gets zero items on the first `InProgress` page, `paginated` breaks at engine.ts:984
  **before** consulting `next`, and the run ends `ok` with `data: []`, one poll, no error and no
  drift finding — while the job is still running server-side. Same bug shape as scenario 3's C2(d),
  reached from the opposite direction.
- **C3(c) is the sharpest footgun in this scenario, and it typechecks.** `SurfaceOutcome.after` is
  `number | string` and takes the house duration form, where a bare numeric string is
  **milliseconds**. `Retry-After` is delta-**seconds**. So `after: res.headers['retry-after']` —
  the obvious spelling, the one that reads correctly — polls **1000× faster** than the server asked
  (measured gaps `30,30,30` against the requested 30s). Nothing warns. Appending an `s` to the raw
  header is the only correct form, and the HTTP-date variant needs hand-written RFC 9110 parsing
  because `parseRetryAfter` is not on the public barrel (measured:
  `'parseRetryAfter' in barrel === false`).
- **C5(e) means you cannot test the thing this scenario is about.** `sleepWithin` compares
  `budget.deadline - now()` — **wall-clock** — and then sleeps on the **injected** clock
  (engine.ts:481-488). Virtual time therefore never consumes `timeout.total`: 60 polls across 59
  virtual seconds under a `total: '10s'` never tripped it. A `manualClock` test of "give up after an
  hour" passes while proving nothing, and any production code that injects a custom clock loses the
  budget silently.
- **C1(g) is the price of the one-stitch construction, and it is the same class of bug as scenario
  3's C7(f).** `HookContext` is `{ name, attempt, req?, res?, error? }` — no run id, no per-call
  slot — so the carried `Location` has to live in a closure on the **stitch**. Two concurrent calls
  measured: 2 jobs submitted, **job-1 polled zero times** (submitted, orphaned, running to
  completion unread), both callers handed job-2's result. It typechecks and it reads correctly.
- **C8(c) is the trap that looks like the fix.** `cache: { methods: ['POST'] }` over a shared store
  really does stop a restarted process re-submitting (1 submit across two processes). But a cache
  entry is the **value**, and a 202's value is `{}` — the `Location` is not in it — and a cache HIT
  short-circuits the request so `hooks.onResponse` never fires (measured: 1 firing across two runs).
  The duplicate is avoided by orphaning the job instead.
- **C7(d) is the cost of C5(a).** One stitch is one `retry` block, so the poll's patience is also the
  download's: a spent single-use link consumed all 8 shared attempts. The three-stitch `linked`
  shape gets this right (20 poll attempts, 1 download attempt) but gives up the single
  `timeout.total`. The two properties are not simultaneously reachable today.
- **C2(c)/C5(a) — every failure arrives as a `StitchError`, and only the deadline is typed
  underneath.** "The job failed", "I ran out of polls" and "the deadline fired" are `job failed: …`,
  `InProgress` and `timed out after 250ms`, with `error.status` `undefined` on all three. The deadline
  is the one you can now tell apart structurally: the engine's live `TimeoutError` rides `error.cause`
  (measured in C5(a): `cause.constructor.name === 'TimeoutError'` — the class is unexported and its
  `.name` is plain `'Error'`, so it is a constructor-name check, not `instanceof`). The other two
  carry no cause; telling them apart still means matching strings. And since #674 an abort surfaces
  the **caller's own reason** — C5(d)'s flow rejected with `job budget exhausted` and C9(c)'s with
  `job budget of 3600000ms exhausted`, where both used to arrive as a minted `aborted`.
- **C9's line counts are the honest comparison.** 110 executable lines for `jobTriangle` + the poll
  surface + the deadline + the header parse, against 49 for the hand-rolled `while` (the header
  parse is counted on **both** sides — a correct `while` needs it too). The wire behaviour is
  byte-identical. What the extra 61 lines buy is measured: one `start`/`done` per hop with the polls
  folded in as `attempts: 3`, one traceId chaining `job-submit → job-poll → job-download`, a per-hop
  retry policy, and `throttle`/`circuit` wrapping every hop.
