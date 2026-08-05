# Issue draft — `.stream()` is not memory-bounded, and `decode: 'json'` buffers the array it streams

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`large-response-memory`](../large-response-memory.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `bug`, `stream`, `memory`

> Two defects, both located to a specific line, both with a control proving the surrounding code
> is fine. Together they mean the library ships an O(1) NDJSON decoder that no configuration can
> actually benefit from.

Reproduce (needs `--expose-gc`):

```bash
for f in docs/scenarios/proofs/large-response-memory/c[0-9]*.ts; do pnpm exec tsx --expose-gc "$f"; done
```

---

## 1. The engine retains every chunk, so no accessor is memory-bounded

**Severity: high — it defeats the entire purpose of the streaming path.**

`engine.ts:1443` pushes every delta onto a `chunks` array unconditionally, so the terminal
`result` can mirror the whole spine. The line is honest about it — there is a MEMORY NOTE at
`:1437-1442` — but the mitigation it recommends does not work:

> _"A consumer of an unbounded stream should read the `delta` events incrementally (via
> `.stream()`)…"_

Measured: **`.stream()` 30.2 MB vs `await` 33.5 MB** for the same 100k rows. The accumulator is
_inside_ the generator both accessors drain, so iterating escapes nothing, and no option
disables it.

The waste is precise, because the decoder underneath is excellent:

|                                                                    | retained heap                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `ndjson` decoder driven **directly**, 1,000,000 rows / 214 MB wire | **0.8 MB** (<15% movement over a 1000× workload change) |
| the same decoder **through the engine**, 10k → 100k rows           | 3.5 MB → **30.2 MB** (linear)                           |

**Ask:** make retention opt-out, or automatic when the caller uses `.stream()`. Something like
`stream: { retain: false }`, or simply not accumulating when the consumer is iterating rather
than awaiting. Today the O(1) decoder is unreachable from any configuration — the only way to
get a bounded export is a custom `Surface.stream` that yields a _receipt_ per batch instead of a
row per row (75 lines; measured **1.3 MB flat for 100,000 rows**, a 40× cut).

At minimum the MEMORY NOTE should be corrected — it currently points readers at a mitigation
that measures identically to the thing it's mitigating — and the claim at `engine.ts:1242-1247`
that `.stream()` "buffers nothing" should be qualified: true about latency, false about memory.

## 2. `decode: 'json'` buffers the whole array it is streaming

**Severity: high — it fails on its own default, and the message blames the vendor.**

Emission is **correct**, and worth saying so: one delta per top-level element, holding up under
`,` `]` `}` inside string values, escaped quotes, embedded newlines, pretty-printed multi-line
records, deep nesting, and 1-character chunk boundaries. The parser is good.

Memory is not. Retained heap tracks the **whole array text** at 0.88× the wire, with 34× growth
over a 100× workload, and time is **quadratic** (28× for 10× the rows).

**Root cause, one branch:** `compact()` floors on `valueStart`, and for a top-level array
`valueStart` is set to the opening `[` and only reset at the closing `]`
(`json-stream.ts:157-171`, `:173-195`, `:227-238`). So `compact(live)` is a no-op for the entire
array and nothing is ever released.

**The control proves it is not a design limit:** the same 100,000 records as **concatenated
top-level values** — the other thing this decoder accepts — run **flat at 0.9 MB**.

**The consequence is a silent truncation.** The decoder trips its own 8,388,608-char default
(`json-stream.ts:20-27`, `:89-97`): 37,000 rows decode, 38,000 fail. On a 60,000-row array the
consumer receives **37,312 rows, then `error` / `done(ok: false)`** — invisible to any loop that
only matches `delta`. And the message, _"a malformed or never-closing value was streamed"_,
accuses the vendor of something it did not do.

**Ask:** reset `valueStart` per top-level element inside an array, the way the concatenated-value
branch already does. Failing that, the cap message should distinguish "this value is too large"
from "this array is too long", because they need opposite fixes — and raising the cap converts
the failure into the memory profile the user was trying to avoid (18.8 MB retained, **405 MB peak
allocation** for a 21 MB body).

## 3. Buffered/streaming path asymmetries, all silent

Scenario 5 found `retry` inert and `interpret` never called on `runStreaming`. Three more:

- **`pick` and `transform` do not run on a stream.** `transform` called **zero** times over 200
  deltas; `pick: 'id'` left the whole row. Both behave normally on the buffered path. No `info`,
  no drift finding, no throw — and the static delta type derives from `output`, never `pick`, so
  the call site doesn't catch it either. A stitch carrying them that is later switched to
  `kind: stream` keeps compiling and quietly stops reshaping.
- **`output` on a stream validates but does not transform.** `engine.ts:1419` keeps only
  `{ errors }` where `engine.ts:1223` on the buffered path serves the validated value. A coercing
  schema reshapes your data on `await` and silently does not on `.stream()`.
- **`stream({ kind: mySurface })` silently drops the surface** — `stream()` overwrites `kind`
  after spreading the caller's config (`stream.ts:138-146`; `sse.ts:205-212` has the same shape).
  Measured: 1,000 raw rows, **0** through the surface, no error. It must be `stitch({ kind })`.

The engine already has a precedent for warning about an ignored config slot — an upload-progress
bar the transport can't draw emits an `info` event (`engine.ts:1694-1698`). These four slots get
nothing.

## 4. Nothing guards the buffered path

A 21 MB response emits exactly `start`, `progress:request`, `result`, `done` — the same four
events a 40-byte one emits. No threshold, no `info`, no drift finding.

When the wall arrives it is V8's, not the library's: 400,000 rows under a 96 MB heap gave
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, **exit 134
(SIGABRT)** — no catchable error, no `error` event, no `finally`. The same rows batched over
`ndjson` under the same ceiling: **1.3 MB, every row processed.**

And the one config slot with `buffer` in its name is **accepted on a buffered stitch and does
nothing** — `stream: { buffer: { chars: 1_000 } }` typechecked, composed, and delivered all
50,000 rows of an 11-million-character body.

**Ask:** a response-size threshold that emits an `info`/drift finding on the buffered path would
turn an unattributable 3am `SIGABRT` into a signal, without changing any behaviour.

## 5. Two things that are fine, recorded so the fix doesn't chase them

- **`output` is innocent.** It runs **per delta** — 500 calls for 500 records, each carrying one
  object, `sawArrayOfLength: 0`, even when the wire is literally one array. Heap cost within 1%.
  The capture predicted it would re-buffer; it does not.
- **Backpressure propagates properly.** A consumer awaiting a macrotask per row kept the producer
  within 8 chunks of 32; a lazy producer's queue stayed at 1.3% of the body. The chain is
  pull-based end to end. (Note for anyone measuring: a backlogged socket is invisible to
  `heapUsed` — it's external memory, visible only in `arrayBuffers`.)
- **The buffered multiplier is `JSON.parse`'s, not the library's** — measured 2.5×, and
  StitchAPI's overhead over a bare `JSON.parse` of the same bytes was **0.2 MB**.
