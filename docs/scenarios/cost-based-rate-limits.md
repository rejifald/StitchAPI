# Scenario: cost-based rate limits reported in the response body

**Researched:** 2026-08-04 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `cost-based-rate-limits`

**Verification:** 6 proof scripts, run offline (125 checks), in
[`proofs/cost-based-rate-limits/`](proofs/cost-based-rate-limits/). Published page:
[`scenarios/cost-based-rate-limits.mdx`](../../apps/docs/content/docs/scenarios/cost-based-rate-limits.mdx).
Footguns escalated to a draft:
[`issue-drafts/body-verdict-footguns.md`](issue-drafts/body-verdict-footguns.md).

| Claim                                 | Verdict                              | Measured                                                                                                                                        |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — `retry` on a 200-with-THROTTLED  | FAIL                                 | predicate receives 1 arg (`200`); `on: 200` retried successes — 3 requests, 900 points for one call                                             |
| C2 — wait computed from the body      | FAIL for `backoff`, PASS via surface | `backoff` fn is a type error; cast past it, construction throws **`bad backoff`** (#666); `SurfaceOutcome.after` honored at exactly **6000 ms** |
| C3 — `extensions.cost` reachable      | PASS via one seam                    | `hooks.onResponse` only; `StitchError.body` undefined, `.inspect().raw` null on throttle                                                        |
| C4 — `throttle.delegate` on a 200     | FAIL                                 | status-keyed (default `[429]`); `on: 200` fires on successes too                                                                                |
| C5 — `throttle.rate` as a cost budget | FAIL                                 | points token throws at construction; 10 absorbable calls took **18,000 ms**                                                                     |
| C6 — assembled from the public API    | PASS                                 | custom `Surface`, **73 lines**, 8/8 succeeded against a neighbour draining the bucket                                                           |

**The framing below was wrong.** The pre-verification hypotheses correctly predicted C1–C5,
then concluded the built-ins failing might total to _not achievable_. They missed the seam that
actually solves it: a custom **`Surface`** whose `interpret` sees every body and whose
`SurfaceOutcome.after` carries a computed wait into the engine's own retry loop
(`surface.ts:34-37`, honored at `engine.ts:785-805`; ADR 0022 Decision 5). It is public and
exported. The real gap is not capability — it is that **nothing points there**: `throttle`'s
own doc comment sends readers to `delegate`, which is status-keyed and cannot reach a
body-reported quota.

Also refuted: `.inspect().raw` is not a route to the payload — post-`pick` on success, and
`null` on the throttled response despite `source: 'live'`.

**Re-verified 2026-08-15 against the rebased tree.** The silent half of C2 (a2) is gone:
[#666](https://github.com/rejifald/StitchAPI/pull/666) — the fix this audit's
[#651](https://github.com/rejifald/StitchAPI/issues/651) §3 asked for — makes an unusable
`backoff` throw `bad backoff` at construction, so the cast-past probe now pins the throw
(0 requests made, delay fn never invoked) instead of the silent degrade it originally measured.
The surface half is unchanged: `SurfaceOutcome.after` still honored at exactly **6000 ms**.
Row and proof re-recorded; suite re-run green (6 scripts, 125 checks).

---

## The use case

An app talks to the **Shopify GraphQL Admin API** — the canonical cost-based limiter, and
the one most teams meet first. The same shape appears in GitHub's GraphQL API (point cost),
Atlassian (cost budgets), and Salesforce (per-query governor limits).

The work is ordinary: sync products, backfill orders, respond to a webhook. What is not
ordinary is how the quota is accounted for.

## Why it is not straightforward

Shopify's limiter is a **leaky bucket denominated in query cost**, not requests: a 1,000-point
bucket refilling at 50 points/second. Four properties each break a different standard tool.

**1. The price is per-query and variable.** One request might cost 11 points, another 900.
"Requests per second" is not a meaningful unit here, so a fixed-rate limiter is either
wasteful or wrong — there is no single spacing that is correct for both queries.

**2. Over-spending answers `200 OK`.** Shopify returns HTTP **200** with a `THROTTLED` entry
in the GraphQL `errors[]` array — _not_ a `429`. Every retry policy keyed on status codes
sees success and returns the error to the caller. This is the single most-reported trap in
the scenario.

**3. The wait is arithmetic the server hands you, not a guess.** Each response carries
`extensions.cost` with `requestedQueryCost`, `actualQueryCost`, and a `throttleStatus` of
`{ maximumAvailable, currentlyAvailable, restoreRate }`. The correct wait is
`(requestedQueryCost − currentlyAvailable) / restoreRate` seconds. Exponential backoff with
jitter is strictly worse than the number already in the payload: it over-waits when the
bucket is nearly full and under-waits when it is empty.

**4. The bucket is the _store's_, not yours.** `currentlyAvailable` reflects every app
touching that shop. A third-party inventory app draining points makes your headroom drop
between two of your own requests
([Shopify/shopify-api-js#602](https://github.com/Shopify/shopify-api-js/issues/602)). No
amount of client-side bookkeeping can predict it — the budget must be re-read from every
response, which makes purely _proactive_ pacing insufficient on its own.

Put together: the signal is in the **body**, the unit is **cost**, the wait is **computed**,
and the budget is **shared**. A status-code-triggered, curve-based retry is the wrong shape
on all four axes.

## Evidence this bites real projects

- **Shopify SDK** — [`Shopify/shopify-api-js#602`](https://github.com/Shopify/shopify-api-js/issues/602):
  `currentlyAvailable` drops unexpectedly, because it is the shop's global bucket.
- **Shopify community** — ["limits per query is 1000 but I have 10000 cost available"](https://community.shopify.com/t/graphql-admin-api-rate-limits-limits-per-query-is-1000-but-i-have-10000-cost-available/192109):
  the per-query ceiling and the bucket size are different limits, routinely conflated.
- **Practitioner writeups** — [How Shopify's GraphQL rate limits actually work](https://dev.to/masadashraf/how-shopifys-graphql-rate-limits-actually-work-and-how-to-stop-getting-429d-3bnb)
  and [a production throttling strategy](https://no7software.co.uk/blog/shopify-graphql-query-cost-production-throttling)
  both lead with the same warning: it is a 200, not a 429.
- **Vendor docs** — [Shopify API limits](https://shopify.dev/docs/api/usage/limits).

## The common solutions, and what each costs

| Approach                                   | What it is                                                                       | Where it breaks                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry on 429 + exponential backoff**     | The default in every HTTP client.                                                | Never fires — the response is a `200`. Silently returns a THROTTLED error as data.                                                            |
| **Body-sniffing retry**                    | Inspect `errors[].extensions.code === 'THROTTLED'`, then back off exponentially. | Fires correctly, but ignores the arithmetic the server supplied — over- and under-waits by turns.                                             |
| **Compute the wait from `throttleStatus`** | `(requested − available) / restoreRate`, then retry.                             | Correct, and the state of the art. Requires reading `extensions` — which most GraphQL clients discard when they unwrap `data`.                |
| **Client-side cost ledger**                | Track spend locally, pre-emptively pause below a threshold (~200 points).        | Good for pacing your own traffic; cannot see other apps draining the shop's shared bucket, so it must still reconcile against every response. |
| **Fixed-rate limiter (`N/sec`)**           | Pace requests to a safe constant.                                                | Wrong unit. Sized for the worst-case query it wastes most of the quota; sized for the average it throttles on any expensive one.              |
| **Global queue with a single worker**      | Serialize all calls, pause the queue on deficit.                                 | Genuinely correct and common in production. Costs concurrency and a piece of infrastructure.                                                  |

**Summary of the state of the art:** read `extensions.cost.throttleStatus` off **every**
response (not just failures), retry on a _body_ condition, and wait the _computed_ deficit.
The pieces are simple individually; no mainstream HTTP client wires them together, because
each one needs the body to reach a place where retry decisions are made.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- `StatusMatch = number | number[] | ((status: number) => boolean)` (`types.ts:957`). The
  predicate receives the **status only** — never the body. So `retry.on` looks unable to fire
  on a 200-with-THROTTLED. Suspected structural gap #1.
- `backoff` is `BackoffCurve | BackoffOptions` — `'expo' | 'expo-jitter' | 'fixed'` plus
  `base`/`max` (`types.ts:958-963`). No custom delay function, so a wait computed from the
  body has no obvious way in. Suspected structural gap #2.
- `retry.respect` honors a `Retry-After` **header** (`types.ts:993-1002`). Shopify puts the
  number in the body instead.
- `throttle.rate` is a `"count/interval"` string and is explicitly _"a minimum spacing between
  successive calls … not a token bucket"_ (`types.ts:1006-1019`). Its own doc comment names
  this exact situation and points elsewhere: _"Where a real quota needs spending the way the
  vendor accounts for it, hand the backoff to an outer gate with `delegate`."_
- `throttle.delegate` (`types.ts:1046-1048`) is therefore the intended escape hatch — but its
  `on` is **also** a `StatusMatch`, defaulting to `[429]`. If it is status-keyed too, a 200
  THROTTLED will not trip it either, and the documented escape hatch does not reach this case.
- `graphql()` fixes `unwrap: 'data'` and treats `errors[]` as a failure (STITCH_GRAPHQL). Does
  `extensions` survive anywhere reachable — a hook, the error object, the event stream?

**Claims to test with runnable offline code:**

1. **C1** — can `retry` be made to fire on HTTP 200 carrying `errors[].extensions.code === 'THROTTLED'`?
2. **C2** — can the retry wait be **computed from the response body** (`(requested − available) / restoreRate`) rather than from a curve?
3. **C3** — is `extensions.cost.throttleStatus` reachable at all on a `graphql()` stitch — on success (`unwrap: 'data'`), and on the THROTTLED failure?
4. **C4** — does `throttle: { delegate: true }` trip on a 200-with-THROTTLED, or only on statuses?
5. **C5** — can `throttle.rate` express a _cost_ budget (1000 points, refill 50/s) at all?
6. **C6** — if the built-ins fall short: can a user assemble the correct behavior from the public surface (hooks, a custom adapter, `pipe`, delegate + an outer gate)? Write it, run it, and report how much code and which seam carried it.

The interesting outcome is **C6**. C1–C5 look like "no" from the types; whether that totals
to _not achievable_ or merely _achievable the hard way_ is what decides page vs. issue.
