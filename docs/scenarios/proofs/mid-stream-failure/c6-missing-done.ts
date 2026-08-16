// C6 — the missing `[DONE]`. Can "the stream ended early" be distinguished from "the stream ended",
// and can the difference be made a failure?
//
// Nothing built-in can do it, for a structural reason: every gate on the streaming path is
// PER-FRAME (`output` validates each delta before emitting it) or PER-OPEN (`classifyStatus` on the
// status line). Truncation is the absence of a frame, and absence is not a frame.
//
// There IS a working seam, and it is a good one: the surface's own `stream` hook. Wrapping
// `sseSurface.stream` in a generator that throws when the body runs out without `[DONE]` puts the
// check exactly where the knowledge lives, and the throw lands in the engine's mid-body `catch`
// (engine.ts:1446) — so truncation surfaces as an ordinary stream failure with your message on it.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c6-missing-done.ts
import { stitch } from '../../../../packages/core/src/index';
import type { SseEvent } from '../../../../packages/core/src/sse';
import { sse, sseSurface } from '../../../../packages/core/src/sse';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    AdapterResponse,
    ResolvedStitchConfig,
} from '../../../../packages/core/src/types';
import { FakeStreamProvider, isDone } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

/**
 * USER CODE — the `sse` surface with one added rule: a body that ends without `data: [DONE]` was
 * truncated, and truncation is a failure. Eight executable lines.
 */
const decodeSse = sseSurface.stream as NonNullable<Surface['stream']>;
const sseRequiringDone: Surface = {
    ...sseSurface,
    id: 'sse-done',
    stream: async function* (res: AdapterResponse, cfg: ResolvedStitchConfig) {
        let sawDone = false;
        for await (const chunk of decodeSse(res, cfg)) {
            sawDone ||= isDone((chunk as SseEvent).data);
            yield chunk;
        }
        if (!sawDone)
            throw new Error('stream ended without the `[DONE]` sentinel');
    },
};

async function main(): Promise<void> {
    heading('C6 — can a missing `[DONE]` be detected, and made a failure?');

    // ── (a) the A/B: complete vs truncated, side by side ──────────────────────────────────────
    // Same config, same surface, same transport health. The only difference in the two event
    // spines is the NUMBER of deltas — which the client has no way to know is short.
    {
        const clock = manualClock();
        const whole = new FakeStreamProvider({ clock, tokens: TOKENS });
        const cut = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const a = await observe(
            sse({ url: URL, adapter: whole.adapter(), clock }),
            {},
            clock,
        );
        const b = await observe(
            sse({ url: URL, adapter: cut.adapter(), clock }),
            {},
            clock,
        );
        check('(a) complete → done.ok', a.ok, true);
        check('(a) truncated → done.ok', b.ok, true);
        check(
            '(a) same terminal shape?',
            `${String(a.events.at(-2))},${String(a.events.at(-1))}` ===
                `${String(b.events.at(-2))},${String(b.events.at(-1))}`,
            true,
        );
        check('(a) complete text', a.text, 'ABCDE');
        check('(a) truncated text', b.text, 'ABC');
        note(
            '(a) → `result,done(ok:true)` both times',
            'the ONLY signal is that one delta array contains `[DONE]` and the other does not',
        );
    }

    // ── (b) `output` cannot see it — a contract is per-frame ──────────────────────────────────
    // A schema that demands the sentinel rejects every TOKEN frame instead, because it is asked
    // about each delta in isolation and never about the sequence.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            output: {
                '~standard': {
                    version: 1,
                    vendor: 'mid-stream-failure-proof',
                    validate: (value: unknown) =>
                        isDone(value)
                            ? { value }
                            : { issues: [{ message: 'not the sentinel' }] },
                },
            },
        });
        const obs = await observe(chat, {}, clock);
        check('(b) deltas delivered before it blew up', obs.data.length, 0);
        check('(b) done.ok', obs.ok, false);
        note(
            '(b) → the schema fired on delta 1, not at the end',
            '`output` is a per-frame gate; "the sequence lacked a frame" is not expressible in it',
        );
    }

    // ── (c) the working seam: a surface `stream` hook that requires the sentinel ──────────────
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const chat = stitch({
            url: URL,
            kind: sseRequiringDone,
            adapter: api.adapter(),
            clock,
        });
        const obs = await observe(chat, {}, clock);
        checkSeq('(c) event spine on a TRUNCATED stream', obs.events, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'delta',
            'error',
            'done',
        ]);
        check('(c) done.ok', obs.ok, false);
        check(
            '(c) error.message',
            obs.error,
            'stream ended without the `[DONE]` sentinel',
        );
        check('(c) partial still delivered on `.stream()`', obs.text, 'ABC');

        // …and it does not fire on a complete stream.
        const whole = new FakeStreamProvider({ clock, tokens: TOKENS });
        const ok = await observe(
            stitch({
                url: URL,
                kind: sseRequiringDone,
                adapter: whole.adapter(),
                clock,
            }),
            {},
            clock,
        );
        check('(c) complete stream → done.ok', ok.ok, true);
        check('(c) complete stream → text', ok.text, 'ABCDE');

        // …and it survives to the await path.
        const api2 = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const chat2 = stitch({
            url: URL,
            kind: sseRequiringDone,
            adapter: api2.adapter(),
            clock,
        });
        const p = chat2.safe({});
        await clock.advance(3_600_000);
        const r = await p;
        check('(c) await → ok', r.ok, false);
        check(
            '(c) await → error.message',
            r.error?.message,
            'stream ended without the `[DONE]` sentinel',
        );
        check('(c) await → the partial', JSON.stringify(r.data), 'null');
        note(
            '(c) → 8 lines of surface, and truncation becomes a real, named failure',
            'the partial is still only on `.stream()` — see C7',
        );
    }

    // ── (d) the consumer-side one-liner, for comparison ───────────────────────────────────────
    // If you are already reading `.stream()`, the check is a boolean. It is smaller than the
    // surface and it keeps the partial in hand — but it cannot make the STITCH fail, so anything
    // downstream that only sees the awaited result learns nothing.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const obs = await observe(
            sse({ url: URL, adapter: api.adapter(), clock }),
            {},
            clock,
        );
        const truncated = obs.ok === true && obs.dones === 0;
        check('(d) `done.ok && !sawDone` detects truncation', truncated, true);
        check('(d) …and the partial is in hand', obs.text, 'ABC');
    }

    finish(
        'C6',
        'NOT BY ANY BUILT-IN, but YES in 8 lines of surface. A truncated stream and a complete one produce the SAME terminal spine — measured `result, done(ok:true)` for both, `ABCDE` vs `ABC` — because every gate on the streaming path is per-frame (`output`) or per-open (`classifyStatus`), and truncation is the absence of a frame. `output` cannot express it: a schema demanding the sentinel rejects delta 1 instead (measured: 0 deltas delivered, run failed at the wrong place). The seam that works is the surface’s own `stream` hook — wrap `sseSurface.stream`, track whether `[DONE]` was seen, throw if not. The throw lands in the engine’s mid-body catch (engine.ts:1446) and becomes an ordinary stream failure: measured spine `delta,delta,delta,error,done(ok:false)` with `error.message: "stream ended without the `[DONE]` sentinel"`, on both `.stream()` and `await`, and it stays quiet on a complete stream. The consumer-side check (`done.ok && dones === 0`) is one boolean and keeps the partial, but cannot make the stitch itself fail',
    );
}

void main();
