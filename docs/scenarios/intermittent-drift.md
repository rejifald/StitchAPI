# Scenario: the vendor changed the shape for 5% of responses

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `intermittent-drift`

**Verification:** 8 proof scripts, run offline (142 checks), in
[`proofs/intermittent-drift/`](proofs/intermittent-drift/). Published page:
[`scenarios/intermittent-drift.mdx`](../../apps/docs/content/docs/scenarios/intermittent-drift.mdx).
Escalated: [`issue-drafts/drift-cannot-grade-a-coercion.md`](issue-drafts/drift-cannot-grade-a-coercion.md).

| Claim                        | Verdict                              | Measured                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — added field             | quiet, as it should be               | one `info \| undeclared`; 51 added values across 50 array elements collapse to **2** findings; `ignore` silences it. But the value is **stripped** from `data`                                                  |
| C2 — removed field           | caught, **conditionally**            | `error \| invalid` + failed call — _if required_. `.optional()` → zero findings; `.default()` → a fabricated value at `verbose`                                                                                 |
| C3 — the $0-transaction test | **capture half REFUTED, half worse** | default is **safe**: `z.number()` on `"12345"` fails; `z.coerce.number()` on `"abc"` fails. But `z.coerce.number()` on `null` → **`0`** with no `.catch()`, and the finding is byte-identical to the benign one |
| C4 — 5% null                 | precision excellent, level missing   | fired on exactly calls `[20,40,60,80,100]`, naming the field. But `.nullable()` → **nothing**, so the rollout is invisible                                                                                      |
| C5 — declarative severity    | partly, keyed on the wrong axis      | the 3 soft kinds re-level in one literal; only _addition_ maps 1:1 to a change class; no per-path severity                                                                                                      |
| C6 — aggregation             | **capture REFUTED — it works**       | `5.0% of calls … (5/100, 5 landed 0)`, and a rolling window widening **5.0% → 25.0%**                                                                                                                           |
| C7 — actionability           | depends entirely on the accessor     | path always; `await`/`.safe()` carry **nothing** for a soft finding; the trace sink for the same run named the field and both types                                                                             |
| C8 — assembled               | PASS                                 | 6 workloads × 100 calls, **zero $0 charges**; the soft schema produced **ten**. 93 lines vs 92                                                                                                                  |

**Two hypotheses refuted, and both in the library's favour — a first for this pass.**

- The capture feared StitchAPI would silently coerce a type change into a plausible value. It
  does not: the default rejects, and even `z.coerce.number()` refuses `NaN`. The $0 charge is
  reachable only through two spellings the _user_ writes.
- The capture predicted aggregation would be the gap, citing every prior scenario's failure to
  find cross-call state. Wrong: `TraceSink` + `ctx.spanId` is the one place in the library where
  cross-call state is the design rather than a leak.

**What survives.** A `coerced` finding is `kindOf(old) -> kindOf(new)` with no values, so
`"12345" → 12345` and `"abc" → 0` are indistinguishable; and the fourth industry change class
("nullable is a warning, value intact") has no spelling — the hand-rolled classifier beats
`DriftOptions` on exactly that row.

---

## The use case

A vendor ships a change to their response shape. Not all at once — **gradually**. A canary at
5% of traffic, then 25, then 50. Or not a rollout at all: the shape simply differs _by data_ —
a geocoder that returns `null` for `formatted_address` only on ambiguous queries.

Either way your integration sees the new shape on **some** calls and the old shape on the rest.

## Why it is not straightforward

**Intermittent breakage is harder than total breakage.** A change that breaks 100% of calls is
found in minutes and rolled back. A change that breaks 5% produces a trickle of odd errors
that looks like flakiness, sits in the backlog for a week, and is fixed only after someone
notices the pattern.

The change classes are not equal, and treating them alike is the mistake:

- **A field is added** — non-breaking by every published policy. Should produce no alarm at all,
  or you get alarm fatigue on every vendor release.
- **A field is removed** — breaking. Must be loud.
- **A field's type changes** — breaking, and the _dangerous_ one, because a naive cast produces
  a **plausible** value. The canonical example: a payment provider changes `transaction_id`
  from integer to string, code casts to int, gets `0`, and processes a **$0 transaction**.
- **A field becomes nullable** — warning-level, and the most intermittent of all, because it
  only shows up on the data that triggers the null. The geocoding `formatted_address` case is
  exactly this: nothing is wrong until a query happens to be ambiguous.

Then the operational problem, which is the one this scenario is really about:

- **One finding per call is not a signal.** During a canary you get a drift finding on 5% of
  calls. To act you need to know _this is trending_ — 5% yesterday, 25% today — which requires
  **counting across calls**. A per-call event carries no memory.
- **And you need it to be actionable at 3am**: which field, what was expected, what arrived.
  "Validation failed" is not enough to page someone about.

## Evidence this bites real projects

- **The `transaction_id` int→string → `$0` transaction** and the **geocoder returning `null`
  for `formatted_address` on ambiguous queries** are both given as canonical schema-drift
  failures in [Your API tests are lying to you: the schema drift problem nobody talks
  about](https://dev.to/qa-leaders/your-api-tests-are-lying-to-you-the-schema-drift-problem-nobody-talks-about-4h86).
- **The change taxonomy is industry-standard** — [LinkedIn's breaking-change
  policy](https://learn.microsoft.com/en-us/linkedin/shared/breaking-change-policy?view=li-lms-2024-06)
  and [Xandr's](https://learn.microsoft.com/en-us/xandr/digital-platform-api/breaking-changes)
  both classify removal and type change as breaking, and _addition_ as explicitly non-breaking.
- **Nullable-without-notice** is called out repeatedly as its own class: a field becoming
  nullable is warning-level, not breaking, and is the one that hides in the data.
- **Canary rollouts are standard practice** ([Google SRE](https://sre.google/workbook/canarying-releases/),
  5–10% → 25 → 50 → 100), and the write-ups note the limitation directly: canarying a
  _response-schema_ change doesn't protect the client, it just makes the breakage partial.

## The common solutions, and what each costs

| Approach                            | What it is                                                   | Where it breaks                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Strict schema validation**        | Reject anything that doesn't match.                          | Catches everything — including the _added field_ that broke nothing. Every vendor release becomes an outage.       |
| **Parse loosely, cast defensively** | `Number(x) \|\| 0`, optional chaining everywhere.            | Never alarms, and manufactures the `$0` transaction. The failure moves from the boundary into your business logic. |
| **Contract tests in CI**            | Assert the shape against a recorded fixture.                 | Catches it before deploy — and the vendor changed _after_ your deploy. CI can't see a canary in production.        |
| **Level the findings**              | Additions info, nullability warn, removal/type-change error. | The right model, and it needs a vocabulary most validators don't have.                                             |
| **Log and aggregate**               | Emit a finding per call, count them centrally.               | The only way to see a 5%→25% trend. Requires the finding to carry the _field_, and somewhere to count.             |
| **Pin a vendor API version**        | `Accept: application/vnd.x.v3+json`.                         | The real fix where offered. Doesn't help with data-dependent nulls, and vendors sunset versions.                   |

**Summary of the state of the art:** classify by change type, don't fail on additions, be loud
about removals and type changes, treat nullability as a warning, and **aggregate across calls**
— because a 5% signal is only interpretable as a rate.

---

## What to verify against StitchAPI

Leveled drift is a headline feature and the last one this section hasn't stressed. The
[recipes](../../apps/docs/content/docs/recipes/catch-a-breaking-api-change.mdx) already cover
_catching a breaking change_; this scenario is about the **operational** case — partial,
intermittent, and needing to be interpreted as a rate.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- Scenario 11 measured `drift()` producing findings at `coerced` and `undeclared` levels
  (`drift.ts:59-69`), so a **level vocabulary exists**. The question is whether it maps onto the
  industry taxonomy: addition → quiet, removal → loud, type change → loud, nullable → warn.
- **The `coerced` level is the one to look at hardest.** If a `transaction_id` of `"12345"`
  silently becomes `12345` with an info-level finding, that is correct and useful. If `"abc"`
  becomes `NaN` or `0` at the same level, that is the `$0` transaction with a warning nobody
  reads.
- Scenario 11 also measured that findings are reachable on `.report().findings` but that
  `.safe()` gets a generic message — so **actionability may depend on which accessor you use**.
- **Aggregation is the likely gap.** Every scenario in this pass that needed cross-call state
  found none: no per-call slot on `HookContext` (scenario 7), no run-scoped state (scenario 7),
  closures that leak across calls (scenario 11). A 5% drift rate needs counting, and counting
  needs somewhere to count.

**Claims to test with runnable offline code:**

1. **C1** — an **added** field. Does it alarm? At what level, and does it reach the caller?
2. **C2** — a **removed** field. Is it caught, and is it distinguishable in level from C1?
3. **C3** — a **type change** with a plausible coercion: `transaction_id` `12345` → `"12345"`,
   and the dangerous variant `"abc"`. What does the caller actually receive — the string, a
   number, `NaN`, `0`? At what level? **This is the $0-transaction test.**
4. **C4** — a field becomes **null** on 5% of responses (the geocoder case). Does drift fire
   only on those, and does the finding name the field?
5. **C5** — can the four classes be given **different severities** — addition silent, removal
   fatal — declaratively?
6. **C6** — **aggregation.** Over 100 calls where 5 drift, can the caller learn "5% of calls
   drifted on field X"? Is there any counting, or is each call independent? Where would a
   counter live?
7. **C7** — is the finding **actionable**: field path, expected, actual? And which accessors
   carry it (`.safe()`, `.report()`, the event stream, a trace sink)?
8. **C8** — assemble the most honest answer for a canary rollout: quiet on additions, loud on
   removals/type changes, and a rate you can alert on. Report the seam and line count.

C3 and C6 decide this one. A drift system that silently coerces a type change is worse than
none, and one that can't be aggregated cannot tell you a rollout is happening.
