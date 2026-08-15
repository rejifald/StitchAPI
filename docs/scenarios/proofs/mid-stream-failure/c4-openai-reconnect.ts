// C4 — `sse: { reconnect: true }` against an OPENAI-SHAPED stream: `data: {...}` frames with NO
// `id:` anywhere, terminated by `data: [DONE]`. Silent restart from the beginning (duplication),
// refusal, or something else?
//
// Measured today: A NO-OP. One open, one answer, one `[DONE]` — with or without the flag. It was
// not always so: this probe originally measured a SILENT RESTART, four times over, on a stream
// that never failed (`ABCDEABCDEABCDEABCDE`, 24 deltas, `done(ok: true)`), filed from this audit
// as issue #640 and fixed in core by #647. Two things changed:
//
//   1. Capability alone no longer decides. `canResume` (engine.ts:1337) still ands the flag with
//      the presence of `resumeToken`/`applyResume`, but the reconnect decision now also tests what
//      THIS stream actually produced: `recoverable = lastToken !== undefined || chunks.length ===
//      0` (engine.ts:1518). A body that delivered bytes but no `id:` has no resume point, so it is
//      never reopened — a reopened request could only ask for the whole completion again.
//   2. A clean close is the stream FINISHING. `openAndDecode` returns `'closed'` when the body
//      runs out (engine.ts:1499-1501) and the loop treats that as terminal (engine.ts:1524-1529),
//      so `[DONE]` + close ends the run instead of spending the reconnect budget.
//
// This file pins the fixed behaviour, so a regression shows up as a red check rather than a
// re-audit.
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

    // ── (a) a stream that never failed is delivered ONCE, flag or no flag ─────────────────────
    // No `cut`. The provider writes all five tokens and `data: [DONE]`, then closes normally. The
    // reconnect flag spends nothing: the clean close ends the run. (Before #647 this fixture
    // measured 4 opens and `ABCDEABCDEABCDEABCDE`, ending `done(ok: true)`.)
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

        check('(a) opens the provider saw', api.opens.length, 1);
        check('(a) TEXT the consumer accumulated', obs.text, 'ABCDE');
        check('(a) deltas delivered', obs.data.length, 6); // 5 tokens + [DONE]
        check('(a) `[DONE]` sentinels observed', obs.dones, 1);
        checkSeq(
            '(a) `Last-Event-ID` sent on each open',
            api.lastEventIds.map((v) => v ?? '(none)'),
            ['(none)'],
        );
        check('(a) done.ok', obs.ok, true);
        note(
            '(a) → the model ran once, the caller pays once, the UI renders the answer once',
            'the flag is inert here — nothing to resume from, so nothing is reopened (#647)',
        );
    }

    // ── (b) the same flag on a stream that DID drop ───────────────────────────────────────────
    // A drop after 3 of 5. Three deltas were delivered and no frame carried an `id:`, so the drop
    // is NOT recoverable (engine.ts:1518) — a reopen could only replay `ABC` into the consumer.
    // The failure surfaces instead, with the partial kept on `.stream()`. (Before #647 the partial
    // was replayed whole on every reopen — `ABCABCABCABC` — AND the run failed.)
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
        check('(b) opens', api.opens.length, 1);
        check('(b) TEXT the consumer accumulated', obs.text, 'ABC');
        check('(b) `[DONE]` sentinels', obs.dones, 0);
        check('(b) done.ok', obs.ok, false);
        check('(b) error.message', obs.error, 'socket reset by peer');
    }

    // ── (c) `sse: true` is the same thing ─────────────────────────────────────────────────────
    // The shorthand (`stitch.ts:294` — `sse === true` becomes `{ reconnect: true }`) reads like
    // "this is an SSE stitch", which is exactly the sort of thing someone adds without thinking.
    // Since #647 that reflex is harmless here too.
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
        check('(c) `sse: true` → opens', api.opens.length, 1);
        check('(c) `sse: true` → text', obs.text, 'ABCDE');
    }

    // ── (d) the old consumer-side mitigation has nothing left to do ───────────────────────────
    // The original finding forced consumers to reset their accumulator on every
    // `progress: { phase: 'reconnect' }` event to undo the replay. That boundary is emitted only
    // before a genuine reopen (engine.ts:1545-1551), and a completed id-less stream is no longer
    // reopened — so the reset never fires, and the accumulated text is right WITHOUT it.
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
        let resets = 0;
        const drain = (async () => {
            for await (const ev of chat.stream(
                {},
            ) as AsyncIterable<StitchEvent>) {
                if (ev.type === 'progress' && ev.phase === 'reconnect') {
                    resets++;
                    text = '';
                }
                if (ev.type === 'delta')
                    text +=
                        contentOf((ev.chunk as { data: unknown }).data) ?? '';
            }
        })();
        await clock.advance(3_600_000);
        await drain;
        check('(d) `progress:reconnect` boundaries observed', resets, 0);
        check(
            '(d) text with the defensive reset still wired up',
            text,
            'ABCDE',
        );
        note(
            '(d) → the reset-on-reconnect defence is dead code now',
            'no boundary event fires on a completed stream, and the text is right without it',
        );
    }

    // ── (e) `break` on `[DONE]` still works — it is just no longer an escape hatch ────────────
    // Leaving the `for await` calls `.return()` on the generator. Before #647 this was the cheap
    // way to hold a reconnecting stream to one open, at the price of forfeiting `await` (which
    // drains the whole generator, replays and all). Now both paths open once; breaking early only
    // means the consumer skips the terminal `result`/`done` events.
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
        'A NO-OP, NOT A REPLAY. `sse: { reconnect: true }` on a clean OpenAI-shaped completion measured 1 open, 6 deltas, 1 `[DONE]`, text `ABCDE`, `done(ok: true)` — identical with the flag off. On a stream that DID drop after 3 tokens: 1 open, `ABC` kept on `.stream()`, `done(ok: false)` with `socket reset by peer` — the id-less drop is not reopened, because a reopened request could only ask for the whole completion (engine.ts:1518 requires a resume token once bytes have flowed; a clean close is terminal at engine.ts:1524-1529). `sse: true` is the same flag and the same no-op. The consumer-side defences the original finding required are dead code now: zero `progress:reconnect` boundaries fire on a completed stream, and `break`-ing on `[DONE]` no longer changes the open count. This is the FIXED behaviour of the sharpest finding of this audit — a completed stream reopened 4×, delivering `ABCDEABCDEABCDEABCDE` under `done(ok: true)` — filed as issue #640, fixed in core by #647; these checks pin it against regression',
    );
}

void main();
