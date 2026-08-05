# Proofs — the page that moved while you were reading it

Runnable evidence for the claims in [`../../unstable-pagination.md`](../../unstable-pagination.md).

**The scenario's answer is a list of row ids, and the first two of them are the wrong way round.**
The capture says an insert before your cursor loses a row and a delete before your cursor repeats
one. Measured against a fake server that knows the ground truth: an insert **duplicates** `r04`, a
delete **skips** `r05`. That is not a quibble — the two failures have completely different
detectability. A duplicate is visible in the data you were handed. A skip is not, and the delete
that caused it takes exactly one row off the declared `total` at the same instant, so
`collected.length === total === 9` with a row missing and every reconciliation check reading clean.

Every script is standalone and offline. The numbers are **ids**, not durations: each claim prints
what the server served page by page, what the caller ended up with, and the `skipped` / `duplicated`
sets computed against the server's own record of which rows existed at the start and at the end.
Time is not load-bearing in this scenario (pagination is sequential and nothing sleeps), so only C8
injects a `manualClock()` — where it measures per-page retry across a `500`.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c1-insert-before-cursor.ts

# all of them
for f in docs/scenarios/proofs/unstable-pagination/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/unstable-pagination/*.ts
```

## What each script establishes

| Script                        | Question                                                 | Measured                                                                                        |
| ----------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `c1-insert-before-cursor.ts`  | does an insert behind the cursor LOSE a row?             | **No — it DUPLICATES one.** skipped `[]`, duplicated `["r04"]`, run ok, 0 findings              |
| `c2-delete-before-cursor.ts`  | does a delete behind the cursor REPEAT a row?            | **No — it SKIPS one.** skipped `["r05"]`, and `length === total === 9`, so nothing can see it   |
| `c3-tie-order.ts`             | ties, non-unique sort key, ZERO writes                   | **skipped `["r05"]` + duplicated `["r03"]` on a frozen collection**, and they cancel in `total` |
| `c4-keyset.ts`                | is keyset expressible through `next`? is it correct?     | **Yes, in 4 lines — clean on every workload.** And a non-total server ORDER BY breaks it anyway |
| `c5-detection-seams.ts`       | can a duplicate be seen or removed inside the library?   | **5 seams; the 2 obvious ones truncate the run.** A deduping `items` lost 6 rows, successfully  |
| `c6-total-reconciliation.ts`  | is the last page's `total` reachable? does it detect?    | **Reachable from 3 places. Fires 0/4 raw, and never on C2** — the delete moves the total too    |
| `c7-drift-meets-the-edges.ts` | drift vs the zero-item break, the wrap, and the page cap | **Drift makes an empty page mid-run → skipped `["r10","r11","r12"]`, ok.** And `pages: 50`      |
| `c8-assembled.ts`             | the best available answer, priced                        | **0 false negatives / 3 false alarms over 8 workloads — and 84 lines vs 74 hand-rolled**        |

## Files

- `fake-collection.ts` — the live table. One collection served three ways so the only variable
  between claims is the pagination contract: `?offset=&limit=`, `?after_ts=&after_id=&limit=`
  (keyset), and both answering `{ rows, total, limit, offset? }`. Writes land BETWEEN page fetches
  via `afterRequest(n, mutation)` — request-indexed, not timed, so every run is deterministic. The
  `ties` variant sorts by `created_at` alone and rotates each tie group one position per query,
  which is a legal answer to an `ORDER BY` that is not a total order; `brokenSeek` extends that to
  the seek endpoint. `audit(collected)` is the ground truth: **STABLE** = ids present at the start
  AND at the end, and a correct paginator returns every stable id exactly once. Rows created or
  destroyed mid-run are **transient** and never counted as damage.
- `offset-loop.ts` — the offset/limit `paginate` block every damage claim runs. `items` pulls the
  rows, `next` advances `offset` by `limit` and stops when it passes the declared `total`. There is
  nothing wrong with it, which is the point.
- `keyset-loop.ts` — the seek block. Four lines between the `<count:begin>`/`<count:end>` markers.
- `sync-collection.ts` — the assembled answer C8 runs: keyset where available, offset with the
  damage detected where not, rows and verdict returned as ONE value. The counted region is what
  C8(d) measures.
- `hand-rolled.ts` — the same feature set with no library at all, against the same fake server. The
  baseline C8 prices against.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C1 and C2 refute the capture, in opposite directions from each other and both away from the
  written text.** Offset counts from the start of the result set, so an insert BEHIND the cursor
  pushes rows to higher indices and the fixed next offset lands on a row already read
  (`r01,r02,r03,r04 | r04,r05,r06,r07` — duplicated `["r04"]`); a delete behind the cursor pulls
  rows to lower indices and the row that was about to be page 2's first slides into territory the
  client already passed (`r01,r02,r03,r04 | r06,r07,r08,r09` — skipped `["r05"]`). Two inserts
  duplicate two rows; two deletes skip two. An insert or delete AHEAD of the cursor does nothing.
  **An offset insert can never cause a skip.**
- **The delete case is the one that matters, and it is undetectable.** Measured: 9 rows collected,
  9 distinct, `total` 9 — because the delete removed one row from `total` at the same instant it
  removed one from the result. `length === total`, no duplicate to find, `error: null`,
  `findings: []`, `done.ok: true`. The only per-page signal the library emits is a running item
  count (`page 1 (+4, total 4)`, engine.ts:976-982), which reads identically on a clean run.
- **C3 is the case people don't believe, and it defeats both cheap detections at once.** Ten rows,
  zero writes, nothing created or destroyed, a non-unique `created_at` whose ties come back rotated:
  skipped `["r05"]`, duplicated `["r03"]`. They cancel, so `length === total === 10`. Only comparing
  the DEDUPED count (9) against `total` (10) fires. A tie group crossing two page boundaries loses
  `["r05","r10"]` and repeats `["r03","r04"]` and still balances at 16 === 16. The same rows under a
  total order are clean — **the fix is the server's `ORDER BY`, not anything the client sends.**
- **C4 confirms the capture: keyset is the thing the library does well.** `next` receives the
  previous page's RAW body (engine.ts:985), so a composite `(created_at, id)` cursor is four lines,
  and it measured skipped `[]` / duplicated `[]` on every workload that broke offset — C1's insert,
  C2's delete, C3's ties. The loop terminates on the zero-item break at engine.ts:984, which is the
  one thing that break is right for.
- **And keyset has a caveat the capture does not raise.** The same four lines against a vendor that
  ACCEPTS `(after_ts, after_id)` and still orders by `created_at` alone lost `["r03"]` on one
  collection and duplicated `["r13"]` on another, with no writes in either. A composite cursor only
  works if the server's sort is the composite key; the client half is four lines and it is not the
  half that decides.
- **C5: five seams reach the duplicate, and the two a caller reaches for first are booby-trapped.**
  `items` and `transform` both run per page and both carry closure state, so both dedupe — until a
  page is ENTIRELY duplicates. Four rows inserted behind the cursor made page 2 a verbatim repeat of
  page 1; the deduper returned zero items, `paginated` broke at engine.ts:984 **before** calling
  `next`, and the run ended `ok` with 4 rows, skipping `["r05".."r10"]` against a declared total of 14. **Without the dedupe the same run returns all ten rows.** The fix for duplicates is a
  mechanism for losing rows.
- **`output` is the safe seam, because it runs after the loop.** `validateOutput` executes once over
  the aggregated array (engine.ts:993) and its return value REPLACES the result (engine.ts:1005), so
  a hand-rolled `Validator` is a genuine post-processing hook: deduping returned 10 rows with the
  page count unchanged, and rejecting produced a failed call. Nothing it does can shorten the run.
- **A rejecting `output` loses the detail on `.safe()` and keeps it on `.report()`.** The issue text
  (`pagination drift: duplicate ids r04`) does not reach `error.message`, which is the generic
  `contract violation (drift)`; `.report().findings` carries it, and `.report().raw` still holds the
  11 aggregated rows that `.safe()` discards.
- **`drift()` fires on the right event and describes the wrong thing.** Wrapping the deduping
  validator produced **four** findings — `warn|coerced|[].id`, `[].created_at`, `[].name` and
  `info|undeclared|[]` — because removing one element RE-INDEXES the array and the positional diff
  reads every later row as a changed field. Nothing in the vocabulary says "duplicate".
- **A custom `Surface.interpret` is the only seam that stops at the drifted page.** It runs per page
  inside the attempt loop (engine.ts:775) and a `{ ok: false, message }` on a 200 is returned rather
  than thrown (engine.ts:824-831), so `paginated` turns it into an error + `done(false)`
  (engine.ts:960-964) with the message intact: `pagination drift: page repeated r04`, after 2 pages.
  The cost is total — a failed paginated run emits **no `result` event**, so every row already
  collected is discarded.
- **`hooks.onResponse` is the most complete view in the library and it is read-only.** It fired on
  all three pages with the raw body, and the result was unchanged by it.
- **C6 corrects scenario 3's "`next` never sees the terminal page" into something more useful.**
  That is true of the ZERO-ITEM break; it is false of a loop that ends because `next` returned
  `undefined`, which is how `offset < total` naturally terminates — `next` observed `[10,10,10]`
  over 3 pages, final total included. Switch to the `rows.length < limit` spelling over a collection
  that is an exact multiple of `limit` and a fourth, EMPTY page is fetched: `next` saw `[12,12,12]`
  and the terminal page's `total` of 10 was unreachable from it. `transform` and `hooks.onResponse`
  saw `[12,12,12,10]` in both cases. **Which of the two spellings you wrote decides whether the
  final total exists.**
- **Reconciling against `total` is reachable, actionable, and does not detect the skip.** Capturing
  the total in `transform` and deciding in `output` turns a mismatch into a failed call — the
  mechanism works. Over clean / insert / delete / ties, the raw `length vs total` check fired **0 of
  4**; the deduped variant fired on the insert (a **false alarm** — the "missing" row is the
  newly-inserted one, legitimately unread) and on the ties; and **nothing fired on the delete** while
  `r05` was missing. The capture calls reconciliation "the only cheap way to detect a skip"; measured,
  it detects neither of this scenario's two skips.
- **C7: drift alone produces an empty page in the middle of a collection that still has rows.**
  Eight deletes after page 1 left four rows; the client's offset-4 window came back empty; the run
  broke at engine.ts:984 and ended `ok` having skipped `["r10","r11","r12"]` — **with 4 collected
  against a declared total of 4, so the reconciler agrees it is fine.**
- **The default `items` wrap INVERTS the safety, and neither state is good.** Omit `items` and the
  `{ rows, total }` envelope is wrapped as one item per page (engine.ts:969-973), so `items.length`
  is 1 even for an empty page and the zero-item break can never fire — the lazy spelling is the one
  that does not truncate. But `data.length` is then **2 for a 12-row collection**, and every
  downstream count, reconciliation included, is measuring the PAGE COUNT. `pick: 'rows'` truncates
  exactly like `items`.
- **The default `pages: 50` is a third silent terminus at the same `break`.** 220 rows returned
  **200**, `ok`, no error, skipping `["r201".."r220"]`. It is the only one of C7's four cases a
  total check catches.
- **C8's detector is not the one the state of the art recommends, and that is the finding.** Dedupe
    - reconcile misses the delete entirely. The signal that carries it is that **the declared `total`
      itself moved** — 10 on page 1, 9 on page 3 — which is direct proof the collection changed under
      the cursor. Combined with duplicates, an empty page mid-run, and the cap, the verdict scored **0
      false negatives and 3 false alarms over 8 workloads**. Under keyset the same code lost nothing on
      all 8 and flagged nothing.
- **The verdict cannot be separated from the rows.** `output`'s return replaces the result, so the
  assembled answer hands back `{ rows, duplicates, totalMoved, emptyPageAt, capReached,
countMismatch, trustworthy }` as one value — there is no way to read the rows without the verdict
  in scope. It means "re-sync", not "these rows are wrong"; a client genuinely cannot tell.
- **The price is negative, and that is the honest number.** 84 counted lines against **74**
  hand-rolled for the same feature set, agreeing on rows and verdict across all 8 workloads. The
  detection logic is identical in both; a raw paging loop is ~15 lines and the declarative
  equivalent (a stitch config, a `transform`, an `output` validator, a two-mode `next`) is ~25.
  **What the 74 lines do not have is the resilience stack**: one `retry` line recovered a page that
  answered `500` mid-run (4 wire requests, 10 rows, nothing skipped), and auth/throttle/circuit/trace
  apply per page for free (engine.ts:946). That is what the library is buying here — not correctness,
  and not detection.

## The footguns

- **A paginated run that skipped rows is indistinguishable from a clean one.** `ok: true`,
  `error: null`, `findings: []`, `status: 200`, `attempts: 1`, and a `progress` line per page whose
  only number is a running item count. Nothing in the library compares anything to anything.
- **The delete-before-the-cursor case cannot be detected by any count.** The row leaves the result
  and the `total` at the same moment, so `length === total`, distinct === total, and no duplicate
  exists. Only "the `total` moved during the run" fires — and that check is not in any of the
  standard write-ups.
- **A deduping `items` (or `transform`) can end the run early.** A page that is entirely duplicates
  aggregates zero items, and `paginated` breaks at engine.ts:984 **before** `next`. Measured: the
  dedupe cost 6 rows on a run that without it returned all 10. The fix creates a worse bug than the
  one it fixes; do the dedupe in `output`, which runs after the loop.
- **A deduping `items` on a REUSED stitch returns an empty array on every call after the first.**
  A stitch is meant to be defined once and called many times; module-level `seen` state means call 2
  sees every id as a duplicate, page 1 aggregates zero items, and the run reports **success with
  `data: []`**. Build the stitch per run, or dedupe in `output`.
- **Drift can manufacture an empty page mid-collection.** Enough deletes and the client's next
  offset is past the end of a collection that still has unread rows. Same break, same silent
  success, and the shrunken `total` makes it reconcile perfectly.
- **`pages` defaults to 50 and its terminus is silent.** A collection larger than 50 × `limit`
  returns a prefix, `ok`, with no error and no event distinguishing "the cap stopped me" from "the
  collection ended". Always set it, and always compare `pagesFetched` to it.
- **Omitting `items` on an enveloped API silently makes every count meaningless.** The default wraps
  a non-array body as `[value]`, so the aggregate is one element per PAGE. `data.length` looks like
  a row count and is not.
- **`.report()` / `.inspect()` cannot tell you about the run you made.** They are fresh probes: the
  probe re-paginated the collection (3 more requests) and, the write having settled, did not
  reproduce the duplicate at all.
- **A rejecting `output` gives `.safe()` a generic message.** The issue text naming the duplicate ids
  is only in `.report().findings`; `error.message` is `contract violation (drift)`, and `data` is
  `null` — every row already collected is dropped unless you read `.report().raw`.
- **A failed paginated run emits no `result` event.** Anything that fails the run — an `output`
  rejection, a surface rejection — discards the pages already aggregated as far as `.safe()` is
  concerned.
- **Sending a composite cursor does not make an endpoint a seek endpoint.** If the vendor's
  `ORDER BY` is not a total order, the correct four-line keyset loop still lost `["r03"]` and
  duplicated `["r13"]` on static collections. Verify the sort, not the parameter names.
