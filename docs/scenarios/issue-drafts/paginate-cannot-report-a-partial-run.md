# Issue draft — four different endings share one `break`, and the natural dedupe causes data loss

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`unstable-pagination`](../unstable-pagination.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `bug`, `paginate`, `data-loss`
**Companion to:** [`paginate-silent-data-loss`](paginate-silent-data-loss.md) — same root cause,
two more consequences

> `paginate`'s third appearance in this pass, and the first from the _data-correctness_ angle.
> The earlier draft asked for a stop reason; this one shows two further things that go wrong
> without one, including a case where the standard fix **causes** the loss.

Reproduce:

```bash
for f in docs/scenarios/proofs/unstable-pagination/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. Deduping in `items`/`transform` can end the run early and lose rows

**Severity: high — the recommended mitigation causes the damage it prevents.**

Client-side dedupe by id is the standard advice for offset drift, and `items`/`transform` are
where a reader will put it — they're the per-page hooks.

They run **above** the `break` at `engine.ts:984`, which fires on `items.length === 0`. So on a
workload where page 2 repeats page 1 verbatim (four inserts behind the cursor), the deduper
emptied that page, the loop read zero items as "the collection ended", and the run finished
**`ok`** having **skipped `["r05".."r10"]` — 6 rows lost by the fix**, against a declared total
of 14. Without the dedupe the same run returned all 10 rows it could see.

Related and equally quiet: **a deduping `items` on a reused stitch returns `data: []`,
successfully, on every call after the first**, because the `seen` set outlives the call. Defining
a stitch once and calling it many times is the normal shape.

**Ask:** this is the `items.length === 0` break again (see the companion draft). If it stays,
the pagination guide should say explicitly that dedupe belongs in `output` — after the loop —
and never in `items`/`transform`. `output` works correctly and is measured doing so.

## 2. Four different endings are one `break` and one successful result

Measured, all four ending `ok: true` with `error: null` and no distinguishing event:

| ending                             | measured                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| the collection ended               | correct                                                                                 |
| a page came back **empty mid-run** | 8 deletes left 4 rows; the offset-4 window was empty; **skipped `["r10","r11","r12"]`** |
| the **page cap** was hit           | `pages: 50` default → **200 of 220 rows**, skipped `["r201".."r220"]`                   |
| a **deduper** emptied a page       | §1 above                                                                                |

The empty-page case is the nastiest, because the shrunken `total` makes a reconciler _agree_:
4 collected against a declared total of 4, while 3 rows were never read.

**Ask:** the stop reason asked for in the companion draft would separate all four. `pages` being
a _silent_ terminus is arguably its own bug — a cap that truncates should say so.

## 3. The check everyone writes doesn't catch the case that matters

`length === total` is the standard reconciliation. Measured over clean / insert / delete / ties,
it fired **0 of 4** times. The deduped variant fired on the insert (a false alarm — nothing was
lost) and on the ties, and **missed the delete entirely** while `r05` was gone.

The reason is exact: a delete behind the cursor removes one row from the result **and** one from
`total`, at the same instant. The arithmetic balances perfectly.

The signal that does carry it is that **the declared `total` moved between pages** (10 → 9) —
a check none of the standard write-ups name. Over 8 workloads a detector built on it had **zero
false negatives** and 3 false alarms.

**Ask:** surface `total`-like fields, or at least document the moved-total check in the
pagination guide. Today `total` is reachable only from `transform` or `hooks.onResponse` —
`next` never sees the terminal page's body, so the obvious place to look is the one place it
isn't.

## 4. Smaller findings from the same verification

- **The default `items` wrap inverts the safety.** An envelope is always one item, so an empty
  page never breaks the loop — but then `data.length` was **2 for a 12-row collection**, and
  every downstream count measures _pages_. `pick: 'rows'` truncates identically.
- **`drift()` cannot express a duplicate.** Deduping an array re-indexes it, so the findings come
  back as 3 × `coerced` and 1 × `undeclared` on element paths (`drift.ts:59-69`) — none saying
  "duplicate". Reasonable given what drift is for; worth knowing it is not the tool here.
- **`.report()` is a fresh probe** (third sighting in this pass — see
  [`clock-and-diagnostic-side-effects`](clock-and-diagnostic-side-effects.md)). Here it
  re-paginated the collection, made 3 more requests, and **did not reproduce the duplicate at
  all** — it describes a run it just made, never the run you made.
- **A rejecting `output` gives `.safe()` a generic message and `data: null`** — the offending
  ids and the partial rows exist only on `.report()`. Same shape as the
  `.safe()`-drops-the-body finding in [`body-verdict-footguns`](body-verdict-footguns.md).
- **A custom `Surface.interpret` is the only seam that stops _at_ the drifted page** with the id
  named — at the cost of discarding every row already collected, and emitting no `result` event.

## 5. What works, and is worth documenting as the pattern

**Keyset via `next` is four lines and correct.** `next` receives the previous page's raw body
(`engine.ts:985`), so a composite `(created_at, id)` cursor is trivial, and against a real seek
endpoint it measured `skipped []` / `duplicated []` on every workload that broke offset. The
zero-item break is _right_ for this case — it's the natural terminus of a cursor walk.

One caveat worth a line in the guide: **sending a composite cursor does not make an endpoint a
seek endpoint.** The same four lines against a vendor that accepts `(after_ts, after_id)` but
orders by `created_at` alone lost `["r03"]` and duplicated `["r13"]`, with no writes.
