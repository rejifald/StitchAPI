# Proofs — the 84 MB response that took 2.1 GB of heap

Runnable evidence for the claims in [`../../large-response-memory.md`](../../large-response-memory.md).

**Both deciding claims came back split — and the split C3 found is now fixed in core.** C3 hoped
`decode: 'json'` would make the hard case — one giant top-level array — a config value. At capture
time it half did: emission was genuinely correct (one delta per element, holding up under `,`/`]`/`}`
inside string values, escaped quotes, embedded newlines, pretty-printed multi-line records, deep
nesting, and 1-character chunk boundaries) and the memory was **not bounded at all** — the decoder
retained the whole array text, so on default settings a 60,000-row export delivered 37,312 rows and
then failed with an error blaming the vendor. That defect was filed as **#659 §2 and fixed by #665**:
a top-level array records no compaction floor of its own, so elements are released as they close, and
the same 100,000-row array now decodes **flat — 0.6 MB, under 3% of the wire, in linear time — and
finishes on the default cap**. C4 feared `output` would re-buffer the stream to validate the aggregate. It does
not: the contract runs **per delta**, was called 500 times for 500 records, never once saw an array,
and costs nothing measurable.

**The finding neither claim was looking for is one line of the engine, and it is still open (#659 §1).**
`runStreaming` pushes every emitted delta onto a `chunks` array so the terminal `result` can mirror
the whole spine ([`engine.ts:1492`](../../../../packages/core/src/engine.ts)). It is unconditional,
it is not gated on the accessor, and no config turns it off. So the `'ndjson'` decoder — which really
is O(1), 0.8 MB of retained heap for **1,000,000 rows and 214 MB of wire** — becomes O(N) the moment
the engine wraps it, and `.stream()` costs the same as `await` (30.2 MB against 33.5 MB at 100k
rows). The library owns a genuinely bounded decoder and spends the win one line later.

Every script is standalone and offline. Each prints one `PASS`/`FAIL` line and exits non-zero on
failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/large-response-memory/c3-json-single-array.ts

# all of them (slow — each spawns a dozen child processes; ~6 minutes)
for f in docs/scenarios/proofs/large-response-memory/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

### `--expose-gc`, and where it is required

The claim scripts (`c1`…`c8`) do **not** need it — they measure nothing themselves. They spawn
[`probe.ts`](./probe.ts), which does, and [`run-probe.ts`](./run-probe.ts) passes the flag for them.

To take a single measurement by hand you must pass it yourself:

```sh
pnpm exec tsx --expose-gc docs/scenarios/proofs/large-response-memory/probe.ts \
  --mode=buffered --rows=100000
# {"mode":"buffered","rows":100000,"ok":true,"wireBytes":22489287,"peakLive":56391584, …}
```

`probe.ts` calls `requireGc()` ([`mem.ts`](./mem.ts)) before anything else and **exits 2 with a
message** if `global.gc` is absent, rather than quietly reporting the noisy number as if it were the
clean one.

They typecheck under `packages/core`'s full strict set (`--ignoreConfig` is required since
TypeScript 6 — files on the command line no longer silently skip the local `tsconfig.json`):

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/large-response-memory/*.ts
```

## Methodology — what is solid and what is noisy

This is the first scenario in the set whose evidence is a **number** rather than a value, and heap
numbers lie in several different ways. The measurement is built to make each one visible.

**One process per measurement.** V8's heap is stateful: the second workload in a process inherits the
first one's fragmented old space and its grown heap limit. Every number in this directory comes from
its own `probe.ts` process.

**Two numbers, and only one of them decides anything.**

- `peakLive` — the high-water mark of `heapUsed` sampled **immediately after a forced full GC**. This
  is retained, reachable memory: what cannot be collected under pressure. Nearly noise-free.
  **Every verdict here is based on `peakLive`.**
- `peakHeap` — the high-water mark of plain `heapUsed`, floating garbage included. Real (an
  allocation rate the collector cannot keep up with is exactly how a process dies) but noisy, and
  reported only as context. For the `'json'` decoder on a big array it still runs >10x `peakLive` —
  transient per-element slices the collector keeps up with (8.3 MB peak against 0.6 MB live at 100k
  rows). Pre-#665 that gap was 405 MB against 18.8 MB, and it was a finding — see C3.

**The sampler lives on the producer.** A `setInterval` sampler cannot preempt a synchronous
`JSON.parse`, and an in-memory `ReadableStream` resolves reads on the _microtask_ queue, which starves
timers completely. So the workload samples itself, once per emitted wire chunk, from
[`Wire.watch`](./fake-export.ts). Putting it there rather than in each consumer is what makes the
modes comparable: a consumer-side sampler gives `.stream()` a thousand chances to catch a peak and
`await` exactly none, and the resulting "await uses less heap" is an artefact of the instrument. (An
earlier draft of this directory made precisely that mistake and measured `await` 21 MB _cheaper_ than
`.stream()`.) The two buffered modes take two extra marks — whole text live, then text and tree both
live — because that path's peak happens after the last byte arrives; that asymmetry favours the
streaming modes, not the buffered one.

**Ratios and shapes, not absolutes.** Every claim asserts on `peakLive(100k) ÷ peakLive(10k)` or on
`peakLive ÷ wireBytes`, never on a single figure. `checkFlat` / `checkLinear`
([`harness.ts`](./harness.ts)) print the growth either way.

**What is noisy, stated plainly:**

- **The 1,000-row point is floor-dominated and no claim asserts on it alone.** A run's one-time cost —
  module init, JIT, IC feedback vectors — is ~1.3 MB through the engine, six times the data at that
  size. It is reported (`settled` on every measurement is exactly this floor) and the growth
  assertions use the 10k→100k pair, where the signal is 20x the floor.
- **`heapUsed` does not see the socket.** A `Uint8Array`'s backing store is external memory, so a
  response sitting unread in a `ReadableStream`'s queue is invisible to it. C6 turns on this
  distinction, so `peakBuffers` (`memoryUsage().arrayBuffers`) is tracked separately.
- **The 2.5x buffered multiplier is a property of the row shape**, not of Node and not of StitchAPI.
  Eight flat fields cost 2.5x; the incident's ~25x implies far more per-object overhead. The number
  that transfers between machines is the **slope** (linear), not the constant.
- Measured on **Node v24.18.1, arm64 macOS**. Absolute megabytes will differ elsewhere; the
  flat-vs-linear shapes will not.

## What each script establishes

| Script                    | Question                                            | Measured                                                                                                |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `c1-buffered-baseline.ts` | `await` a big array — multiplier? shape?            | **2.5x, LINEAR, and identical to bare `JSON.parse` within 0.2MB.** 21.4MB wire → 53.8MB                 |
| `c2-ndjson-flat.ts`       | does `decode: 'ndjson'` stay flat?                  | **The DECODER does (0.8MB at 1M rows). The ENGINE does not** — 3.5MB → 30.2MB over 10x                  |
| `c3-json-single-array.ts` | **DECIDING.** one giant array — streams or buffers? | **Streams, since #665: flat (0.6MB at 100k / 21.4MB wire), linear time, cap bounds one ELEMENT**        |
| `c4-output-per-delta.ts`  | **DECIDING.** `output` — per delta or aggregate?    | **Per delta. 500 calls / 500 rows, `sawArrayOfLength` 0, and free in heap terms**                       |
| `c5-pick-transform.ts`    | `pick` / `transform` on a stream                    | **Neither. Not called once, no `info`, no throw — and they work on the buffered path**                  |
| `c6-backpressure.ts`      | slow consumer, and what the cap does AT the cap     | **Backpressure propagates (~8% high-water vs the eager 100%). The cap THROWS. Neither bounds the call** |
| `c7-buffered-guard.ts`    | any guard on the buffered path?                     | **None. Four events either way, `buffer.chars` inert — and 400k rows under 96MB is SIGABRT**            |
| `c8-assembled.ts`         | the assembled answer, priced                        | **1.3MB flat vs a 53.8MB baseline. One seam, 75 lines, and `stream({ kind })` silently drops it**       |

## Files

- `fake-export.ts` — the vendor. Everything is **lazy**: rows are generated inside the stream's
  `pull()`, one ~16 KB chunk at a time, so the fixture never exists as a whole and the numbers are
  about the library rather than about this file. Six wire shapes: `singleArray` (the hard case),
  `concatObjects` (the control that localised C3's pre-#665 defect), `ndjson`, `eagerArray` (a producer that
  ignores backpressure), `neverClosingArray` and `noNewlines` (the two shapes the cap exists for).
  Plus `bufferingAdapter`, which mirrors `fetchAdapter`'s non-streaming path byte for byte
  (`http-adapter.ts:133-138`) and offers a hook at the instant text and tree are both live.
- `mem.ts` — the measurement kit: `requireGc()`, and `measure()` returning `peakLive` / `peakHeap` /
  `peakBuffers` / `settled` / `ratio`. The header states the methodology in code.
- `probe.ts` — one measurement, one process, one line of JSON. Thirteen modes. A workload that BLEW
  UP prints `{ok: false, error}` on stdout rather than a stack trace on stderr — C3's original
  (pre-#665) finding was one of those, and C7's OOM corpse still is.
- `run-probe.ts` — spawns it. `probeRun` keeps the corpse (exit status, stderr, an `heapOom` flag) so
  C7 can assert on a process that died.
- `validator-spy.ts` — an instrumented `Validator`. C4 is a mechanism question, and the honest way to
  answer it is a **counter**: 100,000 calls each carrying one row and one call carrying a
  100,000-element array are different facts, not two readings of one number.
- `batched-export.ts` — **the C8 deliverable, and it is user code.** A `Surface` whose `stream` hook
  consumes rows and yields one small receipt per batch, so the engine's `chunks` array holds batches
  instead of rows. 75 counted lines.
- `hand-rolled.ts` — the same feature set with no library at all. 67 counted lines. The baseline C8
  prices against.
- `harness.ts` — `check` / `checkSeq` / `checkFlat` / `checkLinear` / `checkAtMost` / `checkAtLeast`.
  Exact equality for the correctness half, shape assertions for the heap half.

## Reading the numbers honestly

- **C1: the buffered path adds nothing and bounds nothing.** 100k rows / 21.4 MB of wire peaked at
  53.8 MB retained; bare `JSON.parse` of the same bytes cost 53.6 MB. `await stitch()` **is**
  `JSON.parse`, and `JSON.parse` is linear with no ceiling. The 2.5x here is not the incident's 25x,
  and saying so is more useful than quietly reproducing the bigger number: what generalises is that
  the slope is 1, and the constant is your row shape's.
- **C2 is the sharpest result in the scenario and it has two halves.** The `'ndjson'` decoder, called
  exactly as the engine calls it, held **0.8 MB for 1,000,000 rows and 214 MB of wire** and moved less
  than 15% across a 1000x change in workload. That is a genuinely O(1) decoder, and it also proves the
  instrument works. Through the engine the same decoder went 3.5 MB → 30.2 MB over 10x the rows.
- **The engine's accumulator is the finding, and it is documented — in a code comment.**
  `engine.ts:1486-1491` says outright that `chunks` "grows for the life of the connection" and that
  "awaiting such a stitch to completion is intentionally not memory-bounded". None of that reaches the
  public docs, the types, or a runtime event. The same file's header comment (`engine.ts:1287`) says
  `.stream()` "buffers nothing", which is true about latency and false about memory.
- **`.stream()` is not the memory fix everyone assumes.** 30.2 MB iterating, 33.5 MB awaiting. Both
  accessors drain the same generator and the accumulator is inside it. The idiom that reads like the
  answer — `for await (const ev of export.stream())` — changes when you see a row, not how many rows
  are alive.
- **C3: `decode: 'json'` streams — since #665 — and the original defect is worth the history.** At
  capture time the decoder streamed the PARSE and buffered the TEXT: emission was genuinely correct
  under every adversarial input tried, while retained heap tracked the whole array at 0.88x the wire
  (34x growth over a 100x workload) and time was quadratic (28x for 10x the rows), because `compact()`
  floored on a `valueStart` pinned at the array's opening `[`. It therefore tripped its own 8M-char
  default guard at ~37,000 rows: a 60,000-row array delivered **37,312 rows** and then `error` /
  `done(ok:false)` under `a malformed or never-closing value was streamed` — nothing was malformed, and
  a `.stream()` loop matching only `delta` saw a silent truncation. Filed as **#659 §2; fixed by #665**.
- **Post-fix, both shapes are floor-dominated noise.** A top-level array records no compaction floor
  of its own (`json-stream.ts:166-174`); between elements the window falls back to the scan cursor, so
  emitted elements are released as they close (`json-stream.ts:236-247`) — exactly how the
  concatenated form always released. Measured: **0.6 MB retained at 100k rows / 21.4 MB of wire**
  (2.8% of the wire, against 0.88x pre-fix), 45 ms → 212 ms for 10x the rows (linear; was 28x), and
  the concatenated control measures alike at **0.9 MB**. 38,000 and 100,000 rows both decode **on the
  library-default cap** where 38,000 used to fail, and the 60,000-row export arrives whole with a
  clean `result` / `done`.
- **The cap keeps its teeth, and its meaning sharpened.** It bounds ONE value, so an array is capped
  by its largest ELEMENT rather than by its length (`json-stream.ts:20-28`). A single element pushed
  past the cap still trips the guard with the same message — which now describes the only case that
  can produce it.
- **C4 refutes its own hypothesis, cleanly.** The instrumented contract was called 500 times for 500
  records, every call carrying one object, `sawArrayOfLength` stayed 0 — including when the wire was
  literally one top-level array. Cost: 30.2 MB against 30.2 MB on both decoders (post-#665 the `json`
  pair runs on the default cap and costs what `ndjson` costs). `output` is innocent.
- **But it does two things a config author will not expect.** A failing row is a **circuit breaker,
  not a filter**: `contract violation (drift)`, the stream ends, rows already delivered stay and the
  rest are never read. And on a stream `output` **validates without transforming** — `engine.ts:1468`
  destructures `{ errors }` and discards the validated value, where `engine.ts:1264` on the buffered
  path serves it. The same coercing schema reshapes your data on `await` and silently does not on
  `.stream()`.
- **C5: the capture asked the wrong question.** `pick` and `transform` are not per-delta and not
  buffering — they do not run. `transform` was called zero times over 200 deltas; `pick: 'id'` left
  the whole row in place. The same two slots on the same fake vendor over the buffered path behave
  exactly as documented, so this is a path asymmetry, not a broken hook — and it is silent, with the
  static delta type derived from `output` rather than `pick`, so the call site does not catch it.
- **C6: three different things wear the word "buffer" and only one of them is capped.** The socket
  queue is bounded by the reader pulling (~8% of the body high-water with a lazy producer — part of
  it dequeued chunks the collector has not swept, now that #665's linear scan forces fewer
  collections; 100% with one that ignores `desiredSize` — and that backlog is invisible to
  `heapUsed`). The decoder's working buffer is what `stream.buffer.chars` caps, per un-terminated
  **unit**. The engine's `chunks` array is capped by nothing.
- **At the cap all three decoders THROW.** `json`, `ndjson` and `lines` each produced an `error` event
  plus `done(ok:false)` with zero deltas from the offending unit. Not a truncation, not a pause.
- **And the cap is a malformed-input guard, not a memory budget.** 20,000 well-formed rows streamed
  cleanly through a **1,000-character** cap while the engine accumulated all 20,000 of them.
- **C7: there is no guard, and the only signal is the process dying.** A 21 MB buffered response emits
  the same four events a 40-byte one does. `stream: { buffer: { chars: 1_000 } }` on a plain `stitch()`
  type-checks, composes, and delivers all 50,000 rows of an 11-million-character body. At 400,000 rows
  under a 96 MB heap: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
memory`, exit 134 — no catchable error, no `error` event, no `finally`. The same 400,000 rows and
  85.8 MB of wire, same ceiling, batched over `ndjson`: **1.3 MB and every row processed.**
- **C8: achievable, one seam — and since #665, either wire format.** `Surface.stream` is the
  seam — not to replace the decoding (`ndjson` is already O(1)) but because the engine keeps whatever
  that hook yields, so the fix is to yield receipts. 1.3 MB flat against a 53.8 MB baseline, 75 lines
  of surface plus 4 of config against 67 lines hand-rolled. The lines are a wash; what the config buys
  is the stack around the open (`auth`, `retry` on the connect, `throttle` charged per open,
  `timeout.total`, `trace`, `verdict.accept`), all of which keep working through a custom surface.
- **And the seam's one blind spot closed with #665.** The seam only fixes what is downstream of it,
  and C3's array buffer sat upstream: pre-fix the same surface still cost 19.0 MB over one giant
  array, and on default settings that call would not have finished at all. Post-fix it measures
  **1.4 MB on the default cap** — the same as over `ndjson`.

## The footguns

- **`stream({ kind: mySurface })` silently drops your surface.** `stream()` spreads your config and
  then writes `kind: streamSurface` over it (`stream.ts:147-150`; `sse()` does the same at
  `sse.ts:210-213`). Measured: 1,000 raw rows delivered, zero rows through the custom surface, no
  error, no warning. The assembled answer only works spelled `stitch({ kind })` — and the spelling
  that undoes it is the one the surface helper invites.
- **`decode: 'json'` over one top-level array is only the fix on a core that includes #665.** On
  earlier releases it looked exactly like the fix and was not one: elements arrived one at a time —
  streaming in the debugger — while the decoder held every byte of the array, failed at ~37,000 rows
  of this shape with an error that sent you to the vendor's docs, and raising `stream.buffer.chars`
  only bought back the memory profile you were avoiding (18.8 MB retained, 405 MB of peak allocation
  for a 21 MB body). Post-#665 the decoder is bounded; the engine above it still is not — `chunks`
  retains every element, so `.stream()` is no more memory-bounded here than on any other decoder.
- **`stream.buffer.chars` is not a memory budget.** It bounds ONE un-terminated line / value / SSE
  frame. It says nothing about how much the call may use, and it is completely inert on the buffered
  path even though the type accepts it there.
- **`.stream()` does not bound memory.** Same generator, same `chunks` array, 30.2 MB either way.
  The one accessor everybody reaches for when they hear "streaming" is not the fix.
- **A per-delta `output` failure ends the export.** It is a circuit breaker, not a `.filter()`. If one
  bad row in a 100,000-row catalog should not abort the sync, the contract has to live in your
  consumer, not in `output`.
- **`output` on a stream validates without transforming.** Coercions, defaults and key-stripping that
  work on `await` are dropped on `.stream()` (`engine.ts:1468` vs `engine.ts:1264`). A schema that is
  load-bearing for shape is silently decorative on the streaming path.
- **`pick` and `transform` are dead on a streaming stitch** — no call, no `info` event, no throw, and
  no type error, because the delta type is derived from `output`. A stitch that carries them and is
  later switched to `kind: stream` keeps compiling and quietly stops reshaping.
- **`heapUsed` will not show you a backlogged socket.** A producer that ignores backpressure parks the
  whole body in the stream's internal queue as `Uint8Array`s, which live in external memory. Watch
  `memoryUsage().arrayBuffers`, or conclude a 21 MB backlog is free.
- **The one honest warning about all of this is a code comment.** `engine.ts:1486-1491` states that an
  unbounded stream "grows memory without limit" and that a consumer "MUST NOT rely on the accumulated
  final result". It is not in the docs, not in the types, and not in any event the engine emits.
