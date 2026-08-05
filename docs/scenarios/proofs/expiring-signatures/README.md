# Proofs — the signature that expired in your own queue

Runnable evidence for the claims in [`../../expiring-signatures.md`](../../expiring-signatures.md).

**The scenario's answer is a number, and it is 0 milliseconds.** Four calls behind
`throttle: { rate: '1/2m' }`, granted at 0, 2, 4 and 6 virtual minutes: every one arrived carrying a
signature aged **0ms**, including the one that waited six minutes — past the five-minute window. The
same four calls signed once before being enqueued measured **0 / 2 / 4 / 6 minutes** and a **403
RequestTimeTooSkewed** on the last. botocore#149 is not present in this library, and the control
proves the instrument would have found it.

That is the deciding claim (C2), and it goes the library's way. So do C1, C3, C4 and the default half
of C6. Two things do not: the shipped signer ignores the injected clock (C5), and a skew 403 is
counted as a circuit failure while the pure-config way to reclassify it **swallows** it (C6).

Every script is standalone and offline. The measurement is always the same one — the **age of the
signature on arrival**: the gap between the instant `x-amz-date` claims and the instant the request
reached the transport.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c2-throttle-rate.ts

# all of them
for f in docs/scenarios/proofs/expiring-signatures/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core and `@stitchapi/aws-sigv4` from
`packages/*/src` by relative path, so they test the working tree, not the published bundles. The
whole suite takes about ten seconds; the two claims that use real time (C1 (c), C2 (c)) account for
most of it.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/expiring-signatures/*.ts
```

## What each script establishes

| Script                          | Question                                                 | Measured                                                                                                      |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `c1-sign-per-attempt.ts`        | signed per attempt, or once per call?                    | **Per attempt.** 3 attempts 6 min apart → 3 signatures, ages `[0,0,0]`. Signed once → `[0,6min]` and a 403    |
| `c2-throttle-rate.ts`           | **DECIDING** — does the rate wait happen before signing? | **Before.** 6-min queue → age **0ms**. Control → `[0,2,4,6]` min + 403. **But `hooks.onRequest` runs after**  |
| `c3-throttle-concurrency.ts`    | same, for a busy concurrency pool                        | **Same answer**, and for both limiters stacked. 6 min behind the pool → age 0ms                               |
| `c4-circuit-cooldown.ts`        | does a breaker cooldown hold a signed request?           | **It holds nothing** — 3 fast-failed calls performed **0 signings**. Half-open trial after 6 min: age 0ms     |
| `c5-clock-source.ts`            | injected clock, or `Date.now()`?                         | **`Date.now()`.** 600 virtual seconds moved the stamp **0s**; a clock-reading signer moved **600s**           |
| `c6-skew-403-classification.ts` | is a skew 403 retried? classifiable without swallowing?  | **Not retried (good).** But it **opens the circuit**, and `verdict: { accept, flag }` **succeeds on it**      |
| `c7-skew-correction.ts`         | is there a seam for AWS-style skew correction?           | **Yes — `shouldRefresh`/`refresh`.** Learned 600000ms from the `Date` header, re-signed to a 200, **free**    |
| `c8-assembled.ts`               | all three failure modes at once                          | **4 of 4 succeeded**, worst age 0ms, breaker never opened — **26 lines** of user code, all for the drift half |

## Files

- `fake-aws.ts` — the AWS-ish server, as a plain `Adapter`. It parses `x-amz-date` off the wire,
  compares it against its OWN clock (the client's clock plus a configurable `skewMs` — failure mode
  1 as one number), and rejects outside a five-minute window with the S3 `RequestTimeTooSkewed`
  envelope and a `Date` header. Every request is recorded with `signedAt`, `arrivedAt`, `ageMs` and
  `skewMs`; **`ages()` is the spine nearly every claim asserts on**.
- `signers.ts` — the two instruments, and the control. `stampedSigV4` wraps the **shipped**
  `awsSigV4` and brackets its `apply` with wall-clock reads. `clockSigV4` is ~20 lines that mint the
  timestamp from an injected `Clock` and hand it to the package's own exported `signRequestV4`.
  `presignedSigV4` + `presign` are the **control**: headers computed once, before the calls are
  enqueued — sign-then-queue, expressed in this library.
- `virtual-time.ts` — `runOut`, and the reason it exists. `manualClock.advance` drains microtasks
  between timer fires; `crypto.subtle` is genuinely async and settles on the macrotask queue several
  turns deep. Without extra drains the virtual clock jumps while real crypto is still running and
  the ledger reports an age that is **pure artifact, in the library's disfavour** — measured at
  120000ms for a request signed at the last possible moment.
- `harness.ts` — `check` / `checkSeq` / `checkAtMost` / `checkAtLeast` / `note` / `heading` /
  `finish`. No test framework.

## Reading the numbers honestly

- **C2 is the finding, and it is a good one.** `acquireWithin` is at engine.ts:629 and
  `cfg.auth.apply` at engine.ts:649 — **the wait is above the signing, inside the attempt loop**. A
  call queued six virtual minutes behind `rate: '1/2m'` arrived with a **0ms-old** signature and a
  200; the server measured **0ms of skew** against a 300000ms window. The same measurement on the
  **real clock with the real `awsSigV4`** across a 2.4-second queue: the worst **sign→wire gap was
  2ms**. This is the property the capture hoped for, and it should be advertised: _a StitchAPI
  throttle cannot expire a signature._
- **The control is what makes that a measurement.** Four calls pre-signed at t0 through the same
  fake server measured ages of **0 / 2 / 4 / 6 minutes**, one distinct signature across four
  requests, and a **403** on the last. The instrument detects botocore#149; the library does not have
  it.
- **C1: `cloneReq` is why, and it is stronger than "auth re-runs".** Each attempt gets a fresh
  header object copied from the UNSIGNED base request (engine.ts:261-264,646), so a previous
  attempt's `x-amz-date` cannot survive even by accident. Three attempts six minutes apart:
  `["…T120000Z","…T120600Z","…T121200Z"]`, ages `[0,0,0]`. A server-directed **`Retry-After: 600`**
  parked the call for ten minutes and attempt 2 still arrived fresh.
- **A quiet piece of protection nobody documents: `backoff.max` defaults to 10 seconds**
  (resilience.ts:47,56). `base: '6m'` alone yields a **10-second** wait — measured, and it cost this
  proof a false negative before the `max` was set explicitly. A COMPUTED backoff therefore cannot
  park a call long enough to expire a signature. `Retry-After` can: it skips `backoffDelay` entirely
  and is unbounded by design (engine.ts:743-767).
- **C4 reframes the capture's question.** The breaker does not queue a signed request — it fast-fails
  BEFORE the attempt loop (engine.ts:863,871), so the throttle and `auth.apply` are never reached.
  Across five calls, **three fast-failed and performed 0 signings**. There is no held signature to
  expire because nothing was signed. The half-open trial admitted after a six-minute cooldown carried
  the post-cooldown timestamp and an age of 0ms.
- **C5 is the third instance of one inconsistency, and it is a TESTABILITY defect, not a wire one.**
  `awsSigV4` stamps `amzDateOf(new Date())` (aws-sigv4/src/index.ts:301) and the package imports no
  `Clock` at all. Advancing a `manualClock` 600 virtual seconds between two signings moved the stamp
  **0 seconds**. On the real clock it is correct — the skew the server measured was **538ms**, all of
  it `x-amz-date`'s one-second resolution. But it means **a SigV4 stitch cannot be tested on a
  virtual clock**: under a default `manualClock()` (which starts at epoch 0) **0 of 3 calls were
  accepted**, ~20670 days of apparent skew, purely from the test harness.
- **That is also why C1–C4 are each measured twice.** A virtual queue is invisible to a signer on
  wall time. So each ordering claim runs once with `clockSigV4` at virtual intervals large enough to
  cross the five-minute window, and once with the SHIPPED strategy on the real clock at intervals
  small enough to finish in seconds. Both instruments enter at the same seam (`cfg.auth.apply`) and
  both agree.
- **C6 (a) is right by default and worth keeping.** `retry.on` defaults to `[429,502,503,504]`
  (engine.ts:612), so a 403 with `retry: { attempts: 4 }` produced **one** request. The failure retry
  cannot fix is not retried.
- **C6 (b) is the sharp restatement of why per-attempt signing is not enough.** With a host ten
  minutes behind and 403 added to `retry.on`, four attempts produced **four distinct signatures and
  four identical skews of 600000ms**. Re-signing faithfully re-mints the same wrong time. Ordering
  solves the queue; nothing but a corrected clock solves drift.
- **C6 (c): a skew 403 opens the circuit.** It throws at engine.ts:824-831 and `attemptWithCircuit`
  counts it (engine.ts:879-891). Measured `["403","403","503","503"]` — after two failures the page
  says **`circuit open` / 503**, a dependency outage, for a fault entirely inside this process.
- **C6 (d) refutes the obvious fix, and this is the most dangerous single result in the set.**
  `verdict: { accept: [403], flag: 'ok' }` — the pure-config classification scenario 9 measured
  working for a 401 — **swallows** the skew error. The call returned **`ok: true`** and handed the
  caller `{"Error":{"Code":"RequestTimeTooSkewed",…}}` **as its data**. `verdict.flag` is three-state
  and an ABSENT flag is explicitly "no signal" (surface.ts:180-190); AWS error bodies have no `ok`
  field, so the flag never fires and `accept` alone succeeds on the 403. **The scenario-9 recipe does
  not transfer to AWS.** What works is **6 lines** of `Surface.interpret` composing `verdictOf`: a
  real error for the caller, `4 of 4` requests reaching the wire, breaker never tripped.
- **C7 finds a real seam, and the capture guessed it was missing.** `AuthStrategy.shouldRefresh` /
  `refresh` (types.ts:1273-1274, engine.ts:707-725) was built for "the token expired, get a new one
  and redo this attempt", and a stale clock is that story with a different noun. A drifting host
  measured: 403 → offset **600000ms** learned from the response's `Date` → **same attempt redone**
  with a corrected clock → 200. `attempt--` (engine.ts:723) means it is **free**: a stitch with
  `retry: { attempts: 1 }` still got its second request. The correction persists across calls (call 2
  needed **1** request), and the `refreshed` latch (engine.ts:615,709) keeps it to one per run, so an
  uncorrectable clock fails rather than loops.
- **But `refresh` cannot see the response.** It is handed an `AuthContext` and nothing else, so the
  `Date` header has to be captured by `shouldRefresh` — the only auth hook that receives the
  response — and smuggled across through a closure. It works and it is six lines, but it is not what
  the seam looks like it is for.
- **The alternative seam is worse.** `hooks.onResponse` also sees the response and can learn the
  offset, but a hook cannot ask for another attempt — so it only lands if 403 is in `retry.on`, which
  re-arms C6 (b) for every genuinely-bad-credential 403. Measured working, at that price.
- **C8: 26 lines, in two declarations, and all of it for the drift half.** Against a ten-minute host
  drift, a six-minute rate-limited queue and a breaker: **4 of 4 calls succeeded**, worst signature
  age **0ms**, exactly **one** 403 (the probe that taught the offset), breaker never opened. The same
  workload with no user code: `["403","403","503","503"]`. **Nothing in those 26 lines is about the
  queue or the retry** — those needed no code at all.
- **A skew correction costs a second rate slot.** In C8 the succeeding calls were granted at
  **2/4/6/8** virtual minutes, not 0/2/4/6: the correction probe took t=0 and its corrected re-sign
  took t=2m, because `attempt--; continue` re-enters the loop at engine.ts:624 and re-acquires the
  throttle.

## The footguns

- **`hooks.onRequest` runs AFTER signing** (engine.ts:652 vs 649) and is the **only** user code that
  does. A six-minute wait inside it aged the signature by exactly six minutes and produced a **403** —
  measured. Anyone pacing calls with a hand-rolled gate in `onRequest`, because `throttle` could not
  express their rule, has re-created botocore#149 inside a library that does not have it. Nothing
  warns, and the config reads like a throttle.
- **`verdict: { accept: [403], flag: 'ok' }` does not classify an AWS skew error — it SUCCEEDS on
  it.** The caller receives `RequestTimeTooSkewed` as data and the call reports `ok: true`. This is
  worse than not classifying at all, and it is the recipe an earlier scenario published for a 401.
  The flag needs a body field that is _present and falsy_; AWS envelopes have none.
- **A skew 403 counts as a circuit failure, so a wrong local clock reads as a vendor outage.** The
  operator sees `circuit open` / 503 for a fault inside their own process, and the breaker's
  half-open probe then reports `RequestTimeTooSkewed` rather than whatever real fault opened it
  (measured in C4 (c)) — the recovery path reports the wrong cause.
- **A SigV4 stitch cannot be tested on a `manualClock`.** The signer is on wall time and everything
  around it is on virtual time, so any fake that validates the timestamp rejects everything —
  measured, **0 of 3**, ~20670 days of apparent skew. Anyone writing that test will conclude their
  signing is broken. The fix is a signer that takes a `Clock`; ~20 lines, in `signers.ts`.
- **`retry: { on: [403, …] }` turns an unfixable failure into a budget burn.** Four attempts, four
  fresh signatures, four identical 600000ms skews. If a 403 must be retried for other reasons,
  exclude the skew code.
- **`backoff.max` defaults to 10 seconds**, so a long `base` is silently clamped — `base: '6m'` waits
  ten seconds. Protective here, surprising everywhere else.
- **A `circuit` does not shed a burst already queued behind a `throttle`.** `circuit.phase()` is read
  at engine.ts:863, before `attemptLoop` reaches the throttle at 629, so every call in a concurrent
  burst clears the breaker at enqueue time. Measured: four calls fired together all reached the wire
  over six minutes, long after the first two failures had opened the breaker — where the same four
  calls made sequentially stopped after two.
- **Pre-signing outside the engine forfeits every property measured here.** The engine's contribution
  is the absence of a bug, and it only applies to signing it performs. A presigned URL handed between
  services, or a signature computed before a queue you own, is stale on exactly the schedule of that
  queue — measured `[0,2,4,6]` minutes with a perfect clock and no drift anywhere.

## What is NOT measured here

- **Streaming.** The SSE/reconnect path signs per open (a fresh `cloneReq` then `cfg.auth.apply` at
  engine.ts:1343-1346, after its own `acquireWithin` at 1318), which reads like the same ordering — but
  it was not run. A long-lived stream's signature is minted once at open and cannot be refreshed
  mid-body; for a SigV4 endpoint held open past five minutes that is an inherent property of
  streaming, not a library defect.
- **Pagination.** Each page is a full request through `attemptWithCircuit` (engine.ts:918-946), so
  per-page signing should follow from C1 and C2. Not run.
- **Real AWS.** The server here is a fake that validates timestamps. It does not check the signature
  itself, so nothing in this directory demonstrates that `signRequestV4` is correct — that is what
  `packages/aws-sigv4/test/sigv4.spec.ts` and the official AWS test vectors are for.
