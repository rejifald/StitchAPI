// C3 — `sse: { reconnect: true }` against a server that DOES emit `id:` on every frame and DOES
// honour `Last-Event-ID`. Does it resume without duplication? Measure the delta sequence AND the
// header value actually sent on the reopened request.
//
// This is the shape SSE was designed for, and it is the one case where the answer is genuinely
// clean — the delta spine is `ABCDE`, once, across a drop. Since #647 the loop also knows when to
// stop: a body that runs out is the stream FINISHING (`openAndDecode` returns `'closed'` at
// engine.ts:1499-1501, and the loop at engine.ts:1524-1529 never reopens it), so a healthy feed
// costs exactly one open. The remaining cost is measured in (d): a feed that keeps dropping still
// fails once the attempt budget is spent, with the partial only on `.stream()`.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c3-resumable-reconnect.ts
import { sse } from '../../../../packages/core/src/sse';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeStreamProvider } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://events.example.com/feed';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

/** The `Last-Event-ID` header per open, with the absent first one spelled so it reads in output. */
const idsOf = (api: FakeStreamProvider): string[] =>
    api.lastEventIds.map((v) => v ?? '(none)');

async function main(): Promise<void> {
    heading('C3 — resumable feed + `sse.reconnect`: resume, or replay?');

    // ── (a) the headline: a drop after 2 of 5, resumed exactly ────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            done: false, // a feed has no `[DONE]` sentinel; it just keeps going
            cut: { after: 2, how: 'error' }, // only open 1 drops
        });
        const feed = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(feed, {}, clock);

        check('(a) TEXT the consumer accumulated', obs.text, 'ABCDE');
        check('(a) any token seen twice?', obs.text === 'ABCDE', true);
        check('(a) deltas delivered', obs.data.length, 5);
        checkSeq('(a) `Last-Event-ID` sent on each open', idsOf(api), [
            '(none)', // the first connection carries no header
            't2', // the drop happened after `id: t2` — this is the resume point
        ]);
        check('(a) reconnects the consumer could see', obs.reconnects, 1);
        check('(a) done.ok', obs.ok, true);
        note(
            '(a) → this is the clean case',
            'ONE `sse: { reconnect: true }` and the resume is correct — no duplication, right header, and the resumed body closing cleanly ends the run at 2 opens',
        );
    }

    // ── (b) a CLEAN close ends the loop: a feed that never drops opens exactly once ───────────
    // `openAndDecode` returns `'closed'` when the body runs out, and since #647 the reconnect
    // loop treats that as the stream FINISHING (engine.ts:1519-1529): it finalizes with what it
    // collected instead of reopening. Before the fix this same fixture burned the whole attempt
    // budget — 4 opens for a feed that never dropped (issue #640).
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            done: false,
            // no `cut` at all: the feed completes cleanly on the FIRST connection
        });
        const feed = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(feed, {}, clock);
        check('(b) text', obs.text, 'ABCDE');
        check('(b) opens for a feed that never dropped', api.opens.length, 1);
        check('(b) wasted round trips', api.opens.length - 1, 0);
        checkSeq('(b) `Last-Event-ID` sent', idsOf(api), ['(none)']);
        note(
            '(b) → "finished" and "dropped" are distinguished now',
            'the reopen-until-the-budget-runs-out behaviour this fixture used to measure was fixed by #647',
        );
    }

    // ── (c) the server's own pacing wins ──────────────────────────────────────────────────────
    // A `retry:` field on the dropped connection beats `reconnect.delay` and `retry.backoff`
    // (engine.ts:1543-1544). Measured as exact virtual gaps between opens.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            done: false,
            retryHint: 9_000,
            cut: { after: 1, how: 'error', onOpens: [1, 2, 3, 4] },
        });
        const feed = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: { attempts: 3, delay: '250ms' } },
        });
        await observe(feed, {}, clock);
        checkSeq(
            '(c) virtual ms between opens (server said 9000)',
            api.gaps,
            [9000, 9000, 9000],
        );
        note(
            '(c) → `reconnect.delay: "250ms"` was authored and never used',
            'the server `retry:` wins, as documented',
        );
    }

    // ── (d) a feed that keeps dropping: resumption is still correct, the run still FAILS ──────
    // Every open drops after one frame. The ids make each resume exact — `ABCD`, no repeats — but
    // the budget runs out and the run ends `error` + `done(ok:false)`. The four tokens are on
    // `.stream()` only; the await path gets nothing (C7).
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            done: false,
            cut: { after: 1, how: 'error', onOpens: [1, 2, 3, 4] },
        });
        const feed = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: { attempts: 3 } },
        });
        const obs = await observe(feed, {}, clock);
        check('(d) text across four partial connections', obs.text, 'ABCD');
        checkSeq('(d) `Last-Event-ID` sent', idsOf(api), [
            '(none)',
            't1',
            't2',
            't3',
        ]);
        check('(d) done.ok', obs.ok, false);
        check('(d) error.message', obs.error, 'socket reset by peer');
        check(
            '(d) `result` event emitted?',
            obs.events.includes('result'),
            false,
        );
    }

    finish(
        'C3',
        'YES — this is the one case that genuinely just works, and since #647 it works without waste. A feed with `id:` on every frame, dropped after 2 of 5 tokens, reopened with `sse: { reconnect: true }`: the consumer observed `ABCDE`, five deltas, ZERO duplication, and the reopened request carried the exact right header — measured `Last-Event-ID` sequence `[(none), "t2"]`, where `t2` is the last id delivered before the drop; the resumed body then closed cleanly and the loop stopped at 2 opens. A feed that never drops opens ONCE — a clean close is the stream finishing, not a drop (before #647 this same fixture spent the whole budget: 4 opens; issue #640). Server pacing is honoured (a `retry: 9000` frame produced measured gaps 9000,9000,9000, overriding an authored `reconnect.delay: "250ms"`). The remaining cost, still measured: a feed that keeps dropping resumes correctly (`ABCD`, no repeats) but still ends `done(ok:false)` with no `result` event once the budget is spent',
    );
}

void main();
