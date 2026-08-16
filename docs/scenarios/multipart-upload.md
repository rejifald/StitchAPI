# Scenario: the upload you must clean up after

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `multipart-upload`

**Verification:** 8 proof scripts, run offline (201 checks), in
[`proofs/multipart-upload/`](proofs/multipart-upload/). Published page:
[`scenarios/multipart-upload.mdx`](../../apps/docs/content/docs/scenarios/multipart-upload.mdx).
Escalated: [`issue-drafts/no-compensation-seam.md`](issue-drafts/no-compensation-seam.md).

| Claim                           | Verdict                                   | Measured                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — upload progress            | PASS                                      | `xhrAdapter` 4 upload ticks before the response existed; `fetchAdapter` **0**; `supports` readable with no call; an `info` event names `xhrAdapter()` — but only if the adapter declared capabilities |
| C2 — ETag header, in part order | PASS via `interpret`                      | server stored `[3,1,4,2]`, `Promise.all` resolved `[1,2,3,4]`; the same ETags in settle order → `400 InvalidPartOrder` + **4 orphans**                                                                |
| C3 — bounded concurrency        | PASS, **not** via `all()`                 | peaks: no throttle 8, `all()` **8**, one stitch + `concurrency: 3` **3**, 8 stitches × `concurrency: 3` **8**, `pool: 'host'` **3**                                                                   |
| C4 — compensation seam          | **FAIL — none exists**                    | HTTP 500 → `[onRequest, onResponse]`, **0** `onError`. No cleanup: **3 parts / 15 MiB / 0 DELETEs**. Abort: 2 orphans. Timeout: 3 orphans                                                             |
| C5 — retry granularity          | per-part PASS; whole-upload not prevented | `[1,2,3,4,3]`, 0 orphans — but the default `retry.on` excludes **500**, S3's own transient error; outer retry → **9 orphans, 45 MiB**                                                                 |
| C6 — cancelled siblings         | diverges                                  | 2 parts stored, **0 nameable**; `all()` discards resolved values; no `allSettled`                                                                                                                     |
| C7 — progress aggregation       | PASS, not the obvious way                 | naive `Σ loaded` **400** vs real **160**; per-part high-water gives 160 and survives a retry replay                                                                                                   |
| C8 — assembled                  | PASS                                      | 0 orphans on every exit path; **141 vs 163** lines                                                                                                                                                    |

**The honest headline, and it is not flattering.** The library saves 22 lines — retry with
backoff, the concurrency pool, the retryable-status set, URL assembly, all config. But the
`try/finally`, the loud-cleanup rule, the per-part high-water progress map and the input-order
assembly are **byte-for-byte identical** on both sides. This is the first scenario in the pass
where the library contributes nothing to the requirement the scenario exists for.

**Hypotheses: mostly right for once, and the one that was wrong matters.** The capture guessed
`all()` might need `throttle.concurrency` as its pool — in fact `all()` bounds nothing _and_
hands every member the same input, so the combination that reads correct (`all()` + per-member
`concurrency`) measured a peak of 8 against a stated limit of 3. The capture also under-rated
C4: it asked whether cleanup was "entirely user-side", but the sharper finding is that the two
natural ways to write it are silently wrong — `.safe()` on the abort cannot throw, and cleanup
inside `Surface.execute` runs _after_ the caller returns.

---

## The use case

A user uploads a 5 GB video. You can't send it in one request, so you use S3-style multipart:
initiate the upload, send the file in parts, then tell the server to assemble them.

1. `POST /uploads?uploads` → an `UploadId`
2. `PUT /uploads/{key}?partNumber=N&uploadId=…` × N → each returns an **`ETag` header**
3. `POST /uploads/{key}?uploadId=…` with the ordered `{ PartNumber, ETag }` list → the object
4. …and on **any** failure, `DELETE …?uploadId=…` — or you pay for the parts forever.

## Why it is not straightforward

**Step 4 is the one nobody models.** If you abandon a multipart upload, every part already
sent stays in the bucket and **bills as storage indefinitely** — while being invisible to
`aws s3 ls` and to the console's objects tab. AWS's own FinOps guidance puts incomplete
multipart uploads at **up to 20% of an S3 bill**. This is a _compensating action_: a failure in
step 2 or 3 obliges you to make a different API call, and no HTTP client models "on failure,
call this other endpoint". You write a `try/finally` and hope every exit path goes through it.

The rest is a genuine orchestration problem:

- **The result of each part is a response header.** `ETag` is not in the body, and the
  `complete` call needs them **in part order**, not completion order.
- **Retry granularity is per part, not per upload.** Part 47 of 100 failing should re-send part
  47 — retrying the whole upload re-sends 5 GB. (Same shape as the batch-residue scenario,
  arrived at from the opposite direction.)
- **Concurrency has to be bounded.** All 100 parts at once will exhaust sockets and memory;
  one at a time wastes the bandwidth multipart exists to use.
- **Progress is not available over `fetch` at all.** The Fetch API cannot report bytes _sent_ —
  upload progress requires `XMLHttpRequest`. Any progress bar therefore constrains the
  transport, and a per-part byte count still has to be aggregated into one number.
- **Parts have a minimum size** (5 MB except the last), so chunking is not free-form.
- **A failure mid-flight leaves siblings in flight.** Cancelling them is right; but parts that
  already landed still need the abort, so cancellation and cleanup are different concerns.

## Evidence this bites real projects

- **AWS's own cost guidance** — [Discovering and deleting incomplete multipart uploads](https://aws.amazon.com/blogs/aws-cloud-financial-management/discovering-and-deleting-incomplete-multipart-uploads-to-lower-amazon-s3-costs/),
  and the [lifecycle rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)
  that exists purely to clean up after clients that didn't.
- **Cost writeups** — [Infracost](https://www.infracost.io/finops-policies/aws-s3-deleting-incomplete-multi-part-uploads/)
  and [DoiT](https://www.doit.com/blog/aws-s3-multipart-uploads-avoiding-hidden-costs-from-unfinished-uploads/)
  both lead with the same point: the parts are billed and invisible.
- **The progress constraint** is well documented: `fetch` cannot report upload progress, so
  every progress bar in the browser is XHR-backed.
- **tus** exists as a protocol specifically because a single multipart POST throws the whole
  upload away when the connection blinks.

## The common solutions, and what each costs

| Approach                                | What it is                                                           | Where it breaks                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single `PUT` of the whole file**      | One request, no orchestration.                                       | One blink and 5 GB is gone. Above 5 GB, S3 refuses outright.                                                                                         |
| **Vendor SDK** (`@aws-sdk/lib-storage`) | `Upload` class does parts, concurrency, and abort.                   | Correct, and the right answer _if you're on AWS_. Pulls in a large dependency, and the same problem recurs on every non-AWS API with the same shape. |
| **Hand-rolled loop + `try/finally`**    | Chunk, `Promise.all` with a pool, collect ETags, abort in `finally`. | What most teams write. The abort is one missed early-`return` from being skipped, and nothing tells you when it was.                                 |
| **tus / resumable protocol**            | Offload resumability to a protocol.                                  | Genuinely better where you control the server. Not an option against S3's own API.                                                                   |
| **Lifecycle rule as the safety net**    | Let S3 clean up after N days.                                        | Necessary belt-and-braces, and not a fix: you still pay for N days of orphaned parts across every failed upload.                                     |
| **Skip progress**                       | Avoid the XHR constraint.                                            | Fine for a server-side job; unacceptable for a user watching a 5 GB upload.                                                                          |

**Summary of the state of the art:** bound the concurrency, retry per part, collect ETags in
order, aggregate progress, and — the part that actually bites — guarantee the abort runs on
every failure path. The first four are ordinary async work. The fifth is a _compensation_
requirement, and it is the one no client library helps with.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **`xhrAdapter` exists precisely for this.** Its documented reason to exist is upload progress
  ("`fetch` cannot report bytes sent"). Adapters also declare a `capabilities` descriptor —
  `{ name?, supports }` over `'stream' | 'uploadProgress' | 'downloadProgress'` — so there may
  be real capability negotiation, and possibly a diagnostic when you ask `fetch` for progress.
- **`all()` runs members as sibling child runs and auto-cancels them if one fails.** Useful for
  the part fan — but auto-cancellation is not cleanup: parts that already _landed_ still need
  the abort. Whether `all()` has any concurrency bound is open; `throttle.concurrency` on the
  part stitch may be the pool.
- **There is no compensation hook anywhere in core.** No `onFinally`, no `compensate`, no
  `onSettle` in `types.ts`. If that holds, the mandatory abort is entirely user-side, and the
  interesting question becomes whether the library at least makes it _hard to skip_.
- The ETag-from-a-response-header mechanic already has two precedents in this section
  (`Location` in the async triangle, `ETag` in conditional requests), so it is likely reachable
  — the new question is collecting N of them **in part order** under concurrency.

**Claims to test with runnable offline code:**

1. **C1** — does `xhrAdapter` actually report upload progress ticks, and does `fetchAdapter`
   silently report nothing? Is the capability difference detectable _before_ a call?
2. **C2** — can a part's `ETag` **response header** be captured, and N of them assembled in
   **part order** (not completion order) for the complete call?
3. **C3** — can part uploads run with **bounded concurrency**? Try `all()`, `throttle.concurrency`.
   Measure the actual peak in-flight count.
4. **C4** — **DECIDING CLAIM.** Is there any way to guarantee the **abort** runs on failure —
   a compensation hook, a `finally` seam, anything? Or is it entirely `try/finally` in user
   code? Measure the orphan: how many parts are left behind when a part fails and nothing
   aborts.
5. **C5** — per-part retry: can one part retry without re-sending the others? And is the
   _whole-upload_ retry prevented (it would re-initiate and orphan the first `UploadId`)?
6. **C6** — when `all()` auto-cancels siblings on a failure, what happens to parts that had
   already completed? Are they visible for the abort, or lost?
7. **C7** — progress aggregation: can per-part byte counts become one number for a UI?
8. **C8** — assemble the best answer, run it, report seam(s) and line count, compare honestly
   against the hand-rolled version and against `@aws-sdk/lib-storage`'s ergonomics.

C4 is the one that matters. Every other part of this is ordinary orchestration; the abort is
the requirement that turns a working upload into a billing incident when it's missed.
