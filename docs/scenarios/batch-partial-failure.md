# Scenario: batch endpoints that fail one item at a time

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `batch-partial-failure`

**Verification:** 7 proof scripts, run offline (183 checks), in
[`proofs/batch-partial-failure/`](proofs/batch-partial-failure/). Published page:
[`scenarios/batch-partial-failure.mdx`](../../apps/docs/content/docs/scenarios/batch-partial-failure.mdx).
Escalated to a draft: [`issue-drafts/paginate-silent-data-loss.md`](issue-drafts/paginate-silent-data-loss.md).

| Claim                                      | Verdict                | Measured                                                                                                                           |
| ------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1 — built-in `retry` on a partial failure | cannot                 | 1 request, resolves `ok: true` with rows gone; forced with `on: 200`, **10 duplicate writes on a healthy batch**                   |
| C2 — `paginate.next` as the residue loop   | works, then loses data | 3 requests / 6 items / **0 duplicates** — but a zero-progress round ended the run with **4 of 6 rows never written, `ok: true`**   |
| C3 — backoff between rounds                | absent                 | six rounds at t=0; `throttle` gives one fixed ratio; every growing curve was user code the engine never reported                   |
| C4 — can a `Surface` rewrite the request   | no — but a hook can    | `SurfaceOutcome.retry` resent the identical body (4 duplicate writes); assigning `ctx.req.body` in `onRequest` gave 0              |
| C5 — retryable vs terminal per-item        | expressible            | 400 doc sent **once** (vs 5 naively), never written; but reaches the caller only via a closure                                     |
| C6 — is the residue reachable              | **no**                 | absent from result, error, `.inspect()`, `.report()`, events, trace; the `next` ledger reported `cdef` for a true residue of `def` |
| C7 — assembled from the public API         | works                  | 4 rounds at t=0/1000/3000/7000, 0 duplicates, residue returned as data — **50 lines vs 28 hand-rolled**                            |

**The framing below was wrong in both directions.** It nominated `paginate` as the promising
candidate and concluded no seam could rewrite a request between attempts. Both are false:

- `paginate` expresses the loop and then **fails both deciding claims** (C3, C6) and silently
  drops data on a zero-progress round. As this scenario's answer it is a trap, not a solution —
  which is why it produced the strongest issue draft of the pass so far.
- **`hooks.onRequest` can rewrite the request**, stays inside the resilience chain, and is what
  makes the scenario achievable. Paired with `SurfaceOutcome.after` the backoff is engine-owned,
  budget-aware and observable.

Also worth recording: the assembled answer is **larger** than the hand-rolled `while` loop it
replaces. The honest pitch is not brevity — it is that `timeout.total`, the circuit breaker,
`attempts`, and retry events keep working, all measured.

---

## The use case

You write records in bulk — DynamoDB `BatchWriteItem`, Elasticsearch `_bulk`, SQS
`SendMessageBatch`, Salesforce sObject Collections, Google Sheets `batchUpdate`. One HTTP
request carries 25, 100, or 1,000 items.

The API answers **HTTP 200**, and inside the body reports that _some_ of them didn't land.

## Why it is not straightforward

**The retry unit is smaller than the request.** Every HTTP client retries by replaying the
identical request. Here that is actively wrong: re-sending all 100 items to fix the 7 that
failed re-applies 93 writes that already succeeded, and on a non-idempotent endpoint that is
duplicate data, not just waste. The correct behaviour is to **rewrite the request body to the
failed subset and send that**, repeatedly, until the subset is empty.

No mainstream HTTP client models a retry that changes the request.

Four supporting difficulties:

- **The failure is invisible to status-code logic.** DynamoDB returns 200 with
  `UnprocessedItems`; Elasticsearch returns 200 with `errors: true` and a per-item `status`.
  A client checking `res.ok` sees success.
- **Backoff is mandatory, not optional.** AWS is explicit: retrying unprocessed items
  immediately will simply throttle again, because the cause is capacity. The retry loop
  _must_ wait, and wait longer each round.
- **Failures are not uniform.** In one Elasticsearch response, item 3 may be a `429`
  (retry it) and item 7 a `400` mapping error (retrying it forever is a hang). A correct loop
  partitions per-item failures into retryable and terminal.
- **Termination needs a real bound.** If the subset never empties, the loop must stop and
  surface _which_ items never landed — the caller needs the residue, not just an error.

## Evidence this bites real projects

- **Logstash** — [`elastic/logstash#1631`](https://github.com/elastic/logstash/issues/1631):
  "rejected docs in bulk indexing partial failure are **silently lost**". The strongest
  statement of the failure mode: a 200 with per-item rejections, and the data is simply gone.
- **elasticsearch-py** — [`#1004`](https://github.com/elastic/elasticsearch-py/issues/1004):
  `streaming_bulk` retries only `429`, and with `raise_on_error=False` errors are aggregated
  **without their data**, so you cannot tell which items to resend.
- **GitLab** — [`gitlab#12372`](https://gitlab.com/gitlab-org/gitlab/-/issues/12372),
  "intelligently retry bulk-insert failures when indexing", and
  [`gitlab#351600`](https://gitlab.com/gitlab-org/gitlab/-/issues/351600).
- **AWS** — [Error handling with DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html)
  and [BatchWriteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html):
  retry `UnprocessedItems`, and _"if you retry the batch operation immediately, the underlying
  write requests can still fail due to throttling"_. Helpfully, `UnprocessedItems` is shaped
  exactly like `RequestItems`, so the resend needs no transformation.

## The common solutions, and what each costs

| Approach                                                 | What it is                                            | Where it breaks                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client's built-in retry**                              | `retry: { attempts: 3 }` on the batch call.           | Replays **all** items. Fixes the 7 by re-writing the 93. Wrong unit, and duplicate side effects.                                                |
| **Hand-rolled `while` loop**                             | Read the residue, rebuild the request, sleep, repeat. | Correct, and what most teams end up with. Lives outside the HTTP client, so timeout, circuit breaking, and tracing no longer see the real call. |
| **SDK helper** (`streaming_bulk`, AWS SDK batch writers) | The vendor does it for you.                           | Only where a vendor SDK exists, and the policy is theirs: elasticsearch-py retries `429` only, and drops the failed items' data.                |
| **Ignore partial failure**                               | Check the HTTP status, move on.                       | The Logstash bug. Silent data loss, discovered later by absence.                                                                                |
| **Split into single-item calls**                         | One request per record.                               | Correct and trivially retryable — at 100× the requests, which is what the batch endpoint existed to avoid.                                      |

**Summary of the state of the art:** a loop that (1) reads the failed subset from a 200 body,
(2) rebuilds the request from it, (3) waits with growing backoff, (4) separates retryable from
terminal failures, and (5) reports the residue. Every team writes this by hand, and most get
(4) or (5) wrong.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- The interesting candidate is **`paginate`**, not `retry`. `PaginateOptions.next(prevBody,
pagesFetched)` returns _"the input (merged over the original) for the next page, or
  `undefined` to stop"_ (`types.ts:1413-1417`). That is structurally exactly the required loop:
  read the residue off the previous body, return `{ body: { RequestItems: unprocessed } }`,
  return `undefined` when empty. `items` (`:1419`) aggregates the successes; `pages`
  (`:1421`, default 50) is the termination bound.
- **The suspected miss: there is no delay.** `PaginateOptions` is three fields — `next`,
  `items`, `pages`. No per-iteration wait, no backoff curve. AWS says backoff is mandatory
  here, so a loop that fires the next attempt immediately is the documented way to fail.
  Whether `throttle` can stand in (fixed spacing, and it paces unrelated traffic too) is the
  question that decides this scenario.
- Scenario 2's answer does **not** transfer: `SurfaceOutcome.retry` re-sends the _same_
  request. Confirm whether a surface can rewrite the outgoing body between attempts at all.
- Naming: nothing about "pagination" suggests "retry the failed subset of a write". Even if
  it works, this is a signposting gap of the same kind found in scenario 2.

**Claims to test with runnable offline code:**

1. **C1** — does built-in `retry` resend all items? Measure the duplicate writes it causes.
2. **C2** — can `paginate.next` express "resend only the residue" for a DynamoDB-shaped
   `UnprocessedItems` response, terminating when empty, aggregating successes via `items`?
3. **C3** — can any **backoff** be introduced between those iterations? Try `throttle`,
   and anything else in the working tree. Measure the actual gaps. If the only answer is a
   fixed spacing, say what that costs versus exponential.
4. **C4** — can a **surface** rewrite the request body between attempts (the scenario-2 seam)?
5. **C5** — can retryable (`429`) and terminal (`400`) per-item failures be separated, with
   the terminal ones surfaced to the caller rather than retried forever?
6. **C6** — when the loop gives up, can the caller get **the residue** — the items that never
   landed — or only an error?
7. **C7** — the assembled best answer from the public API: write it, run it, report the seam
   and the line count, and say plainly whether it is better or worse than the hand-rolled
   `while` loop it replaces.

C3 and C6 are the ones that decide page vs. issue. A loop that cannot back off is not a
solution to this scenario, however elegant the rest is.
