# Scenario: a stream that fails after you've already shown the user 800 tokens

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `mid-stream-failure`

**Verification:** 9 proof scripts, run offline (171 checks), in
[`proofs/mid-stream-failure/`](proofs/mid-stream-failure/). Published page:
[`scenarios/mid-stream-failure.mdx`](../../apps/docs/content/docs/scenarios/mid-stream-failure.mdx).
Escalated — **the pass's most severe finding, in code shipped in #622**:
[`issue-drafts/sse-reconnect-replays-completed-streams.md`](issue-drafts/sse-reconnect-replays-completed-streams.md).

| Claim                                 | Verdict                 | Measured                                                                                                                                             |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — drop mid-body, no `[DONE]`       | both, and they disagree | `.stream()` sees `error` as an EVENT not a throw; `await` gives `ok:false, data:null`; a **clean** close mid-answer is identical in shape to success |
| C2 — does `retry` re-emit deltas      | **no — refuted**        | `ABC` once. `retry` never runs on a stream: 4 requests buffered vs **1** streaming, `attempts: 1`                                                    |
| C3 — `reconnect` on a resumable feed  | **PASS — just works**   | `ABCDE`, zero duplication, `Last-Event-ID` `(none) → t2 → t5`; server `retry: 9000` honored                                                          |
| C4 — `reconnect` on an id-less stream | **BUG**                 | a **completed** stream reopened **4×**, `ABCDEABCDEABCDEABCDE` delivered, `done(ok: true)`                                                           |
| C5 — in-band error frame at 200       | only via `output`       | custom `interpret` ran **0 times**; `verdict.flag` inert; `onError` never fires post-200                                                             |
| C6 — missing `[DONE]`                 | no built-in; 8 lines    | truncated and complete streams share the terminal spine `result, done(ok:true)`                                                                      |
| C7 — is the partial reachable         | `.stream()` only        | `.safe().data` null; `StitchError.body/data/partial/chunks` undefined; `.inspect()` says `status: 0`                                                 |
| C8 — connect-retry vs body-retry      | not in config           | one flag governs both; `Surface.execute` does it in 10 lines                                                                                         |
| C9 — assembled                        | PASS                    | **62 lines vs 83** hand-rolled — the first scenario where StitchAPI is _smaller_                                                                     |

**Two hypotheses refuted, and the second one matters.** The capture nominated C2 as a deciding
claim — "does `retry` re-emit already-seen deltas into a downstream accumulator?" The answer is
no, and for a reason the capture didn't anticipate: `retry` doesn't run on streams at all. But
the duplication hazard the capture was hunting for **is real** — it just comes from
`sse.reconnect`, not `retry`, and it fires on streams that never failed.

**The split verdict is worth keeping.** C3 alone is genuinely ACHIEVABLE — for a feed that
emits `id:` and honors `Last-Event-ID`, `reconnect: true` is one flag and it is correct. That
is the first clean built-in win in five scenarios. The overall verdict is only "with user code"
because the same flag is actively harmful everywhere else, and C5–C8 each need code.

---

## The use case

You stream an LLM completion to a user — OpenAI, Anthropic, OpenRouter, a self-hosted model.
Tokens arrive over SSE and render as they come. Eight hundred tokens in, the stream stops.

Not "the request failed". The request **succeeded**: `200 OK` went out with the first token,
and the user is looking at most of an answer.

## Why it is not straightforward

**Once the first byte is written, the status line is spent.** HTTP 200 and the headers are
committed before anything goes wrong, so every failure after that point has to arrive
_in-band_ — as an SSE `error` frame, or as nothing at all when the connection simply drops.
Status-code logic is structurally unable to see it. (This is the fourth scenario in this
section where the failure signal lives below the status line.)

**Retrying is not free, and not neutral.** Replaying the request re-runs the model: you pay
for the first 800 tokens _and_ the replacement, since tokens generated before a mid-stream
failure are still billed. Worse than the money, a retry **duplicates content the consumer has
already accumulated** — the user watches the answer restart, or the accumulator ends up with
800 tokens of prefix twice. Any retry policy applied to a stream has to answer "what happens
to the deltas already emitted?", and most just don't.

**"Ended" and "ended early" look identical.** A cleanly finished OpenAI stream is terminated
by a `[DONE]` sentinel. A truncated one just... stops. Without checking for the sentinel there
is no way to distinguish a complete answer from a severed one — and the severed one arrives
with `ok`, because the transport was fine.

**Resumption mostly isn't offered.** SSE has a resume mechanism — `Last-Event-ID` — but it
requires the server to put `id:` on each frame and to honour the header on reconnect.
OpenAI-style completion chunks carry no `id:` at all, so the standard mechanism does not apply
to the most common streaming API in the world.

**The partial is often still valuable.** 800 of 1000 tokens is usually worth showing, saving,
or feeding to a repair prompt. Discarding it because the call "failed" throws away work that
was already paid for.

## Evidence this bites real projects

- **OpenRouter** — [error handling guide](https://openrouter.ai/docs/api_reference/errors-and-debugging):
  once the first token is written the 200 is committed, so provider disconnects, timeouts,
  content filters and overloads _must_ arrive in-band as SSE events.
- **openai-node** — [`#257`](https://github.com/openai/openai-node/issues/257): usage missing
  on streamed responses, so a client cannot even reconcile what it was billed for.
- **openai-go** — [`#556`](https://github.com/openai/openai-go/issues/556).
- **Practitioner guidance** is unusually blunt about the retry hazard: replaying the request
  can duplicate "model work, billing, tool intent, or a fragment already held by a downstream
  accumulator", and partial output should never be treated as final.
- **OpenAI's own streaming guide** documents `[DONE]` as the completion signal — which is to
  say, truncation detection is the client's job.

## The common solutions, and what each costs

| Approach                                    | What it is                                          | Where it breaks                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Retry the whole request**                 | Treat it like any failed call.                      | Pays twice, re-runs the model, and duplicates content in any accumulator that kept the first attempt's deltas. The user sees the answer restart. |
| **Never retry a stream**                    | Surface whatever arrived.                           | Safe and common. Turns every transient blip into a visible failure, even ones a single retry would have fixed.                                   |
| **Checkpoint + resume via `Last-Event-ID`** | Reopen and replay from the last seen id.            | The correct mechanism, and unavailable on OpenAI-style APIs — no `id:` on completion chunks. Works for event feeds that do emit ids.             |
| **Continuation prompt**                     | Re-ask the model to continue from the partial text. | The pragmatic LLM-specific answer. Costs another call, and the seam is visible in the output.                                                    |
| **Buffer everything, emit at the end**      | Don't stream to the user until `[DONE]`.            | Makes truncation detectable and retry safe — and throws away the entire reason for streaming.                                                    |
| **Sentinel check**                          | Require `[DONE]`; treat its absence as failure.     | Necessary in every one of the above. Cheap, and routinely forgotten.                                                                             |

**Summary of the state of the art:** detect truncation by the sentinel rather than the status,
never blind-retry a stream that has already emitted, resume only where the server supports it,
and keep the partial. The hard part is that the right policy differs per API — resumable feeds
and LLM completions want opposite behaviour from the same client.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **Resumable SSE is a real, shipped feature** and it is fresh (`#622`, two commits back).
  `sse.reconnect` (`types.ts:847-851`) reopens a dropped body and resumes from the last `id:`;
  `Surface.resumeToken` / `applyResume` (`surface.ts:83-107`) are the seam, and `sse` sets the
  `Last-Event-ID` header. So for a **resumable** feed this may be genuinely one config flag —
  which would make it the first scenario in this pass with a clean built-in answer.
- **The LLM case is the interesting one**, because `Last-Event-ID` cannot help: no `id:` on the
  frames. What does `reconnect` do when there is no token to resume from — reopen from scratch
  (duplicating everything) or refuse?
- **The retry question is the sharp one.** If `retry` is applied to a streaming stitch and the
  body dies after N deltas have already been yielded to a consumer, does the consumer see those
  N deltas **twice**? That is the "fragment already held by a downstream accumulator" hazard,
  and it is a correctness question, not a policy one.
- **Is the partial preserved?** Scenario 3 found no channel for a batch residue. The same
  question here: on a mid-stream failure, does the caller get the deltas that did arrive, or
  only an error?

**Claims to test with runnable offline code:**

1. **C1** — a stream drops mid-body after N deltas. What does a consumer of `.stream()` see —
   an error, a truncated-but-clean end, or nothing distinguishing it from success?
2. **C2** — with `retry` configured on a streaming stitch and a mid-body drop: are the
   already-emitted deltas **re-emitted**? Measure the exact delta sequence the consumer sees.
3. **C3** — `sse.reconnect` against a server that **does** emit `id:` and honours
   `Last-Event-ID`: does it resume without duplication? Measure deltas and the header sent.
4. **C4** — `sse.reconnect` against an **OpenAI-shaped** stream with no `id:` on any frame:
   what happens? Duplication, refusal, or silent restart?
5. **C5** — an in-band SSE `error` frame arriving at HTTP 200: can it be made a real failure?
   (`verdictOf`? a surface? a hook?)
6. **C6** — missing `[DONE]`: can "the stream ended early" be distinguished from "the stream
   ended", and can that be a failure?
7. **C7** — is the **partial output** reachable on a mid-stream failure — from the error, the
   event stream, or a hook — or is it lost?
8. **C8** — can retry be enabled for the _connect_ phase (a 503 before any byte) but disabled
   once bytes have flowed? That is the policy every LLM client actually wants.
9. **C9** — assemble the best answer for the LLM case, run it, report the seam and line count.

C2 and C8 decide this one. A client that re-emits already-seen deltas on retry is worse than
one that doesn't retry at all.
