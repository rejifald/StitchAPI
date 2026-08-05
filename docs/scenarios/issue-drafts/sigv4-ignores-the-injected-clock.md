# Issue draft — SigV4 signs with `new Date()`, and a skew 403 opens the dependency's breaker

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`expiring-signatures`](../expiring-signatures.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `aws-sigv4`, `testing`, `resilience`

> **Leading with what the library gets right**, because it is the headline of this scenario and
> it is a genuine design property: **a StitchAPI throttle cannot expire a signature.**
> `acquireWithin` (`engine.ts:629`) sits _above_ `cfg.auth.apply` (`:649`) inside the attempt
> loop, and `cloneReq` gives each attempt fresh headers off the unsigned base. Measured: 4 calls
> behind `rate: '1/2m'`, granted at 0/2/4/6 virtual minutes, signature ages **0, 0, 0, 0 ms**,
> all `200` — where the same calls pre-signed (the botocore#149 shape) aged 0/2/4/**6 min** and
> the last got a `403`. The breaker doesn't queue a signed request either: 3 blocked calls, **0**
> signings. [botocore#149](https://github.com/boto/botocore/issues/149) cannot happen here.
>
> Three findings sit beside that.

Reproduce:

```bash
for f in docs/scenarios/proofs/expiring-signatures/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `hooks.onRequest` runs after signing, so a hand-rolled gate there re-creates the bug

**Severity: medium-high — it re-introduces a defect the library is otherwise immune to.**

`onRequest` (`engine.ts:652`) is the only user-code seam that runs **after** `auth.apply`
(`:649`). Anyone who paces calls with a sleep in `onRequest` — a plausible thing to write, and
the obvious place to put a custom gate — signs first and waits second.

Measured: a 6-minute wait in `onRequest` aged the signature **6 minutes** and the request came
back `403`. The identical wait expressed as `throttle` aged it **0 ms**.

**Ask:** a line in the hooks guide saying `onRequest` runs post-auth and must not block, with a
pointer to `throttle`. Better: emit an `info` when an `onRequest` hook's duration exceeds some
threshold on a stitch carrying `auth` — the engine already has the precedent of warning about an
undrawable upload-progress bar (`engine.ts:1694-1698`).

## 2. SigV4 signs with `new Date()` rather than the injected clock

**Severity: medium — a testability defect, not a wire defect.**

`aws-sigv4/src/index.ts:244-249, 301` calls `amzDateOf(new Date())`. On real time the stamp is
correct, so nothing is wrong on the wire. But it means **SigV4 behaviour cannot be tested on a
virtual clock**:

- 600 virtual seconds moved the shipped stamp **0 seconds** (a clock-reading signer moved 600).
- Under a default `manualClock()`, **0 of 3** calls were accepted — ~20,670 days of apparent
  skew, because the virtual clock starts at epoch while the server's validation reads real time.

Every proof in this scenario had to inject its own clock-reading signer to measure anything.

**This is the third instance of one inconsistency.** `timeout.total`
([scenario 4](clock-and-diagnostic-side-effects.md)) and `cache.ttl`
([scenario 6](cache-cannot-revalidate.md)) also read wall-clock while their neighbours use the
injected `clock`.

**Ask:** thread the stitch's `clock` into the signer. And — the standing request from the earlier
two drafts — **audit which time-driven features read the injected clock and which read
`Date.now()`, and state the answer in the testing guide.** Three point fixes are worth less than
one documented rule.

## 3. A skew 403 counts as a circuit failure

**Severity: medium — a fault inside your process opens the dependency's breaker.**

A bad status reaches `attemptWithCircuit` as a throw (`engine.ts:824-831`), so
`RequestTimeTooSkewed` — which means _your clock is wrong_ — is recorded against the vendor.
Measured with `circuit` configured: `["403", "403", "503", "503"]`. The half-open probe then
surfaces `RequestTimeTooSkewed` rather than the fault that opened the breaker, so the trace
misattributes a local problem to the remote one.

**And the config recipe that fixes the analogous 401 case does not transfer.**
`verdict: { accept: [403], flag: 'ok' }` — which [scenario 9](resilience-has-no-tenancy.md)
measured working for a credential 401 — **swallows** the skew error here: `ok: true`, with
`RequestTimeTooSkewed` handed to the caller as data. The reason is `verdict.flag`'s three-state
absent rule (`surface.ts:174-191`): AWS error bodies carry no flag, and an absent flag is "no
signal".

That is the **third sighting** of the absent-flag rule producing a silent success — see
[`body-verdict-footguns`](body-verdict-footguns.md) (a THROTTLED envelope returned as data) and
[`paginate-cannot-report-a-partial-run`](paginate-cannot-report-a-partial-run.md)
(`flag: 'UnprocessedItems'` inert because arrays are truthy). Six lines of `Surface.interpret`
fix it, as they did in both earlier cases.

**Ask:** either a way to mark a status as "client fault, don't count it against the dependency",
or documentation that credential/clock 4xxs should be excluded from the breaker — the same ask as
scenario 9's §5, now with a second instance.

## 4. Smaller findings

- **`refresh` cannot see the response that triggered it.** Skew correction works —
  `shouldRefresh`/`refresh` learned a 600,000 ms offset from the `Date` header and re-signed the
  **same attempt** to a `200`, costing no retry budget — but the offset has to be smuggled out of
  `shouldRefresh` through a closure, because `refresh(ctx)` receives no response. Passing the
  triggering response to `refresh` would make this a clean 10 lines instead of 26.
- **A breaker does not shed a burst already queued behind a throttle.** The circuit phase is read
  at `engine.ts:863`, before the throttle wait at `:629`. Measured: 4 concurrent calls all reached
  the wire over 6 minutes _after_ the breaker opened; the same 4 issued sequentially stopped after 2. Defensible, and worth documenting — "the breaker gates entry, not the queue".
- **`backoff.max` defaults to 10 s**, so `base: '6m'` silently waits 10 seconds
  (`resilience.ts:47,56`). Protective in this scenario — it cost the proofs a false negative — but
  this is the **fourth** silent-clamp/silent-ignore in the pass (see
  [`void-call-drops-work`](void-call-drops-work.md) §2).
- **A skew 403 is _not_ retried by default** — measured 1 request with `attempts: 4`, because 403
  isn't in the default `on` set. That is the correct behaviour and worth keeping.
