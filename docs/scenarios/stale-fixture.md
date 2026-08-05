# Scenario: the mock that passed for six months

**Researched:** 2026-08-05 · **Status:** ✅ verified (8 claims, 168 checks, offline) · page shipped
**Slug:** `stale-fixture`

---

## The use case

You integrate a vendor API. You write tests. You cannot call the real API on every CI run — it is
slow, rate-limited, costs money, and mutates state — so you test against something fake.

Then the vendor changes the API, and **your tests keep passing.**

## Why it is not straightforward

This is the only scenario in the pass where the failure mode is _the test suite actively
lying to you_. Every available approach trades one form of wrongness for another.

- **A recording goes stale silently.** VCR-style cassettes are the standard answer, and the
  standard failure is that the cassette records a response that no longer exists. The classic
  shape: a login cassette records a session token; a day later a test needing a valid token is
  matched against that recording and gets an expired one — so the failure surfaces somewhere
  unrelated, if at all. The guidance is to _"plan cassette regeneration workflow when external
  APIs change; automate deletion and re-recording to prevent stale cassettes masking real API
  issues"_ — i.e. the mitigation is a process you must remember to run.
- **A hand-written mock encodes your beliefs.** It is wrong in exactly the way your code is
  wrong, because the same person wrote both from the same reading of the docs. A mock cannot
  catch a misunderstanding; it can only preserve it.
- **The sandbox is not production.** Providers maintain sandboxes _"for initial development, not
  for continuous regression testing"_ — they rarely support every edge case and do not reflect
  recent production changes. They are also slow (real network) and often rate-limited.
- **Contract testing needs the vendor.** Pact and friends work when both sides participate. A
  third-party vendor is not going to run your provider verification.
- **Time makes it worse.** Retry, backoff, timeout and circuit behaviour is where integration
  bugs actually live, and testing it against a real clock gives you a suite that is slow,
  flaky, and imprecise. `Thread.sleep`-based retry tests are the canonical example.

The consensus is that no single approach is sufficient — you need virtualisation for volume
_and_ live verification for accuracy. Which means the real question for a client library is
narrower and sharper: **can it tell you your fake has drifted from the real thing?**

## Evidence this bites real projects

- **Stale cassettes** — [HTTP testing in R, ch. 6 (vcr)](https://books.ropensci.org/http-testing/vcr.html)
  on the expired-token shape, and the standing advice to re-record on a schedule.
- **Sandbox parity** — [Keploy on sandbox testing](https://keploy.io/blog/community/sandbox-testing):
  sandboxes exist for initial development, not continuous regression, and lag production.
- **Neither alone is enough** — [Signadot on mocks vs sandboxes](https://www.signadot.com/blog/mocking-and-testing-3rd-party-apis-with-sandboxes/):
  service virtualisation for coverage at volume _plus_ live contract verification for accuracy.
- **Time-based tests** — [TimeProvider in .NET 8](https://www.eriklieben.com/posts/net8_timeprovider_for_unit_tests/)
  and [Go's `testing/synctest`](https://huncoding.com/go-synctest-testing-concurrent-code-en/):
  the industry has converged on injecting a clock precisely because retry/backoff tests are
  otherwise unusable. Kafka and Flink both rolled their own.

## The common solutions, and what each costs

| Approach                     | What it is                                | Where it breaks                                                                        |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| **Record/replay cassettes**  | Record real traffic once, replay forever. | Goes stale silently. Re-recording is a process, not a check.                           |
| **Hand-written mocks**       | Fixtures you write from the docs.         | Encode your misunderstanding faithfully. Cannot catch what you got wrong.              |
| **Vendor sandbox**           | The vendor's test environment.            | Lags production, misses edge cases, slow, rate-limited. Not built for regression runs. |
| **Contract testing (Pact)**  | Both sides verify a shared contract.      | Needs vendor participation. Not available for third parties.                           |
| **Hit production in CI**     | The only truly accurate option.           | Slow, costly, mutating, rate-limited, and flaky for reasons unrelated to your code.    |
| **Schema/contract snapshot** | Validate responses against a schema.      | The honest middle ground — but only if the _same_ schema guards prod and the fixtures. |

**Summary of the state of the art:** use a fake for speed and a periodic real call for truth,
and make the gap between them detectable rather than hoping someone re-records.

---

## What to verify against StitchAPI

`stitchapi/testing` is a substantial module and this pass has never given it a dedicated run.
It exports `mockAdapter`, `stubStitch`/`failStitch`, `collectStitchEvents`, stream/SSE
fixtures (`streamOf`, `streamThenError`, `gatedStream`, `sseStream`), `manualClock`, and a set
of **contract verifiers** (`verifyStoreContract`, `verifyAdapterContract`, `verifySinkContract`,
`verifyFingerprintContract`).

Note the split: the verifiers are aimed at people writing **plugins**, not people writing
**integrations**. Whether the integration half is as well served is the question.

**And there is a specific, pre-registered suspicion.** [Pattern 2b](LEDGER.md) of this pass
records that **three time-driven features ignore the injected clock** — `timeout.total`
(scenario 4), `cache.ttl` (scenario 6) and SigV4 signing (scenario 14) — each found
incidentally while testing something else. If `manualClock` is the answer to the
slow-flaky-retry-test problem, then a test of `timeout.total` written with it **passes
vacuously**, which is the worst possible failure for a testing tool. This scenario should
settle the scope of that once, deliberately, instead of accumulating a fourth accidental
sighting.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Can a fixture be caught when it goes stale? If the same `output`
   schema guards production and the test double, does a drifted fixture fail? Try: a field
   removed, renamed, retyped, and nulled.
2. **C2** — **DECIDING CLAIM.** Is `manualClock` sound across every time-driven feature?
   Enumerate `retry` backoff, `throttle`, `circuit.cooldown`, `timeout` (per-attempt **and**
   `total`), `cache.ttl`, `paginate`. For each: does `advance()` drive it, or does it read
   wall-clock? A feature that ignores the clock makes a test that _passes without asserting
   anything_ — measure that explicitly.
3. **C3** — what does `mockAdapter` actually check? Does it validate that the fixture is a
   well-formed `AdapterResponse`, or will it happily serve a shape the real adapter never
   produces?
4. **C4** — can resilience be tested **without** a vendor? Assert attempt counts, backoff
   delays, circuit transitions, throttle spacing — using `collectStitchEvents`.
5. **C5** — `stubStitch`/`failStitch`: can a _caller_ of a stitch be tested without the
   engine? Does the stub honour the same input contract as the real stitch?
6. **C6** — the sandbox-parity question: can one stitch be pointed at sandbox and prod so the
   difference is visible? Is there a spelling for "run this against the real API weekly"?
7. **C7** — streams: `streamOf`/`streamThenError`/`gatedStream` — is mid-stream failure
   (scenario 5) testable deterministically?
8. **C8** — assemble the best available "my fixtures cannot silently rot" setup; report seams
   and line count.

C1 and C2 decide this. C1 is the scenario's actual question. C2 is the pre-registered
suspicion, and if `manualClock` is unsound anywhere the testing guide needs to say so.

---

## Verification result

**All 8 claims verified**, 168 checks across 8 scripts, re-run by me before writing up.

| Claim                               | Verdict                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — can a stale fixture be caught? | **PARTIAL — and the missing half is the scenario.** Fixture-drifts-from-schema: 4/4 caught. Vendor-drifts-while-fixture-holds: test `ok: true`, prod `ok: false`, 5 keys different, **nothing offline detects it** |
| C2 — is `manualClock` sound?        | **CONFIRMED, and wider than recorded — 6 wall-clock, not 3**                                                                                                                                                       |
| C3 — what does `mockAdapter` check? | Almost nothing; and it **fails the library's own adapter contract**                                                                                                                                                |
| C4 — resilience without a vendor?   | **Fully testable.** The strongest result in the scenario                                                                                                                                                           |
| C5 — `stubStitch` input contract    | Runs **none** of the input schemas; plus a `.safe()` bug                                                                                                                                                           |
| C6 — sandbox parity                 | Targeting yes (3 targets, one `extends`), scheduling no                                                                                                                                                            |
| C7 — streams                        | **Fully deterministic** — 5 runs, 1 outcome, byte-identical                                                                                                                                                        |
| C8 — assembled                      | 98 lines, 5 seams, closes 4 of 5                                                                                                                                                                                   |

### Hypotheses that were wrong

**My own framing of the vacuity mechanism.** I predicted `timeout.total` "ignores the clock". It
does not: the per-attempt clamp fires on virtual time, and the wall-anchored part is the
_deadline_, so the budget **resets** each attempt rather than being ignored. The measured
outcome (a 1000ms budget surviving 2700 virtual ms) matches the prediction; the mechanism does
not. Predicting an outcome correctly for the wrong reason is the subtler failure and worth
recording as such.

**"The shared `output` schema is the honest middle ground."** True for fixture-vs-schema drift,
and structurally blind to vendor-vs-schema drift — which is the scenario. The thing I proposed
as the answer solves the adjacent problem.

**"`drift()` might help find a stale fixture."** It helps you _read_ a failure, never _find_ one.
ADR 0015 removed snapshot drift deliberately — "a single snapshot is one observation" — so
there is no cross-call baseline by design.

**"`paginate` is a time-driven feature to check."** It has no time in it.

### Outputs

- Page: [stale-fixture.mdx](../../apps/docs/content/docs/scenarios/stale-fixture.mdx)
- Draft: [testing-kit-clock-gaps-and-two-bugs](issue-drafts/testing-kit-clock-gaps-and-two-bugs.md)
