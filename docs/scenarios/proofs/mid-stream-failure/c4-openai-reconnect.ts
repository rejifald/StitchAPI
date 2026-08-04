// C4 — `sse: { reconnect: true }` against an OPENAI-SHAPED stream: `data: {...}` frames with NO
// `id:` anywhere, terminated by `data: [DONE]`. Silent restart from the beginning (duplication),
// refusal, or something else?
//
// Measured: SILENT RESTART, four times over, on a stream that DID NOT FAIL. This is the sharpest
// finding in the scenario and it is a correctness bug in freshly-shipped code (#622), not a policy
// trade-off. Two independent defects compose:
//
//   1. `resumable` (engine.ts:1288) is `policy.enabled && !!resumeToken && !!applyResume` — the
//      surface's CAPABILITY, evaluated once, before any frame is read. `sseSurface` always exposes
//      both hooks, so an OpenAI stream with no `id:` in it anywhere is classified resumable. When
//      the reopen happens, `lastToken` is still `undefined`, the `attempt > 1 && lastToken !==
//      undefined` guard at engine.ts:1344 skips `applyResume`, and the request goes out with NO
//      `Last-Event-ID` — i.e. a request for the whole completion, from token one.
//   2. The reconnect loop (engine.ts:1460-1490) treats a CLEAN body close (`'closed'`) exactly like
//      a drop (`'error'`). There is no "this stream is complete" signal, so `[DONE]` means nothing
//      and a finished completion is reopened until the attempt budget is spent.
//
// Together: one config flag turns one answer into four, delivered to the consumer as one
// uninterrupted delta spine, and the run ends `ok: true`.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c4-openai-reconnect.ts
import { sse } from '../../../../packages/core/src/sse';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StitchEvent } from '../../../../packages/core/src/types';
import { FakeStreamProvider, contentOf, isDone } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

async function main(): Promise<void> {
    heading('C4 — `reconnect` on an OpenAI-shaped stream with no `id:`');

    // ── (a) A STREAM THAT NEVER FAILED, replayed four times ───────────────────────────────────
    // No `cut`. The provider writes all five tokens and `data: [DONE]`, then closes normally. The
    // consumer is handed the complete answer FOUR times and the run reports success.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(chat, {}, clock);

        check('(a) opens the provider saw', api.opens.length, 4);
        check(
            '(a) TEXT the consumer accumulated',
            obs.text,
            'ABCDEABCDEABCDEABCDE',
        );
        check('(a) deltas delivered', obs.data.length, 24); // 4 × (5 tokens + [DONE])
        check('(a) `[DONE]` sentinels observed', obs.dones, 4);
        checkSeq(
            '(a) `Last-Event-ID` sent on each open',
            api.lastEventIds.map((v) => v ?? '(none)'),
            ['(none)', '(none)', '(none)', '(none)'],
        );
        check('(a) done.ok', obs.ok, true);
        note(
            '(a) → the model ran 4 times, the caller pays 4×, the UI renders the answer 4×',
            'and nothing in the result says so: `done(ok: true)` with a 24-element array',
        );
    }

    // ── (b) the same flag on a stream that DID drop ───────────────────────────────────────────
    // A drop after 3 of 5. The partial is replayed whole on every reopen — `ABCABCABCABC` — and the
    // run still ends in failure. Worst of both: duplicated content AND an error.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'error', onOpens: [1, 2, 3, 4] },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(chat, {}, clock);
        check('(b) opens', api.opens.length, 4);
        check('(b) TEXT the consumer accumulated', obs.text, 'ABCABCABCABC');
        check('(b) `[DONE]` sentinels', obs.dones, 0);
        check('(b) done.ok', obs.ok, false);
        check('(b) error.message', obs.error, 'socket reset by peer');
    }

    // ── (c) `sse: true` is the same thing ─────────────────────────────────────────────────────
    // The shorthand (`stitch.ts:243` — `sse === true` becomes `{ reconnect: true }`) reads like
    // "this is an SSE stitch", which is exactly the sort of thing someone adds without thinking.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: true,
        });
        const obs = await observe(chat, {}, clock);
        check('(c) `sse: true` → opens', api.opens.length, 4);
        check('(c) `sse: true` → text', obs.text, 'ABCDEABCDEABCDEABCDE');
    }

    // ── (d) the duplication IS detectable by the consumer — a `progress:reconnect` marks it ────
    // `runStreaming` emits `{ type: 'progress', phase: 'reconnect' }` before each reopen
    // (engine.ts:1482-1488). A consumer that resets its accumulator on that event recovers the
    // right text. This is the mitigation, and it is user code, and it costs the whole point of
    // reconnect (the resume) since every reopen starts over.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        let text = '';
        const drain = (async () => {
            for await (const ev of chat.stream(
                {},
            ) as AsyncIterable<StitchEvent>) {
                if (ev.type === 'progress' && ev.phase === 'reconnect')
                    text = '';
                if (ev.type === 'delta')
                    text +=
                        contentOf((ev.chunk as { data: unknown }).data) ?? '';
            }
        })();
        await clock.advance(3_600_000);
        await drain;
        check(
            '(d) text after resetting on every `progress:reconnect`',
            text,
            'ABCDE',
        );
        note(
            '(d) → the boundary is visible, so a careful consumer can undo the damage',
            'but "reset the accumulator" is the OPPOSITE of resuming — the reconnect bought nothing',
        );
    }

    // ── (e) the cheap escape: `break` on `[DONE]` ─────────────────────────────────────────────
    // Leaving the `for await` calls `.return()` on the generator, so the engine never reaches the
    // reconnect. One open, one answer. The price is that you can no longer `await` the stitch —
    // awaiting drains the whole generator, replays and all.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(chat, {}, clock, { stopOn: isDone });
        check(
            '(e) opens when the consumer breaks on `[DONE]`',
            api.opens.length,
            1,
        );
        check('(e) text', obs.text, 'ABCDE');
        check('(e) terminal `done` event seen?', obs.ok === undefined, true);
    }

    finish(
        'C4',
        'SILENT RESTART FROM THE BEGINNING — and, worse than the capture guessed, it happens to streams that never failed. `sse: { reconnect: true }` on a clean OpenAI-shaped completion produced 4 opens, a 24-delta spine, 4 `[DONE]` sentinels, and the measured text `ABCDEABCDEABCDEABCDE` delivered to the consumer as one uninterrupted stream — ending `done(ok: true)`. No `Last-Event-ID` was ever sent (measured `[(none) ×4]`): there is no id to resume from, so every reopen is a request for the whole completion. Two defects compose — `resumable` is decided from surface CAPABILITY before any frame is read (engine.ts:1288), and a clean close is treated as a drop (engine.ts:1466), so `[DONE]` terminates nothing. On a stream that DID drop the result is `ABCABCABCABC` plus a failure. `sse: true` is the same flag. Two mitigations exist and both are user code: reset the accumulator on the `progress:reconnect` event (measured: recovers `ABCDE`), or `break` on `[DONE]` (measured: 1 open) — which forfeits `await` entirely',
    );
}

void main();
