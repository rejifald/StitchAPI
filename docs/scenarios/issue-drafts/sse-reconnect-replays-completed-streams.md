# Issue draft — `sse: { reconnect: true }` replays a **completed** stream and delivers duplicated content

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`mid-stream-failure`](../mid-stream-failure.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `bug`, `sse`, `data-integrity`
**Affects:** resumable SSE as shipped in **#622** (two commits before this branch)

> Highest-severity finding of the scenario pass. A single documented flag delivers **duplicated
> content to the end user** on a stream that never failed, and the run ends `ok: true`. It is
> in code that shipped days ago, so it is worth confirming before the next release rather than
> after.

## Reproduce

```bash
pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c4-openai-reconnect.ts
```

Block (a). No network — a fake adapter serving an OpenAI-shaped `text/event-stream`.

## What happens

A stitch with `sse: { reconnect: true }` against a **cleanly completing** OpenAI-shaped stream
(`data: {...}` frames with **no `id:`**, terminated by `data: [DONE]`):

|                            | measured                                       |
| -------------------------- | ---------------------------------------------- |
| opens                      | **4**                                          |
| `[DONE]` sentinels seen    | **4**                                          |
| deltas delivered           | **24**                                         |
| text the consumer received | **`ABCDEABCDEABCDEABCDE`**                     |
| terminal event             | **`done(ok: true)`**                           |
| `Last-Event-ID` sent       | **never** — `[(none), (none), (none), (none)]` |

The stream completed correctly on the first open. The library then requested the whole
completion three more times and concatenated the results into one uninterrupted delta stream,
which a UI renders as the answer repeating four times. Against a model API, those are three
billed completions nobody asked for.

`sse: true` is the same flag (`stitch.ts:241-243`), so the shorthand carries it too.

## Why — two independent defects that compose

**1. `resumable` is decided from surface _capability_, before any frame is read.**

```
engine.ts:1288   resumable = policy.enabled && !!resumeToken && !!applyResume
```

`sseSurface` exposes both hooks unconditionally (`sse.ts:164-184`), so an **id-less** stream is
classified resumable. At reopen `lastToken` is `undefined`, the guard at `engine.ts:1344-1345`
skips `applyResume`, and the request goes out with no `Last-Event-ID` — i.e. a request for the
entire completion rather than a resumption.

**2. A clean close is treated as a drop.**

```
engine.ts:1466   // 'closed' and 'error' take the same path
```

There is no "this stream is complete" signal, so `[DONE]` terminates nothing and the reconnect
budget is always spent in full. This is why a stream that never failed is reopened at all.

Either defect alone is survivable. Together they turn a successful stream into four.

## Suggested fixes

- **`reconnect.requireToken`** (smallest useful fix): refuse to reconnect when no resume token
  has ever been seen. This alone turns the id-less case from silent replay into a refusal, and
  makes the resumable case unaffected.
- **`reconnect.onlyOnDrop`**: distinguish a clean body close from a transport drop, and stop
  reconnecting once the stream has ended. This fixes the wasted-round-trip half, which also
  affects the _resumable_ path — measured: a feed that never drops still opens **4×**, each
  reopen replaying `Last-Event-ID: t5` (`c3-resumable-reconnect.ts`).
- Both spellings are machine-checked absent today (`@ts-expect-error` in `c8-connect-vs-body.ts` (f)).

Longer term, a surface-declared "the stream is finished" signal would let `[DONE]` mean what it
says, rather than the engine inferring completion from a closed socket.

## Docs that need a caveat regardless of the fix

`apps/docs/content/docs/reference/surfaces.mdx:83-104` says a dropped stream is reopened, and
never mentions that a **finished** one is too, or that the feature requires the server to emit
`id:`. As written, a reader with an OpenAI-shaped stream has every reason to turn it on.

---

## Related findings from the same verification (separate asks)

These are not the bug above, but they surfaced alongside it and shape the same scenario.

- **`retry` does not run on a streaming stitch at all.** Measured: `retry: { attempts: 4 }`
  against an always-503 server → **4 requests on a buffered stitch, 1 on an `sse` one**,
  `error.attempts: 1`. `runStreaming` (`engine.ts:1248`) has no attempt loop. That means the
  one replay that is unambiguously safe — the connect phase, before any byte has flowed — is
  the one case the retry config cannot express.
- **`retry.attempts` is inert while `retry.backoff` is live** on the same stitch: `backoff`
  supplies the _reconnect_ curve. `retry: { attempts: 1 }` still produced 4 opens. Two knobs
  under one name capping different things is worth either separating or documenting.
- **The default reconnect backoff is ~50 ms** (`expo-jitter` off base 100, `resilience.ts:39-56`),
  so a dropped stream replays almost immediately unless a `retry.backoff` is authored.
- **`interpret` and `verdict.flag` are dead code on streaming surfaces.** A custom surface's
  `interpret` ran **zero** times; `runStreaming` calls only `classifyStatus` (`engine.ts:1371`).
  Both typecheck. The hook whose stated job is "this 200 is really a failure" is unavailable in
  the one place where every failure is a 200.
- **`hooks.onError` never fires for a post-200 stream failure** — measured `[onRequest,
onResponse]` on a failing run. Any hook-based error pipeline is blind to mid-stream failure.
- **The partial is discarded one line before it could be returned.** `engine.ts:1467-1472`
  returns before reaching `resultEvt(chunks, …)` at `:1492`, so the buffered accessors get
  nothing: `.safe().data` null, `StitchError.body/data/partial/chunks` all undefined, and
  `.inspect()` reports `status: 0` — it does not even record that a 200 arrived.
- **`verdict: { accept: [503] }` + `reconnect` resolves a permanently-503 server successfully**
  with `data: []` (`c8-connect-vs-body.ts` (d)).
