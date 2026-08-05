# Scenario: the 84 MB response that took 2.1 GB of heap

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `large-response-memory`

**Verification:** 8 proof scripts (97 checks), run offline, one process per measurement,
`peakLive` = high-water `heapUsed` after a forced GC. Requires `--expose-gc`. In
[`proofs/large-response-memory/`](proofs/large-response-memory/). Published page:
[`scenarios/large-response-memory.mdx`](../../apps/docs/content/docs/scenarios/large-response-memory.mdx).
Escalated: [`issue-drafts/streaming-is-not-memory-bounded.md`](issue-drafts/streaming-is-not-memory-bounded.md).

| Claim                               | Verdict                                     | Measured                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — buffered baseline              | linear, and **fair to the library**         | 21.4 MB wire → **53.8 MB** retained (2.5×), matching a bare `JSON.parse` to within **0.2 MB**. The multiplier is `JSON.parse`'s                                          |
| C2 — `ndjson` flat?                 | **NO — and the two halves are in one call** | decoder driven directly: **0.8 MB for 1,000,000 rows**. Through the engine: **3.5 → 30.2 MB** (linear). `.stream()` 30.2 vs `await` 33.5 — the same number twice         |
| C3 — `decode: 'json'` on one array  | streams the parse, **buffers the text**     | emission correct under every adversarial case; heap tracks the whole array at **0.88× wire**, time quadratic; trips its own cap at **37,000 rows** and blames the vendor |
| C4 — does `output` re-buffer        | **capture REFUTED — innocent**              | 500 calls for 500 records, each one object, `sawArrayOfLength: 0`; heap within 1%                                                                                        |
| C5 — `pick`/`transform` on a stream | neither runs                                | `transform` called **0** times over 200 deltas; completely silent                                                                                                        |
| C6 — backpressure                   | propagates; the cap throws                  | producer stayed within 8 chunks; 20,000 rows streamed through a **1,000-char** cap while the engine kept all 20,000                                                      |
| C7 — guard on the buffered path     | **none**                                    | 400,000 rows under a 96 MB ceiling → `FATAL ERROR … heap out of memory`, **exit 134**, no catchable error, no `finally`                                                  |
| C8 — assembled                      | PASS                                        | **1.3 MB flat vs 53.8 MB** — a 40× cut — via `Surface.stream` yielding a receipt per batch. 75 lines + 4 config vs 67 hand-rolled                                        |

**One hypothesis refuted in the library's favour, one confirmed worse than feared.** `output`
does _not_ re-buffer a stream — it validates per delta and costs nothing. But the memory the
capture went looking for is spent somewhere it didn't think to look: `engine.ts:1443` retains
every chunk unconditionally, so **the library owns a genuinely O(1) NDJSON decoder and spends
the win one line later** — and `.stream()`, the mitigation the engine's own MEMORY NOTE
recommends, measures identically to `await`.

**The `decode: 'json'` defect is one branch, not a design limit.** `compact()` floors on
`valueStart`, which for a top-level array is the opening `[`, so nothing is released until `]`.
Control: the same 100,000 records as _concatenated top-level values_ run **flat at 0.9 MB**.

---

## The use case

You call an export endpoint — a product catalog, a transaction ledger, a bulk query result.
The vendor hands back **one JSON array** with tens of thousands of rows. You `await` it, parse
it, and iterate.

Then one day the catalog grows, and the process dies.

## Why it is not straightforward

**Parsing costs several times the wire size.** `JSON.parse` has to hold the whole string _and_
build the complete object tree, and the tree is commonly 2–5× the raw bytes. In practice it is
worse than the rule of thumb: a documented sync of **22,000 products in an 84 MB response
exhausted ~2.1 GB** on a 4 GB VPS — roughly **25×**. After restructuring to a streaming parse
with batching, the same sync ran in 4 minutes at **180 MB peak**.

This failure mode is different from every other scenario in this section: nothing returns wrong
data. The process simply dies, usually in the middle of the night, usually after the dataset
crossed a threshold nobody was watching.

The awkward parts:

- **You can't size it in advance.** A chunked response has no `Content-Length`, so "check the
  size first" isn't available. And the threshold moves as the customer's data grows.
- **A single top-level JSON array is the hard case.** NDJSON streams trivially — one line, one
  record, discard, repeat, ~1 MB peak for a 1 GB file. A single `[ {...}, {...}, … ]` cannot be
  split on newlines; it needs a _structural_ parser that emits each top-level element.
- **Validation quietly re-buffers.** Streaming the rows and then validating "the result" puts
  the whole array back in memory. Any per-response contract defeats the streaming it sits above.
- **Backpressure is the second collapse.** If the consumer is slower than the producer and the
  code ignores the signal to slow down, Node buffers chunks until the process falls over — the
  memory arrives from the _other_ direction.
- **The fix changes the shape of your code.** Buffered code says `const rows = await get()`.
  Streaming code says `for await (const row of get.stream())`, and everything downstream —
  batching, transactions, error handling — has to change with it.

## Evidence this bites real projects

- **The 84 MB → 2.1 GB incident** and its 180 MB streaming fix are documented in
  [Handling massive JSON payloads without crashing your workflow runner](https://triumphoid.com/handle-massive-json-payloads-without-crashing-workflow-runner/).
- **The parse multiplier** — an object tree 2–5× the raw string — is the consistent number in
  [Memory-safe large JSON streaming](https://www.technetexperts.com/memory-safe-json-streaming-node-bun/)
  and [parsing large JSON in Node](https://salivity.github.io/node.js/article/parsing-large-json-in-node-js-performance-impacts).
- **NDJSON's O(1) property** — ~1 MB peak for a 1 GB, million-record file — is the standard
  contrast ([Jsonic on JSON streaming](https://jsonic.io/guides/json-streaming)).
- **Backpressure blindness** is its own documented collapse:
  [your Node.js streams aren't backpressuring, they're silently eating your memory](https://frontendmasters.com/blog/your-node-js-streams-arent-backpressuring-theyre-silently-eating-your-memory/).
- **JSONStream #101** — ["Node process goes out of memory while parsing large JSON files"](https://github.com/dominictarr/JSONStream/issues/101) —
  is the same complaint against the streaming library itself.

## The common solutions, and what each costs

| Approach                                        | What it is                            | Where it breaks                                                                                                         |
| ----------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **`await res.json()`**                          | The default.                          | Dies above some size you cannot predict, and the multiplier is ~25× in the field, not the 2–5× folklore.                |
| **Ask the vendor for NDJSON**                   | Newline-delimited, streams trivially. | The correct fix where offered — Shopify bulk results, some exports. Most REST endpoints don't.                          |
| **Structural streaming parser** (`stream-json`) | Emits each top-level array element.   | The real answer for a single giant array. A dependency, and the pipeline is fiddly to assemble.                         |
| **Paginate instead of exporting**               | Ask for pages, not the whole thing.   | Bounded memory — and inherits every problem in [the pagination scenario](unstable-pagination.md), plus N× the requests. |
| **Raise the heap** (`--max-old-space-size`)     | Buy headroom.                         | Moves the cliff without removing it, and the cliff moves toward you as data grows.                                      |
| **Batch + null out references**                 | Process N at a time, release.         | Necessary alongside streaming; useless on its own if the parse already buffered.                                        |

**Summary of the state of the art:** stream structurally, batch the consumer, keep validation
per-record rather than per-response, and honour backpressure. The distinguishing property is
that the _default_ path is the dangerous one, and it works fine until it doesn't.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- The `stream` surface takes `decode: 'bytes' | 'lines' | 'ndjson' | 'json'`, and `'json'` is
  documented as _"the structural, unframed streaming-JSON decoder (issue #111): one `delta` per
  complete value / top-level array element, tolerant of internal newlines and concatenated
  values"_ (`types.ts:1441-1450`). **If that holds, the hard case — one giant array — is a
  config value**, which would make this one of the few scenarios with a genuine built-in answer.
- `stream.buffer.chars` exists as a cap. What happens _at_ the cap is the open question: does it
  throw, truncate, or apply backpressure?
- **The validation question is the sharp one.** Scenario 12 measured the engine serving the
  _validated_ value, and scenario 11 measured `output` running over the whole aggregated array.
  If `output` on a streaming stitch buffers every delta to validate the aggregate, the streaming
  is undone — and the config would look correct.
- Scenario 5 measured the streaming path is a different engine (`runStreaming`) with different
  rules — `retry` inert, `interpret` never called. Expect more asymmetries here.

**Claims to test with runnable offline code:**

1. **C1** — measure the baseline. `await` a large JSON body and record the **heap high-water
   mark** against the wire size. Confirm the multiplier on this runtime.
2. **C2** — `stream` with `decode: 'ndjson'`: does heap stay flat as the body grows? Measure
   peak against 1×, 10× and 100× row counts.
3. **C3** — **DECIDING CLAIM.** `decode: 'json'` against **one single top-level array**. Does it
   emit one delta per element without buffering the whole array? Measure peak heap, and confirm
   the element count and boundaries are right (including elements containing internal newlines).
4. **C4** — **DECIDING CLAIM.** Add an `output` schema to a streaming stitch. Does validation run
   **per delta** or over the **aggregate**? Measure peak heap with and without it. If it
   re-buffers, that is the finding.
5. **C5** — `pick` / `transform` on a streaming stitch: per-delta or buffering?
6. **C6** — backpressure: a slow consumer against a fast producer. Does the stream buffer
   unboundedly? What does `stream.buffer.chars` do at the cap — throw, truncate, or block?
7. **C7** — is there any guard on the **buffered** path? A response larger than some limit on a
   plain `await` — does anything intervene, or is OOM the only signal?
8. **C8** — assemble the best available answer: stream, validate per record, batch the consumer.
   Report the seam and line count, and measure peak heap against the buffered baseline.

C3 and C4 decide this. A structural JSON decoder that genuinely streams a single array would be
a real capability few clients have — and an `output` schema that silently re-buffers it would
hand the memory straight back.
