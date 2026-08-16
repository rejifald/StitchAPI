# Issue draft — `timeout.total` is untestable with `manualClock`, and `.inspect()`/`.report()` re-issue the request

**Status:** ✅ **FILED** as [#652](https://github.com/rejifald/StitchAPI/issues/652)
**Scenario:** [`async-job-polling`](../async-job-polling.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `bug`, `testing`, `dx`

> Two independent findings, both in the "the tool tells you something untrue" class. The first
> makes a green test meaningless; the second gives a diagnostic method a side effect.

Reproduce:

```bash
for f in docs/scenarios/proofs/async-job-polling/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `timeout.total` goes silent under an injected clock — so its own test passes vacuously

**Severity: high — a green test proving nothing.**

`timeout.total` is compared against **wall-clock** time (`engine.ts:453-488`, and the comment
at `:482` says so explicitly: _"`timeout.total` stays on wall-clock"_), while every sleep in
the attempt loop runs on the **injected clock**.

Inject a `manualClock()` and the two disagree completely. Measured: **60 polls across 59
virtual seconds under `timeout: { total: '10s' }` never tripped the budget.** No error, no
event — the deadline simply never fires, because no wall-clock time passed.

This matters because [the testing guide](https://stitchapi.dev/docs/guides/testing/mocking)
recommends `manualClock` for exactly this class of behaviour: _"Retry backoff, throttle
pacing, and the per-attempt timeout are time-driven, so testing them used to mean real
waiting."_ `timeout.total` is time-driven and is **not** in that list — and a reader who
assumes it is writes a test for "give up after an hour" that passes without ever exercising
the deadline.

The scenario that surfaced it is the honest motivation: an hour-long job budget can only be
tested on a virtual clock. Today that test is guaranteed green and guaranteed meaningless.

**Ask:** put `timeout.total` on the injected clock, the way the sleeps already are. If
wall-clock is deliberate (a defensible choice — a virtual clock shouldn't let a real request
hang forever), then say so in the timeout guide _and_ in the testing guide's list, and
consider a warning when a `manualClock` and a `timeout.total` are configured on the same
stitch. Silence is the one option that can't be right.

## 2. `.inspect()` and `.report()` issue a fresh request — so they duplicate side effects

**Severity: high on non-idempotent stitches — measured, duplicate jobs.**

`.inspect()` and `.report()` read as diagnostics over a call that already happened. They are
not: each one performs the request again.

On a `GET` that is wasteful. On the `POST /jobs` that starts an async job it is a bug you pay
for in someone else's system. Measured: **one `.safe()` plus one `.inspect()` plus one
`.report()` submitted three jobs.** Two of them are orphans — nothing polls them, and they run
to completion server-side, consuming quota.

The naming is the whole problem. Nothing about "inspect" or "report" suggests a network call,
and the obvious debugging move on a failing submit — call `.inspect()` to see what came back —
is precisely the move that submits another job.

**Ask:** at minimum, document it prominently on both methods and in the errors/pitfalls page.
Better: have them replay the _last_ result when one exists, or refuse on a non-`GET` stitch
unless explicitly opted in (`inspect({ reissue: true })`).

---

## Smaller findings from the same verification

- **`after: res.headers['retry-after']` polls 1000× too fast.** `Retry-After` is
  delta-**seconds**; `SurfaceOutcome.after` reads a bare numeric string as **milliseconds**.
  Measured gaps of `30 ms` against a requested `30 s`. The correct spelling is
  `after: \`${raw}s\``. Two units, one field, no type friction — worth a line in the surface
docs, since a surface author reading `Retry-After` is the _expected_ use.
- **`parseRetryAfter` is not exported**, so every surface author must re-implement HTTP-date
  parsing. Without it the date form silently falls through to the computed curve — measured
  `7,7,7` ms where the server asked for 30 s. The engine already has this parser for the
  status-driven path; exporting it would make the body-driven path correct by default.
- **`retry.respect` does not reach the body-driven retry path at all** (`engine.ts:797-801`
  reads only `parseDuration(outcome.after)`; `:749-751` is where the header is read). Arguably
  by design, but a user who sets `respect: true` and gets the computed backoff has no signal
  that the setting is inert on that path.
- **`cache: { methods: ['POST'] }` as restart-safety orphans the job.** It does prevent the
  duplicate POST (measured: 1 submit across two processes), but the cached value of a `202` is
  `{}` and **a cache hit never fires `onResponse`** — so the `Location` is unrecoverable and
  the job is lost. This is a plausible thing to try; it half-works, which is the dangerous
  amount.
- **A surface that omits `verdictOf` returns HTTP errors as successes** — measured: a 404 came
  back `ok: true` with `data: { message: 'unknown job …' }`. Every scenario in this pass that
  wrote a surface had to remember `verdictOf` first. If composing the declarative verdict is
  mandatory for correctness, consider doing it in the engine rather than by convention.
