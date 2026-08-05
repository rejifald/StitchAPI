# Scenario: the migration you have to run twice

**Researched:** 2026-08-05 · **Status:** ✅ verified (8 claims, 142 checks, offline) · page shipped
**Slug:** `dual-run-migration`

---

## The use case

Your vendor is retiring v1. [Scenario 17](deprecation-headers.md) is how you found out; this is
what you do next. You cannot flip to v2 on faith, so you run both against real traffic, compare
the answers, and cut over when the diff is quiet.

## Why it is not straightforward

**Every shadow-traffic guide in the field is written for the service owner.** The standard
architecture is _"Client → API Gateway → Primary Service (v1) with mirrored requests to Shadow
Service (v2)"_, mirroring at the proxy, with a shadow database alongside. You own the gateway,
both services, and both datastores.

**As the consumer of a third-party API you own none of that.** Which changes every term:

- **There is no proxy to mirror at.** The duplication has to happen in your own client code, on
  the call path, which is exactly where you cannot afford it to go wrong.
- **The shadow spends the vendor's meter, not yours.** Mirroring 100% of traffic doubles your
  rate-limit consumption and your bill. The advice — _"shadow a portion of production traffic…
  and sample heavily"_ — is a cost control, not a statistical one.
- **You cannot shadow a write.** A mirrored `POST /charges` charges the customer twice. The
  entire technique is read-only, and the writes are the calls you are most afraid of migrating.
- **The shadow must not be able to hurt the primary.** A slow or failing v2 must not add latency,
  must not fail the user's call, and must not consume the retry/circuit budget the primary
  depends on.
- **Telling a real diff from a benign one is the actual work.** The guidance is explicit that a
  good implementation needs _"a relevancy model to decide which differences matter and which are
  benign noise, like timestamps or reordered fields."_ A v2 that renames `created` to
  `created_at`, returns ISO instants instead of epochs, and orders an array differently is
  **correct** — and diffs on every single call.

## Evidence this bites real projects

- **The canonical architecture, and its assumptions** —
  [Safely replacing production services using shadow traffic](https://medium.com/@sonishubham65/safely-replacing-production-services-using-shadow-traffic-with-istio-on-kubernetes-57c0516602e2)
  (Istio, mirrored at the mesh) and
  [Gloo Edge shadowing](https://docs.solo.io/gloo-edge/latest/guides/traffic_management/request_processing/shadowing/).
  Both mirror at infrastructure you must own.
- **The relevancy problem, named** —
  [What is shadow testing?](https://www.signadot.com/blog/shadow-testing-superpowers-four-ways-to-bulletproof-apis/):
  outputs are diffed to surface regressions, and a good implementation distinguishes real
  differences from benign noise like timestamps and reordered fields.
- **Sample heavily, redact** — the same source, on shadowing a portion of traffic into a canary.
- **Dual-write is the write-side analogue** —
  [Dark launch patterns](https://oneuptime.com/blog/post/2026-01-30-dark-launch-patterns/view):
  dark launches "shine during database migrations where you can write to both and verify
  consistency" — which is precisely the thing a third-party consumer cannot do.

## The common solutions, and what each costs

| Approach                      | What it is                                   | Where it breaks                                                                         |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Mirror at the gateway**     | Proxy duplicates the request.                | The standard answer, and unavailable when the endpoint is someone else's.               |
| **Dual-call in the client**   | Issue both, return v1, log the diff.         | Available to you, and now the shadow is inside your latency and failure budget.         |
| **Offline replay**            | Capture v1 traffic, replay against v2 later. | No user impact, and no live comparison — you find out at replay time, not at call time. |
| **Diff in a batch job**       | Log both, compare nightly.                   | Cheap and slow. A regression lives a day.                                               |
| **Trust the changelog**       | Read the migration guide, flip.              | Free, and the reason this scenario exists.                                              |
| **Sample a small percentage** | Shadow 1–5% of reads.                        | The cost control that makes it viable. Needs a spelling.                                |

**Summary of the state of the art:** duplicate reads only, sample them, keep the shadow strictly
off the primary's critical path, and put most of your effort into a comparison that ignores
differences you already know about.

---

## What to verify against StitchAPI

Two findings from earlier iterations make specific, testable predictions here, and both are
**pre-registered** so the proofs can refute them on the record.

1. **The combinators broadcast one input.** [Scenario 10](provider-failover.md) measured
   `runMember` (`pipe.ts:75-86`) building every member's input from the one group input — the
   basis of [#643](https://github.com/rejifald/StitchAPI/issues/643). A dual-run is the case that
   needs the opposite: v1 and v2 differ in path, parameter names and body shape, so **the
   combinator that looks purpose-built for this is the one already measured to be wrong for it.**
2. **Resilience state is shared unless keyed by hand.** [Scenario 9](multi-tenant-blast-radius.md)
   measured a 9-of-9 blast radius when one principal's failures opened a shared breaker
   ([#641](https://github.com/rejifald/StitchAPI/issues/641)). If a flaky v2 shadow shares a
   circuit or throttle with v1, **the experiment can take down the thing it was protecting** —
   the worst possible failure for a safety mechanism.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Can the shadow be made unable to hurt the primary? Measure four
   channels separately: added **latency**, a **thrown** shadow error reaching the caller, the
   shadow consuming the **retry** budget, and the shadow's failures opening a **circuit** the
   primary uses. Report which need explicit config and which are safe by default.
2. **C2** — **DECIDING CLAIM.** Can the two calls take **different inputs**? Try `all`/`any`, a
   plain `Promise.all`, `linked`, and `.with()`. If the combinators cannot express it, measure
   what the working spelling costs.
3. **C3** — is there a **comparison** primitive? `drift()` is schema-anchored (response vs
   contract) — can anything compare **response vs response**? What is the minimum hand-written
   comparator?
4. **C4** — the relevancy problem: can "ignore `updated_at`, ignore array order, treat
   `created` ≡ `created_at`" be expressed declaratively, or is it all user code? Measure the diff
   noise on a realistic v1→v2 rename + retype + reorder.
5. **C5** — **writes**: is there any guard that prevents a shadowed non-GET? What is the cheapest
   construction that makes shadowing a write impossible rather than merely discouraged?
6. **C6** — **cutover**: can v1→v2 be flipped without a redeploy? (Scenario 19 measured a
   `baseUrl` thunk retargets between calls — does that extend to a whole different stitch?)
7. **C7** — **cost**: does the shadow double rate-limit consumption? Is sampling ("shadow 5% of
   reads") expressible, and does a shared `throttle` correctly account for both?
8. **C8** — assemble the safest dual-run; report seams, line count, and what it costs.

C1 and C2 decide this. C1 is the safety property that makes the technique usable at all; C2 is
where the pre-registered suspicion says the obvious tool will fail.

---

## Verification result

**All 8 claims verified**, 142 checks across 8 scripts, re-run by me before writing up.

| Claim                             | Verdict                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| C1 — can the shadow be isolated?  | **PARTIAL** — 1 of **5** channels safe by default (there are five, not four) |
| C2 — different inputs per member? | **CONFIRMED as predicted** — the shadow got `/v2/customers`, no id           |
| C3 — a comparison primitive?      | **PARTIAL** — two exist in the tree, neither exported                        |
| C4 — the relevancy problem        | 7 raw diff ops on a _correct_ v2; `ignore` is suppression, not relevancy     |
| C5 — write guard                  | None exists; 8-line Adapter wrapper gives 0 of 3 shadow writes               |
| C6 — cutover                      | Thunk moves the whole path, not just the origin; real cutover is 4 lines     |
| C7 — cost                         | Exactly **2.000×**; sampling is 5 lines of user code                         |
| C8 — assembled                    | **69** executable lines, 5 seams; naive 0-of-4 vs safe 4-of-4                |

### Both pre-registered predictions

**[#643](https://github.com/rejifald/StitchAPI/issues/643) — CONFIRMED.** `runMember` broadcasts
one input; the shadow's literal URL was `/v2/customers` with no id, and supplying v2's parameter
name made v1 send `/v1/customers/cus_7Q2?customer_id=cus_7Q2`.

**[#641](https://github.com/rejifald/StitchAPI/issues/641) — CONFIRMED IN 2 OF 5 CONFIGS, AND
REFUTED AS I STATED IT.** Sharing is _not_ the default. It is a **key collision**: identity is
`(store) × ('circuit:' + (circuit.key ?? name ?? path ?? 'stitch'))`. Standalone and
seam-with-distinct-paths both isolate correctly. The two that break — a seam with the **same
path**, and `pool: 'host'` — are both ordinary dual-run shapes, because v1 and v2 usually share a
path and differ by base URL, and are usually on the same host. The sharper statement is better
than my prediction and worth carrying forward over it.

### Other hypotheses that were wrong

- **"Four isolation channels."** There are five. The one I missed — `all()` **cancelling the
  in-flight primary** when the shadow settles first — is the most dangerous of them.
- **"A thunk moves only the base URL."** `url` is also a thunk and carries the complete path,
  with `{param}` interpolation still applying.
- **"There is no comparison primitive."** There are two, `diff` and `classifyDiff`; they are
  simply unreachable from all 17 subpaths.
- **"A shared `throttle` won't account for both."** Seams pool correctly by default.

### Outputs

- Page: [dual-run-migration.mdx](../../apps/docs/content/docs/scenarios/dual-run-migration.mdx)
- Draft: [diff-primitives-are-unreachable](issue-drafts/diff-primitives-are-unreachable.md)
