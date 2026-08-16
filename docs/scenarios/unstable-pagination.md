# Scenario: the page that moved while you were reading it

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `unstable-pagination`

> ⚠️ **The causation below is BACKWARDS. Read the corrected version.** This capture said insert
> → skip and delete → duplicate. It is the reverse, and the proofs establish it against ground
> truth. Left uncorrected in the body as the record of what was assumed; the table and the
> published page carry the right version.

**Verification:** 8 proof scripts, run offline (213 checks), in
[`proofs/unstable-pagination/`](proofs/unstable-pagination/). Published page:
[`scenarios/unstable-pagination.mdx`](../../apps/docs/content/docs/scenarios/unstable-pagination.mdx).
Escalated: [`issue-drafts/paginate-cannot-report-a-partial-run.md`](issue-drafts/paginate-cannot-report-a-partial-run.md).

| Claim                                 | Verdict                                 | Measured                                                                                                                                                     |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — insert behind the cursor         | **REFUTED IN DIRECTION**                | not a skip — a **duplicate**: `skipped []`, `duplicated ["r04"]`, 11 items for 10 rows. An offset insert can _never_ cause a skip                            |
| C2 — delete behind the cursor         | **REFUTED IN DIRECTION, worse**         | not a duplicate — a **skip**: `skipped ["r05"]`. And `total` dropped to 9 at the same instant, so length === total === 9 and the cheap check detects nothing |
| C3 — non-unique sort key, zero writes | confirmed, sharpest case                | `skipped ["r05"]` **and** `duplicated ["r03"]` on a static collection; they cancel, so only the _deduped_ count (9 vs 10) fires                              |
| C4 — keyset via `next`                | confirmed, 4 lines                      | `skipped []` / `duplicated []` on every workload that broke offset — but a composite cursor against a vendor that doesn't `ORDER BY` it still lost `["r03"]` |
| C5 — detection seams                  | confirmed **with a trap**               | deduping in `items`/`transform` emptied a page → break → **6 rows lost by the fix**. `output` is the safe seam                                               |
| C6 — `total` reconciliation           | reachable; misses the case that matters | raw length-vs-total fired **0 of 4**; nothing fired on the delete while `r05` was gone                                                                       |
| C7 — drift vs the known edges         | confirmed                               | drift emptied a page mid-run → `skipped ["r10","r11","r12"]`, and the shrunken total made the reconciler _agree_. `pages: 50` → 200 of 220 rows, `ok`        |
| C8 — assembled                        | PASS                                    | 0 false negatives / 3 false alarms over 8 workloads — **84 lines vs 74 hand-rolled**                                                                         |

**The first capture error of FACT rather than prediction.** Every prior scenario's wrong
hypotheses were about which primitive would carry the solution. This one had the mechanism of
the problem itself backwards, and would have shipped a page teaching the wrong causation. The
correct version:

- **Insert behind the cursor** → rows shift to _higher_ indices → the next fixed offset lands on
  a row already read → **duplicate**.
- **Delete behind the cursor** → rows shift to _lower_ indices → the next offset jumps past one
  → **skip**.

**The finding worth carrying:** the signal that catches the delete case is that the **declared
`total` moved** — not dedupe, not length-vs-total. A delete removes one row from the result and
one from `total` simultaneously, so every arithmetic check balances while a row is missing.

---

## The use case

You page through a collection to sync it — orders, tickets, contacts — `?offset=0&limit=100`,
then `100`, then `200`. Meanwhile the collection is _live_: rows are being inserted, deleted,
and edited by other people.

You end up with a list. It is quietly wrong.

## Why it is not straightforward

**Offset is a position in a result set, not a position in the data.** Anything that changes the
result set between two requests moves every row after it:

- **An insert before your offset** pushes every later row down one. The row that was last on
  page 1 becomes first on page 2 — no, worse: the row that _would_ have been first on page 2
  is now last on page 1's territory, and you **never see it**.
- **A delete before your offset** pulls every later row up one, so the row you already read on
  page 1 appears again on page 2. You process it **twice**.
- **A mutable sort field** does both: edit `updated_at` on a row you've already read and it
  jumps ahead of your cursor.
- **A non-unique sort key** breaks it with _no writes at all_. Ties in `created_at` may come
  back in any order, and the database is under no obligation to be consistent between two
  queries — so rows can be skipped or repeated on a completely static table.

The fix is **keyset (seek) pagination** — `WHERE (created_at, id) > (:last_ts, :last_id)` — with
a composite cursor so ties are broken by something unique. That is a _server_ capability.
**A client cannot make an offset API consistent.** If the vendor only offers `offset`/`limit`,
no amount of client cleverness produces a correct page sequence.

What a client _can_ do, and this is where the difference lies:

- **Detect duplicates** — the same id appearing on two pages is proof of drift.
- **Reconcile against a declared total** — most APIs return `total`; aggregating 987 of a stated
  1000 is a detectable gap.
- **Use the cursor when offered**, and never silently fall back to offset.

The trap is that a client which **aggregates pages into one array** does none of that by
default: duplicates are silently included, and skips are invisible by construction.

## Evidence this bites real projects

- **ServiceNow** — [the REST pagination gotcha that _silently drops records_](https://vexpose.blog/2026/07/28/the-servicenow-rest-pagination-gotcha-that-silently-drops-records/):
  a named, specific production failure of exactly this shape.
- **The failure taxonomy** is consistent across write-ups —
  [Knit on pagination stability](https://www.getknit.dev/blog/how-to-preserve-api-pagination-stability),
  [12 pagination failure modes you'll see in production](https://medium.com/@sparknp1/12-pagination-failure-modes-youll-see-in-production-8ed33658df7e),
  [Cursor-based pagination: why your API is silently showing users wrong data](https://medium.com/@moksh.9/cursor-based-pagination-why-your-api-is-silently-showing-users-wrong-data-561f69c2040c).
- **CedarDB** — ["Offset considered harmful"](https://cedardb.com/blog/pagination/) on the
  surprising complexity of SQL pagination.
- The **composite-cursor** rule (sort field **plus** a unique key) is the consistent
  recommendation for the tie case.

## The common solutions, and what each costs

| Approach                          | What it is                                    | Where it breaks                                                                                           |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Offset/limit, as offered**      | The default.                                  | Skips and duplicates under any concurrent write, and under ties with no writes at all. Silent.            |
| **Keyset / seek pagination**      | Cursor on `(sort, id)`.                       | The correct fix — and only available if the vendor implemented it.                                        |
| **Snapshot / point-in-time read** | Ask the API for a consistent snapshot.        | Ideal where offered (some exports do). Rare in REST.                                                      |
| **Sort by an immutable key**      | Page by `id ASC` rather than `updated_at`.    | Removes the mutable-sort-field case, and not the insert/delete cases. Also loses the ordering you wanted. |
| **Client-side dedupe by id**      | Drop repeats as you aggregate.                | Cheap, and fixes only _half_ — duplicates go away, skips remain invisible.                                |
| **Reconcile against `total`**     | Compare what you got to what the API claimed. | The only cheap way to _detect_ a skip. Doesn't repair it, and `total` itself moves.                       |
| **Re-sync from scratch**          | Periodically page the whole collection again. | The practical safety net for a sync job, at full cost every time.                                         |

**Summary of the state of the art:** use keyset if the vendor offers it; if not, dedupe by id,
reconcile against the declared total, and treat a mismatch as a signal to re-sync. The
distinctive thing is that **correctness is not achievable client-side** — only _detection_ is,
and detection is what almost every client omits.

---

## What to verify against StitchAPI

This is `paginate`'s third appearance in this section, and deliberately from a different angle:
[scenario 3](batch-partial-failure.md) and [scenario 4](async-job-polling.md) tested its
_mechanics_. This one is about whether the **data it hands you is right**, and whether it can
tell you when it isn't.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- `paginate` aggregates every page's `items` into one array (`types.ts:1412-1422`). Nothing in
  its three fields (`next`, `items`, `pages`) suggests dedupe or reconciliation, so the default
  is likely "silently include the duplicate, silently omit the skip".
- `next(prevBody, pagesFetched)` receives the previous page's **raw body**, which should make
  **keyset** pagination expressible — read the last item's `(sort, id)` and return it as the next
  input. That is the one thing the library should do well here.
- Scenario 3 measured that a zero-item page ends the loop successfully with the remainder
  unfetched, and scenario 4 measured that the default `items` wraps a non-array body as one
  item. Both matter here: a drifted page could hit either.
- `total` reconciliation needs the caller to see a field from the **last** page's body — and
  scenario 3 measured that `next` is never called on the terminal page, so the tail state may be
  unreachable from inside the loop.

**Claims to test with runnable offline code:**

1. **C1** — model a live collection. With an **insert** before the cursor between page 1 and
   page 2, does the aggregated array **miss** a record? Measure exactly which id is lost.
2. **C2** — with a **delete** before the cursor, does the aggregated array contain a record
   **twice**? Does anything at all flag it?
3. **C3** — the **no-writes tie case**: a non-unique sort key where the server returns ties in a
   different order per query. Measure skips/duplicates on a completely static collection.
4. **C4** — is **keyset** pagination expressible through `next`? Build it against a server that
   offers `(created_at, id)` seek and measure that the same insert/delete workload produces a
   correct, complete, duplicate-free result.
5. **C5** — can duplicates be **detected or removed** inside the library — via `items`,
   `transform`, `output`, a surface? Measure what the caller can see.
6. **C6** — can the run be **reconciled against a declared `total`**? Is the last page's `total`
   reachable from anywhere the caller can act on?
7. **C7** — does a drifted page interact with the two known `paginate` edges — the zero-item
   break and the non-array `items` wrap?
8. **C8** — assemble the most honest answer: keyset where available, dedupe + reconcile where
   not, and a signal the caller can act on. Report the seam and line count.

C1–C3 establish the damage; C5 and C6 decide whether the library can _tell you_. Correctness
here is the server's to give — the honest question is whether a client that aggregates pages
can at least refuse to lie about the result.
