# Issue draft — there is no seam that runs on failure, so mandatory cleanup can't be expressed

**Status:** ✅ **FILED** as [#656](https://github.com/rejifald/StitchAPI/issues/656)
**Scenario:** [`multipart-upload`](../multipart-upload.md)
**Suggested template:** feature_request.yml · **Suggested labels:** `enhancement`, `hooks`

> The scenario came out achievable — a `try/finally` in user orchestration gets to **0 orphans
> on every exit path**. But this is the first scenario in the pass where the library contributes
> _nothing at all_ to the requirement the scenario exists for, and two of the ways people will
> write that `try/finally` are measurably wrong while looking right.

Reproduce:

```bash
for f in docs/scenarios/proofs/multipart-upload/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. Nothing runs on failure

Some APIs impose a **compensating action**: if a multi-step operation fails partway, you must
call a _different_ endpoint to undo it. S3 multipart is the canonical case — abandon an upload
and every part already sent bills as storage indefinitely, invisible to `aws s3 ls`. AWS puts
this at [up to 20% of an S3 bill](https://aws.amazon.com/blogs/aws-cloud-financial-management/discovering-and-deleting-incomplete-multipart-uploads-to-lower-amazon-s3-costs/).

Nothing in the library can express it:

- `Hooks` is exactly `{ onRequest, onResponse, onError, onRetry }` (`types.ts:1285-1290`).
- **`onError` is not a failure hook.** It fires from the `catch` around the transport
  (`engine.ts:668-680`). Measured on an HTTP 500: hook sequence `[onRequest, onResponse]`,
  **0** `onError` calls. On a stalled socket it fired 3 times — once per attempt, not once per
  failure.
- `HookContext` (`types.ts:1279-1284`) is `{ name, attempt, req, res, error }` — **no
  run-scoped slot**, so even if a hook did fire there is nowhere to keep the `UploadId` it
  would need.
- `linked()` is `Promise.resolve(body(run))` (`pipe.ts:357-369`) — no `finally`.
- A trace sink sees the terminal `done` (measured 4 events, one `ok: false`) but it is a _log_
  seam: per stitch call, no control flow, and no `UploadId` either.
- Inventing `onFinally` is **accepted at runtime**, lands on `__config`, and never runs.

**Measured orphans** with a part failing and no user-side cleanup: **3 parts / 15 MiB / 1
dangling UploadId / 0 DELETEs**. Cancelling via `AbortSignal`: **2 orphans, 0 DELETEs**. A
`timeout.total` expiry: **3 orphans, 0 DELETEs** — cancellation cancels in-flight work and
forgets the work that landed.

**Ask:** a per-**run** terminal seam with control and a scratch slot — `onSettle(ctx)` carrying
`ok` plus somewhere to have stashed the `UploadId`. Today the only per-run terminal signal is
the `done` trace event, which has neither. This is the whole fix; everything below is the
consequence of its absence.

## 2. Two ways the `try/finally` people write instead is wrong while looking right

**Counts double — `.safe()` on the cleanup call cannot throw.** In a correct-looking
`try/finally`, pointed at a wrong `UploadId`: **0 accepted DELETEs, 3 orphaned parts, and
nothing thrown anywhere.** The `finally` ran; the review passes; the bill is permanent and
invisible. The codebase's own preference for `.safe()` over `try/catch` leads directly here.

**Counts double — cleanup inside `Surface.execute` runs after the caller returns.** The
tempting design is "make the whole upload one stitch so the engine owns the lifecycle".
Measured at the instant the caller's promise settled on a timeout: **3 orphans, 0 DELETEs**;
the DELETE landed several turns later, because `withTimeout` (`resilience.ts:230-244`) rejects
the caller and lets `fn` run on. In a lambda, or any process that exits on the error, the later
half never happens.

**Ask:** if `onSettle` lands, document that cleanup must be loud. If it doesn't, the pitfalls
page should carry both of these — they are not obvious and both are silent.

## 3. Contributing hazards measured alongside

- **`all()` bounds nothing.** Peak in-flight measured **8** over 8 members (`pipe.ts:122-136`
  maps straight into `Promise.all`). It also hands every member the **same `StitchInput`**
  (`pipe.ts:75-76`) — measured: one stitch × 8 members produced 8 PUTs all carrying
  `partNumber=1` and stored **one** part.
- **`throttle.concurrency` defaults to `pool: 'stitch'`**, so 8 stitches at `concurrency: 3`
  each measured a peak of **8** (`resilience.ts:103-109`). `pool: 'host'` or a seam bucket
  gives 3. The combination that reads correct — `all()` plus per-member `concurrency` — bounds
  nothing.
- **`all()` discards partial results on fail-fast.** 2 parts stored server-side, **0 nameable**
  by the client for the abort. No `allSettled` (`pipe.ts:20` says the omission is deliberate);
  only an `onResponse` side channel recovers them. Using `.safe()` members keeps the values but
  disables fail-fast — measured part 4 uploading _in full_ into an already-doomed upload.
- **The default `retry.on` excludes 500** (`engine.ts:612`), which is S3's own transient error
  (`500 InternalError`). Measured with the default set: 4 PUTs, 1 failed part, **3 orphans**.
  Widening to include 500 restored a clean run.
- **Whole-upload retry is neither flagged nor prevented.** `retry: { attempts: 3 }` on an outer
  orchestration stitch measured **3 initiates, 12 PUTs, 3 dangling UploadIds, 9 orphaned parts,
  45 MiB**.
- **A progress tick has no identity.** `AdapterProgress` is `{ direction, loaded, total }`
  (`types.ts:858-867`) — no part number, request or run id — so a shared `onProgress` across a
  concurrent fan is unattributable. Ticks are cumulative _within_ a part, so the natural
  `Σ loaded` overshoots: measured **400** for a 160-byte file, and **300** when a retry replays
  a part's ticks from zero. A per-part high-water map gives the right answer.
- **`.inspect()` carries no response headers** (`types.ts:1736-1766`), so on the awaited path a
  part's `ETag` is unrecoverable without a custom surface.
- **A custom `interpret` that omits `verdictOf` turns an HTTP 500 part into `ok: true` /
  `data: undefined`** — the failure then surfaces only when `complete` rejects the list. This is
  the fourth scenario in which `verdictOf` had to be remembered; see the standing note in the
  [ledger](../LEDGER.md).

## 4. Two incidental corrections, unrelated to the scenario

- **`backoff` has no `delay` field.** It is `{ curve, base, max }`; `delay` is a compile error
  and a runtime no-op.
- **The docs reference a `pipe()` combinator that does not exist.**
  `apps/docs/content/docs/concepts/run-identity.mdx:26` and `:33` describe "each step of a
  `pipe()`" and label a diagram `a pipe(): step 1`. Verified: `stitchapi/pipe` exports exactly
  `all, any, linked, race`. The construct the passage describes is `linked()`. Left unfixed
  here to keep the scenario commits scoped — it is a two-line docs edit.
