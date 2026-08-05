# Issue draft — three silent failures when the failure signal lives in the response body

**Status:** ✅ **FILED** as [#651](https://github.com/rejifald/StitchAPI/issues/651)
**Scenario:** [`cost-based-rate-limits`](../cost-based-rate-limits.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `resilience`, `footgun`

> The scenario came out **achievable** — a custom `Surface` closes it in 73 lines
> (`proofs/cost-based-rate-limits/c6`). These three findings are separate: each one
> typechecks, looks right, and silently does the wrong thing. Ordered by blast radius.

All three were measured offline. Reproduce with:

```bash
for f in docs/scenarios/proofs/cost-based-rate-limits/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `verdict.flag` returns `ok: true` and hands the caller an error envelope

**Severity: high — silent data corruption, no error anywhere.**

`verdict.flag` is the one built-in that reads the **body** to decide success, so it is the
natural reach when an API reports failure in a 200. On a payload that omits the flagged path
entirely, an absent path is treated as "no signal", the 200 stands, and the call succeeds.

Against a Shopify `THROTTLED` response — HTTP 200, `{ errors: [{ extensions: { code:
'THROTTLED' } }] }`, no `data` key — a stitch with `verdict: { flag: 'data.ok' }` returned
**`ok: true`** and handed the caller the THROTTLED envelope as its result. Downstream code
processes an error object as a successful sync. There is no throw, no drift finding, and
nothing in the trace that reads as wrong.

Measured in `c1-retry-on-200-throttled.ts` (e).

**Ask:** absent-vs-falsy should not be the same verdict. Either treat a missing flag path as
a failure (or a distinct `unknown`), or emit a drift/health signal when the path a verdict
depends on is not present in the body at all. The current behaviour is the least safe of the
three options and is not stated in the guide.

## 2. ~~`.safe()` downgrades `RateLimitError` and drops the body~~ — FIXED

**Severity: medium — an outer rate-gate backs off blind.**
**Status: ✅ fixed by [#662](https://github.com/rejifald/StitchAPI/pull/662).**

With `throttle: { delegate: true }`, `await call()` throws a real `RateLimitError` whose
`.body` carries the payload — for Shopify, `extensions.cost.throttleStatus`, i.e. exactly the
numbers an outer gate needs to pace itself.

`call.safe()` returned a plain `StitchError` where **`error.body` was `undefined`**.
`asStitchError` copied only message/status/cause, so the payload survived only at
`error.cause.body`.

The delegate-backoff guide's whole premise is handing back-pressure to something outside the
stitch. A consumer that follows the codebase's own preference for `.safe()` over `try/catch`
read "there was no body" and lost the pacing information.

Measured in `c4-delegate-on-200.ts` (b2).

**Ask:** preserve `body` (and `retryAfter`) across `asStitchError`, or document that
`delegate` requires `try/catch` rather than `.safe()`.

**Resolution.** Neither — the coercion itself was the bug. `asStitchError` existed only because
`RateLimitError` and `StitchError` were **siblings** while `SafeResult.error` is typed
`StitchError`, so the safe path had no choice but to downgrade. #662 makes `RateLimitError`
extend `StitchError`, so `.safe()` returns the very instance `await` throws: `instanceof`,
`body`, `retryAfter` and `response` all behave identically on both paths, and nothing hides on
`.cause`. The `(b2)` proof block now measures that — 19/19.

One migration note for anyone branching on both classes: **test `RateLimitError` first**, since
a leading generic `instanceof StitchError` arm now catches it.

## 3. `backoff` as a function typechecks-then-vanishes

**Severity: low — but the failure is silence, not an error.**

`backoff` accepts `BackoffCurve | AtLeastOne<BackoffOptions>` — no function form. Passing
`backoff: () => 6000` is correctly a **type error**. But casting past it (which people do when
they believe a feature exists) does not throw: the function is **never invoked**, and delays
silently fall back to the default curve — measured gaps of `100, 200` ms where the intended
wait was `6000`.

Measured in `c2-computed-wait.ts` (a2).

**Ask:** throw at construction on an unusable `backoff` value, the way an unparseable
`throttle.rate` already does (`bad rate: …` is thrown at construction — good precedent, worth
matching). Silently degrading a resilience policy is the one place a fallback is worse than a
crash.

---

## Context worth keeping

The scenario that surfaced these is a body-reported quota, and the correct answer turned out
to be a custom `Surface` — `interpret` + `SurfaceOutcome.after` (`surface.ts:34-37`, honoured
at `engine.ts:785-805`). That path works well and is public. The gap is that **nothing points
there**: `throttle`'s own doc comment (`types.ts:1018-1019`) sends readers to `delegate` for
vendor-accounted quotas, and `delegate` is status-keyed, so it does not reach this case. Three
of the four wrong turns above are what a reader tries _before_ finding the surface seam.

A pointer from the retry/throttle guides to "if the failure signal is in the body, write a
surface" would remove most of this class.
