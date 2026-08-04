# Proofs — a stream that fails after you've already shown the user 800 tokens

Runnable evidence for the claims in
[`../../mid-stream-failure.md`](../../mid-stream-failure.md).

Every script is standalone, offline, and deterministic: it injects a fake `text/event-stream`
provider through StitchAPI's `adapter` (or `Surface.execute`) seam and drives every wait off an
injected `manualClock()`, so a nine-second reconnect backoff is exact **virtual** time — no real
sleeping, nothing flaky, no network.

**The measurement is a sequence, not a number.** The whole scenario turns on "what did a downstream
accumulator actually receive", so `observe()` drains `.stream()` and reports the exact delta
sequence, the concatenated token text, the tagged event spine and the reconnect boundaries. Tokens
are single letters, so duplication is legible at a glance: a correct run reads `ABCDE` and a
replayed one reads `ABCDEABCDEABCDEABCDE`. On the provider side, `opens.length`, `lastEventIds` and
`gaps` make "it reconnected", "it sent the right header" and "it waited what the server asked" three
measurements rather than three arguments.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c4-openai-reconnect.ts

# all of them
for f in docs/scenarios/proofs/mid-stream-failure/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle. That matters here: this scenario is about code
shipped two commits ago (#622).

They typecheck under `packages/core`'s full strict set (the `@ts-expect-error` block in C8 is the
machine-checked half of that claim — a `@ts-expect-error` that is _not_ an error fails `tsc`):

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/mid-stream-failure/*.ts
```

## What each script establishes

| Script                      | Question                                          | Measured                                                                                                     |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `c1-drop-mid-body.ts`       | what does a `.stream()` consumer see on a drop?   | **An `error` event, not a throw** — and a CLEAN truncation is `result,done(ok:true)`, identical to success   |
| `c2-retry-on-a-stream.ts`   | does `retry` re-emit already-delivered deltas?    | **No — `retry` never runs on a stream.** 4 requests buffered vs **1** streaming, same config                 |
| `c3-resumable-reconnect.ts` | does `reconnect` resume a feed with `id:`?        | **Yes, cleanly.** `ABCDE` once, `Last-Event-ID` `[(none),t2,t5,t5]`. Costs 3 wasted opens on a finished feed |
| `c4-openai-reconnect.ts`    | …and against an OpenAI stream with no `id:`?      | **4× replay of a stream that never failed.** `ABCDEABCDEABCDEABCDE`, 24 deltas, `done(ok:true)`              |
| `c5-in-band-error.ts`       | can a `data: {"error"}` frame at 200 fail?        | **Only via `output`.** `interpret` runs **0 times** on a stream; `verdict.flag` inert; `onError` never fires |
| `c6-missing-done.ts`        | can "ended early" be told from "ended"?           | **Not by any built-in** — but 8 lines of surface `stream` hook makes it a named failure                      |
| `c7-partial-output.ts`      | is the partial reachable when a stream fails?     | **`.stream()` only.** `.safe().data` null, `error.body` undefined, `.inspect()` `data:null status:0`         |
| `c8-connect-vs-body.ts`     | connect-retry ON, body-retry OFF?                 | **Not in config.** One flag governs both phases. `Surface.execute` expresses it in 10 lines                  |
| `c9-assembled-solution.ts`  | best answer for the LLM case, and is it worth it? | **62 lines** across 2 seams vs **83** hand-rolled; byte-identical results on all 6 shapes                    |

## Files

- `fake-llm-stream.ts` — the providers. One class, three shapes: **OpenAI-shaped** (`data: {...}`
  frames, no `id:`, `data: [DONE]` terminator), **resumable feed** (`id:` on every frame, honours
  `Last-Event-ID`), and **connect-phase failure** (a 503 before any byte, optionally healing). Plus
  the failure knobs: `cut` (error the socket, or close it cleanly, after N frames — on chosen opens
  only), `errorFrameAfter` (an in-band error at HTTP 200), and `retryHint` (a server `retry:`
  field). Records every open with the virtual timestamp and the `Last-Event-ID` it received.
- `observe.ts` — the consumer-side instrument. Drains `.stream()` under the injected clock and
  returns `{ data, text, events, reconnects, dones, errorFrames, ok, error, threw }`.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.
- `llm-stream.ts` — **user code** for C9: `llmSurface()` (connect-only retry via `execute`; `[DONE]`
  requirement and in-band error detection via the `stream` hook) and `completion()` (drains
  `.stream()` and keeps the partial).
- `hand-rolled.ts` — the same five rules with no StitchAPI in them, including its own SSE frame
  parser, so C9's line-count comparison is honest and its behaviour comparison is exact.

## Reading the numbers honestly

- **C4 is a bug in freshly-shipped code, not a policy trade-off, and it is the finding of this
  scenario.** `sse: { reconnect: true }` on a clean OpenAI-shaped completion — one that reached
  `data: [DONE]` and closed normally — produced **4 opens, 24 deltas, 4 `[DONE]` sentinels** and
  the text `ABCDEABCDEABCDEABCDE` delivered to the consumer as one uninterrupted spine, ending
  `done(ok: true)`. Two independent defects compose. `resumable` is decided from surface
  CAPABILITY, once, before any frame is read (engine.ts:1288 ands the reconnect flag with the mere
  PRESENCE of `resumeToken` and `applyResume`), and `sseSurface` always exposes both hooks, so a
  stream with no `id:` anywhere is classified resumable. When the reopen comes, `lastToken` is
  still `undefined`, the guard at
  engine.ts:1344 skips `applyResume`, and the request goes out with **no `Last-Event-ID`** — a
  request for the whole completion, from token one. Separately, the reconnect loop treats a clean
  close (`'closed'`) exactly like a drop (`'error'`) at engine.ts:1466, so `[DONE]` terminates
  nothing and the attempt budget is always spent. The docs
  ([surfaces.mdx:83-99](../../../../apps/docs/content/docs/reference/surfaces.mdx)) say "a dropped
  stream is reopened"; they do not say a finished one is.
- **C2 refutes the capture in the safer direction, and the refutation matters more than the
  prediction.** The capture expects `retry` to duplicate deltas. It cannot, because `retry` does not
  run on a streaming stitch at all — `runStreaming` (engine.ts:1248) is a different function from
  the buffered `attemptLoop` and has no attempt loop in it. The control is exact: an identical
  four-attempt `retry` block against the same always-503 fake makes **4** requests on a buffered
  stitch and **1** on an `sse` one, with `error.attempts: 1`. `retry` is not fully ignored, though —
  `retry.backoff` supplies the reconnect CURVE (`fixed 5s` → measured gaps `5000,5000,5000`) while
  `retry.attempts` is inert there. Two knobs that read as one cap, capping different things.
- **C5 kills the seam that ought to have been the answer.** `Surface.interpret` exists precisely to
  say "this 200 is really a failure", and on a streaming surface it runs **0 times** — measured with
  a counter, not read off the source. `runStreaming` only ever calls `classifyStatus(res.status,
cfg)` (engine.ts:1371), which is deliberately status-only because there is no buffered body at
  open time. `verdict.flag` rides the same path and is silently inert — `ok: true`, and not even an
  `info` drift finding. What works is `output`: per-`delta` validation at engine.ts:1414-1436 runs
  BEFORE the delta is emitted, so a rejecting schema both fails the run and **withholds the bad
  frame** (measured: 0 error frames delivered). The price is a generic `contract violation (drift)`
  message; the schema's own wording survives only on `.report().findings`.
- **`hooks.onError` does not fire for ANY post-200 stream failure.** Measured hook sequence across a
  failing run: `[onRequest, onResponse]`. The mid-body catch at engine.ts:1446-1449 records the
  error and returns `'error'` without calling the hook — only the open-phase catch at
  engine.ts:1354 does. Any error pipeline built on hooks is blind to exactly the failures this
  scenario is about.
- **C7: the engine is holding the partial at the moment it discards it.** `chunks` accumulates every
  delta at engine.ts:1443; the failure path at engine.ts:1467-1472 emits `error` + `done` and
  returns **before** reaching `resultEvt(chunks, …)` at engine.ts:1492. Measured from outside:
  `delta` fired 3 times, `result` never did. And `.inspect()` — the accessor whose documented job is
  "what did the server actually send?" — answers `data: null`, `raw: null`, `status: 0`, so it does
  not even report the 200 that was received.
- **C8's config workaround is worse than the gap it fills.** `verdict.accept: [503]` does make a 503
  reconnectable (the accepted status streams a non-`ReadableStream` body, decodes nothing, returns
  `'closed'`). Measured against a healing server: 9 opens, answer replayed 7 times. Measured against
  a permanently-503 server: **`ok: true`, `data: []`** — four refusals in a row resolving as a
  successful empty stream. Nothing warns.
- **C9's comparison is honest in both directions.** 62 executable lines of user code against 83
  hand-rolled, and the hand-rolled side's SSE parser is counted because a hand-rolled client really
  does need one. The results are byte-identical on all six shapes and the open counts match, so the
  21-line difference is not buying behaviour — it is buying the spine (one `start`/`delta`×N/
  `error`/`done` trace under one traceId) and keeping `auth`/`headers`/`throttle`/`timeout` as
  config. The caveat is load-bearing: adding `sse: { reconnect: true }` to the assembled stitch
  re-breaks it (4 opens, `ABCDEABCDEABCDEABCDE`), and no surface hook can defend against that — the
  decision is made above them in `runStreaming`.
- **Two mitigations for C4 exist and both cost something.** Resetting the accumulator on the
  `progress:reconnect` event recovers `ABCDE` — but "reset on reconnect" is the opposite of
  resuming, so the reconnect bought nothing. `break`-ing out of the `for await` on `[DONE]` holds it
  to 1 open — but leaving the loop early forfeits `await`/`.safe()` entirely, since awaiting drains
  the generator, replays and all. Aborting a signal on `[DONE]` also stops it at 1 open, and poisons
  the run with `Error: aborted`.
