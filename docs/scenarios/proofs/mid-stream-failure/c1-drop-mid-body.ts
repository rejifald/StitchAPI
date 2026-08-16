// C1 — the stream drops mid-body after N deltas, with no `[DONE]`. What does a `.stream()` consumer
// see: an error, a clean-looking end, or something indistinguishable from success? And what does
// `await` (which collects) give?
//
// The two halves answer differently, and that difference is the finding.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c1-drop-mid-body.ts
import { sse } from '../../../../packages/core/src/sse';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeStreamProvider } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

async function main(): Promise<void> {
    heading('C1 — a mid-body drop: what does the consumer see?');

    // ── (a) baseline: a CLEAN OpenAI completion ───────────────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const obs = await observe(chat, {}, clock);
        check('(a) opens', api.opens.length, 1);
        check('(a) text delivered', obs.text, 'ABCDE');
        check('(a) `[DONE]` sentinels', obs.dones, 1);
        checkSeq('(a) event spine', obs.events, [
            'start',
            'progress:request',
            ...Array<string>(6).fill('delta'), // 5 tokens + `[DONE]`
            'result',
            'done',
        ]);
        check('(a) done.ok', obs.ok, true);
    }

    // ── (b) the DROP: transport dies after 3 of 5 tokens ──────────────────────────────────────
    // The 200 is long since spent. The engine emits the deltas it got, then an `error` and a
    // FAILED `done`. So a `.stream()` consumer CAN tell — but only by reading the control events;
    // the delta sequence itself just stops.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'error' },
        });
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const obs = await observe(chat, {}, clock);
        check('(b) opens', api.opens.length, 1);
        check('(b) text delivered before the drop', obs.text, 'ABC');
        check('(b) `[DONE]` sentinels', obs.dones, 0);
        checkSeq('(b) event spine', obs.events, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'delta',
            'error',
            'done',
        ]);
        check('(b) done.ok', obs.ok, false);
        check('(b) error.message', obs.error, 'socket reset by peer');
        check(
            '(b) did the ITERATOR throw?',
            obs.threw ?? 'no — the failure is an `error` EVENT',
            'no — the failure is an `error` EVENT',
        );
        note(
            '(b) → a `for await (… of .stream())` that only looks at `delta` sees a SILENT truncation',
            'the error arrives as a separate event type it never matched',
        );
    }

    // ── (c) the same drop on the AWAIT path — the partial is GONE ─────────────────────────────
    // `await`/`.safe()` collects the deltas into an array, but a failed run resolves to the error,
    // never to `chunks`. The three tokens the server already produced (and billed) are unreachable.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'error' },
        });
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const p = chat.safe({});
        await clock.advance(3_600_000);
        const r = await p;
        check('(c) ok', r.ok, false);
        check('(c) data', JSON.stringify(r.data), 'null');
        check('(c) error.message', r.error?.message, 'socket reset by peer');
        check('(c) error.status', String(r.error?.status), 'undefined');
        check('(c) error.attempts', r.error?.attempts, 1);
        check(
            '(c) error.body (the partial?)',
            String((r.error as { body?: unknown } | null)?.body),
            'undefined',
        );
        note(
            '(c) → on the await path a mid-stream failure is TOTAL',
            'the 3 tokens that arrived are not on the error, not in `data`, not anywhere',
        );
    }

    // ── (d) the nastier drop: a CLEAN close, mid-answer ───────────────────────────────────────
    // A truncated answer whose socket closed normally. The transport was fine, so the engine has
    // nothing to complain about: `result` + `done(ok: true)`. It is byte-for-byte the (a) spine
    // with fewer deltas — success and truncation are the SAME shape.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const obs = await observe(chat, {}, clock);
        check('(d) text delivered', obs.text, 'ABC');
        check('(d) `[DONE]` sentinels', obs.dones, 0);
        checkSeq('(d) event spine', obs.events, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        check('(d) done.ok', obs.ok, true);
        const p = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'close' },
        });
        const s2 = sse({ url: URL, adapter: p.adapter(), clock });
        const pr = s2.safe({});
        await clock.advance(3_600_000);
        const r = await pr;
        check('(d) await → ok', r.ok, true);
        check(
            '(d) await → collected deltas',
            (r.data as unknown[] | null)?.length,
            3,
        );
        note(
            '(d) → THE footgun of this claim',
            'a severed answer resolves SUCCESSFULLY with a short array; only the missing `[DONE]` tells you',
        );
    }

    finish(
        'C1',
        'BOTH, depending on which end you read, and the answers disagree. A TRANSPORT drop is visible on `.stream()` — `delta,delta,delta,error,done(ok:false)` with `error.message: "socket reset by peer"` — but it is an EVENT, not a throw, so a consumer that only matches `delta` sees a silent truncation. On the await path the same drop is TOTAL: `ok:false`, `data: null`, and the 3 tokens that did arrive are on neither the error (`error.body === undefined`) nor anywhere else. And a CLEAN close mid-answer is worse than either: 3 deltas, `result`, `done(ok:true)`, `await` resolving to a 3-element array — the exact spine of a complete run. Success and truncation are the same shape unless YOU check for `[DONE]`',
    );
}

void main();
