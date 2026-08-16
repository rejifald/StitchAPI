# Proofs — the upload you must clean up after: S3-style multipart

Runnable evidence for the claims in
[`../../multipart-upload.md`](../../multipart-upload.md).

Every script is standalone, offline and deterministic: it injects a fake S3-shaped multipart provider
through StitchAPI's `adapter` / `Surface.execute` seam, drives the timeout cases off an injected
`manualClock()`, and controls part-completion ORDER with microtask turns rather than timers — so a
bounded eight-part fan is exact and never flaky. No network, no `node:test`, no sleeping.

**The measurement that decides this scenario is `orphanParts`.** A part stored under an `UploadId`
that was never completed and never aborted is exactly what AWS bills for and hides from `aws s3 ls`.
The fake counts it, alongside `orphanBytes`, `danglingUploads` and `aborted` (how many `DELETE`s
actually arrived). Three other numbers carry claims of their own: `peakInFlight` (incremented by the
server on entry, decremented on exit — nothing about concurrency is inferred from config),
`completionOrder` (the order the server actually stored parts in) and `partPutOrder` (every part
number that arrived, so "only part 3 was re-sent" is `[1,2,3,4,3]` rather than an argument).

The provider is strict on purpose: `complete` rejects an out-of-order list with `400
InvalidPartOrder` and an incomplete or ETag-mismatched one with `400 InvalidPart`. Ordering is
therefore checked by the server, not assumed by the proof.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/multipart-upload/c4-no-compensation.ts

# all of them
for f in docs/scenarios/proofs/multipart-upload/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set — `--ignoreConfig` because TypeScript 6
makes a file list alongside a `tsconfig.json` an error (TS5112), and here the flags are the
whole config:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/multipart-upload/*.ts
```

## What each script establishes

| Script                       | Question                                       | Measured                                                                                                  |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `c1-upload-progress.ts`      | does `xhrAdapter` really report bytes SENT?    | **Yes — 4 upload ticks vs fetch's 0**, and the gap is readable before any call. The diagnostic is gated   |
| `c2-etag-header.ts`          | can the `ETag` header be captured, in order?   | **Yes, via `interpret`.** No result accessor carries headers; `Promise.all` already does the ordering     |
| `c3-bounded-concurrency.ts`  | what actually bounds the part fan?             | **`throttle.concurrency` on ONE stitch → peak 3.** `all()` bounds nothing; `all()` + per-member limit → 8 |
| `c4-no-compensation.ts`      | is there ANY seam that guarantees the abort?   | **No — and `onError` fired 0 times on an HTTP 500.** Orphan: 3 parts / 15 MiB / 0 DELETEs                 |
| `c5-retry-granularity.ts`    | per-part retry? is whole-upload retry stopped? | **Per part: `[1,2,3,4,3]`.** Whole-upload retry is not prevented: 3 UploadIds, 9 orphans, 45 MiB          |
| `c6-cancelled-siblings.ts`   | what happens to parts that already landed?     | **2 stored, 0 nameable.** `all()` discards the successes; a `hooks.onResponse` side channel recovers them |
| `c7-progress-aggregation.ts` | can per-part bytes become one number?          | **Yes — per-part HIGH-WATER.** The naive `Σ loaded` measured 400 against a 160-byte file                  |
| `c8-assembled-solution.ts`   | best answer, run on both paths, worth it?      | **141 vs 163 lines, 0 orphans on every exit** — and the `try/finally` is identical on both sides          |

## Files

- `fake-s3.ts` — the provider. `POST ?uploads` → `{ UploadId }`; `PUT ?partNumber=N&uploadId=…` →
  **200 with an `ETag` RESPONSE HEADER and no body**; `POST ?uploadId=…` with an ordered
  `[{PartNumber, ETag}]` list → the assembled object, or `400 InvalidPartOrder` / `400 InvalidPart`;
  `DELETE ?uploadId=…` → abort. Knobs: `partTicks` (delay a part's response by N microtask turns, so
  completion order can be made to differ from part order), `hangParts` (a stalled socket that answers
  only when its signal aborts — which is what makes a `timeout` a reachable failure mode) and
  `failPart(n, times, status)`. Exposes both an `Adapter` and a `fetch`-shaped entry point so C8's
  two implementations share one transport contract.
- `fake-xhr.ts` — a structural `XhrLike`, injected into `xhrAdapter(FakeXhr)`. Not a workaround:
  `xhrAdapter` takes a constructor for exactly this (xhr-adapter.ts:49-68). It fires
  `upload.onprogress` on a deterministic schedule, so C1 and C7 assert an exact tick sequence.
- `multipart.ts` — **user code**, the assembled answer and the subject of C8's line count. Four
  stitches, one `try/finally`, a mandatory-by-default `onCleanupFailure`.
- `hand-rolled.ts` — the same behaviour with no StitchAPI in it, feature-matched down to the FIFO
  pool and the retryable-status set, so the line comparison is honest.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C4 is the finding, and it is a refusal.** There is no compensation seam: `StitchConfig` has 26
  keys and none of them is one, `Hooks` is exactly `{onRequest,onResponse,onError,onRetry}`
  (types.ts:1285-1290), and `linked()` is `Promise.resolve(body(run))` (pipe.ts:357-369) with no
  finally. The capture predicted that. What it did not predict is that **`onError` is not a failure
  hook at all** — it lives in the `catch` around `withTimeout(transport)` (engine.ts:668-680), so a
  failed call carrying HTTP 500 measured the hook sequence `["onRequest","onResponse"]` and **zero**
  `onError` calls, while a stalled socket fired it **three** times (once per attempt). Cleanup wired
  to `onError` runs on the network blips and skips the application failures. That is worse than an
  absent hook, because it looks wired.
- **The orphan, measured three ways.** A failing part with no user cleanup: **3 parts / 15 MiB / 1
  dangling UploadId / 0 DELETEs**. A caller `AbortSignal` mid-flight: **2 orphaned parts, 0 DELETEs**
  — the user pressed Cancel and the bucket kept the bytes. A `timeout.total` expiry: **3 orphaned
  parts, 0 DELETEs**. Cancellation is built in; cleanup is not, and the two are different concerns.
- **The failure mode that counts double is a cleanup that reports success.** `abort.safe()` cannot
  throw. Pointed at a wrong UploadId inside a correct-looking `try/finally`, it measured **0 accepted
  DELETEs, 3 orphaned parts, and nothing thrown anywhere**. Every `.safe()` on a compensating call
  needs its `ok` inspected; `multipart.ts` makes `onCleanupFailure` mandatory-by-default (omitted, it
  throws) for exactly this reason.
- **`all()` is the wrong tool for a part fan, twice over, and the capture nominates it.** It bounds
  nothing — `runAllArray` is `members.map(...)` straight into `Promise.all` (pipe.ts:122-136), which
  measured a peak of **8** on eight parts. And it hands EVERY member the same `StitchInput`
  (pipe.ts:75-76): one stitch × eight members produced eight PUTs all carrying `partNumber=1` and
  stored **one** part. So a fan needs eight distinct stitches — and eight stitches each configured
  `concurrency: 3` measured a peak of **8**, because the default `pool: 'stitch'` gives every stitch
  its own state map (resilience.ts:103-109). The config reads `concurrency: 3` eight times and bounds
  nothing.
- **Three spellings do bound it; only one is obvious after the fact.** ONE stitch called eight times
  with `throttle: { concurrency: 3 }` → **3**. `{ concurrency: 3, pool: 'host' }` across eight
  stitches → **3** (the host-pooled state map is module-level). A `seam({ throttle: { concurrency: 3
} })` bucket → **3** (seam.ts:46-68).
- **The ETag is reachable, and the ordering was never the hard part.** `Surface.interpret` returns
  the header as the stitch's data; `hooks.onResponse` and `Surface.execute` see it too but can only
  write it to a closure. What is NOT reachable is anything on the awaited path: a bare stitch on a
  part PUT measured `ok:true`/`data:undefined`, and `.inspect()` measured `status:200`/`raw:null`
  with **zero** header-bearing fields (`Inspection`, types.ts:1736-1766). Meanwhile `Promise.all`
  resolves in INPUT order regardless of settle order, so with the server storing parts `[3,1,4,2]`
  the list was already `[1,2,3,4]` — the sort everyone writes by hand is redundant. The bug is
  collecting inside the `await` callback: pushing on settle gave `[3,1,4,2]` and `400
InvalidPartOrder` with 4 parts orphaned.
- **`interpret` REPLACES the default verdict, and forgetting `verdictOf` is silent.** A part surface
  written the natural way (`interpret: (res) => ({ ok: true, data: res.headers['etag'] })`) turned an
  HTTP 500 into `ok:true`/`data:undefined` — the part "succeeded" carrying no ETag, and the failure
  surfaced two calls later as `InvalidPart`. `verdictOf(res, cfg) ?? …` (surface.ts:174-191) is not
  optional boilerplate.
- **`retry.on` defaults to `[429,502,503,504]`, and S3's own transient error is `500 InternalError`.**
  The same `retry: { attempts: 3 }` that produced a clean `[1,2,3,4,3]` against a 503 measured **4
  PUTs, 1 failed part and 3 orphans** against a 500 (engine.ts:612). Widening to
  `on: [429,500,502,503,504]` restored it. A THROWN transport error is retried regardless of
  `retry.on` — measured ok with `on: [418]` — which is a different code path (engine.ts:681).
- **Whole-upload retry is not prevented and multiplies the orphan.** The whole flow as one
  `Surface.execute` stitch with `retry: { attempts: 3 }` measured **3 `POST ?uploads`, 12 part PUTs,
  3 dangling UploadIds, 9 orphaned parts, 45 MiB**. Nothing warns. Moving the abort INSIDE `execute`
  measured 3 initiates / 3 DELETEs / **0 orphans** — still the wrong granularity, no longer a billing
  incident.
- **`all()`'s auto-cancel works, and cleanup is a separate question.** With parts 1-2 landed, part 3
  failing and part 4 in flight, the server saw statuses **[200,200,500,499]** — part 4 genuinely cut
  off. Two parts were stored and the client could name **zero** of their ETags, because `all()` is
  `Promise.all` and discards resolved values on rejection. A `hooks.onResponse` side channel
  recovered exactly `[1,2]`. There is no `allSettled` (the subpath exports exactly
  `["all","any","linked","race"]`, and pipe.ts:20 says the omission is deliberate); composing
  `.safe()` members keeps every value but disables the fail-fast — measured `[200,200,500,200]`,
  i.e. part 4 uploaded in full into an upload that was already doomed.
- **The upload progress story is real, and narrower than it looks.** `xhrAdapter` with an injected
  constructor reported 4 `direction:'upload'` ticks (`loaded [27,54,81,108]` of `total 108`) before
  the response existed; the identical call through the real `fetchAdapter` reported **0**. The
  capture says progress "is not available over `fetch` at all" — half right: fetch reports DOWNLOAD
  progress fine, so `onProgress` on a POST is half-served rather than ignored. The gap is readable
  with no call made (`supports` measured `["uploadProgress","downloadProgress"]` vs
  `["stream","downloadProgress"]` — strict complements, so choosing a progress bar costs you
  streaming), and asking fetch for upload progress emits one `info` event,
  `adapter.upload-progress-unsupported`, naming `xhrAdapter()` (engine.ts:1107-1123). **The gate:**
  it fires only when the adapter DECLARED capabilities. A custom/BYO transport declares nothing and
  measured 0 info events and 0 ticks — silence, which is the case most real code is in. And the note
  is an EVENT: `.safe()` and `await` never see it.
- **Progress aggregation has one correct shape and it is not the obvious one.** Every upload tick
  carries exactly `direction,loaded,total` (types.ts:858-867) — no part number, no request, no run
  id — so a SHARED `onProgress` across a concurrent fan is unattributable. Summing raw `loaded`
  measured **400** against a 160-byte file, because each tick is cumulative WITHIN its part. Binding
  the part number at the call site and keeping a per-part high-water mark produced 16 monotonic ticks
  ending at exactly 100%. A retry replays the part's ticks from zero (measured `[20,40,20,40]`),
  which makes the naive sum 300 while the high-water aggregate stays 160. There is no byte EVENT:
  `ProgressPhase` (types.ts:1293-1305) has no such phase and `onProgress` is absent from `__config`.
- **C8's line count is honest in both directions.** 141 executable lines against a 163-line
  feature-matched hand-rolled twin — 22 lines shorter, and the difference attributes exactly to the
  retry loop with backoff, the FIFO concurrency pool, the retryable-status set and the URL assembly,
  all of which became config. What did NOT shrink is the part this scenario is about: the
  `try/finally`, the loud-cleanup rule, the per-part high-water progress map and the input-order
  assembly are the same on both sides, line for line.
- **Do not make the upload one `Surface.execute` stitch to "let the engine own the lifecycle".**
  `withTimeout` (resilience.ts:230-244) rejects the caller's promise the instant the timer fires and
  lets `fn` keep running, so a `try/finally` inside `execute` cleans up AFTER the caller has already
  returned. Measured at the instant the caller's promise settled: **3 orphans, 0 DELETEs**; several
  turns later, 0 and 1. In a lambda, or any process that exits on the error, the later half never
  happens.
- **Two small corrections worth carrying.** `backoff` has no `delay` field — it is
  `{ curve, base, max }` (types.ts:967-974); `delay` is a compile error and a runtime no-op. And the
  `stitchapi/pipe` subpath exports `all` / `any` / `race` / `linked` and **no `pipe()` combinator at
  all**, despite the subpath's name and a reference to `pipe()` in
  `apps/docs/content/docs/concepts/run-identity.mdx:26`.
