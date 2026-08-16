// C7 — is the PARTIAL OUTPUT reachable on a mid-stream failure? Scenario 3 (batch-partial-failure)
// found no channel at all for a batch residue. Streams are different — but only by one channel, and
// only if you were already using it.
//
// Every buffered accessor is checked here against the same failed run: the awaited value, the
// `SafeResult`, the thrown `StitchError` and all its properties, `.inspect()`, `.report()`, and the
// hook surface. The engine DOES hold the partial while the run fails — `chunks` accumulates every
// delta at engine.ts:1443 and `resultEvt(chunks, …)` at engine.ts:1492 is simply never reached on
// the failure path (engine.ts:1467-1472 emits `error` + `done` and returns instead). So the data
// exists inside the engine at the moment of failure and is dropped.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c7-partial-output.ts
import { sse } from '../../../../packages/core/src/sse';
import {
    collectStitchEvents,
    manualClock,
} from '../../../../packages/core/src/testing';
import { FakeStreamProvider, contentOf } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

/** The one provider shape used throughout: 3 of 5 tokens, then the socket errors. */
const dropAfter3 = (
    clock: ReturnType<typeof manualClock>,
): FakeStreamProvider =>
    new FakeStreamProvider({
        clock,
        tokens: TOKENS,
        cut: { after: 3, how: 'error' },
    });

async function main(): Promise<void> {
    heading('C7 — where does the partial go when a stream fails mid-body?');

    // ── (a) `.stream()` — THE channel. The deltas were already handed over. ───────────────────
    {
        const clock = manualClock();
        const api = dropAfter3(clock);
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const obs = await observe(chat, {}, clock);
        check('(a) partial text held by the consumer', obs.text, 'ABC');
        check('(a) deltas received before the failure', obs.data.length, 3);
        check('(a) run failed', obs.ok, false);
        note(
            '(a) → the partial is not RETURNED, it was already DELIVERED',
            'which means only a `.stream()` consumer has it — and only if it kept it',
        );
    }

    // ── (b) every buffered accessor: nothing ─────────────────────────────────────────────────
    {
        const clock = manualClock();

        const api1 = dropAfter3(clock);
        const p1 = sse({ url: URL, adapter: api1.adapter(), clock }).safe({});
        await clock.advance(3_600_000);
        const safe = await p1;

        const api2 = dropAfter3(clock);
        let thrown: unknown;
        const p2 = sse({ url: URL, adapter: api2.adapter(), clock })({}).catch(
            (e: unknown) => {
                thrown = e;
            },
        );
        await clock.advance(3_600_000);
        await p2;

        const api3 = dropAfter3(clock);
        const insp = await sse({
            url: URL,
            adapter: api3.adapter(),
            clock,
        }).inspect({});

        const api4 = dropAfter3(clock);
        const rep = await sse({
            url: URL,
            adapter: api4.adapter(),
            clock,
        }).report({});

        check('(b) `.safe().data`', JSON.stringify(safe.data), 'null');
        check(
            '(b) thrown `StitchError` own keys',
            Object.keys(thrown as object)
                .sort()
                .join(','),
            'attempts,body,name,status,url',
        );
        check(
            '(b) `error.body`',
            String((thrown as { body?: unknown }).body),
            'undefined',
        );
        check(
            '(b) `error.data`',
            String((thrown as { data?: unknown }).data),
            'undefined',
        );
        check(
            '(b) `error.partial`',
            String((thrown as { partial?: unknown }).partial),
            'undefined',
        );
        check(
            '(b) `error.chunks`',
            String((thrown as { chunks?: unknown }).chunks),
            'undefined',
        );
        check('(b) `.inspect().data`', JSON.stringify(insp.data), 'null');
        check('(b) `.inspect().raw`', JSON.stringify(insp.raw), 'null');
        check('(b) `.inspect().status`', insp.status, 0);
        check('(b) `.report().data`', JSON.stringify(rep.data), 'null');
        check('(b) `.report().attempts`', rep.attempts, 1);
        note(
            '(b) → `.inspect()` exists to answer "what did the server actually send?"',
            'on a mid-stream failure it answers `null`, with `status: 0` — the 200 is not even reported',
        );
    }

    // ── (c) hooks are not a channel either ───────────────────────────────────────────────────
    // `onError` never fires for a post-200 failure (C5e), and `onResponse` fires before any frame
    // is parsed, so a hook has no moment at which the partial exists and it is on the context.
    {
        const clock = manualClock();
        const api = dropAfter3(clock);
        const fired: string[] = [];
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: () => {
                    fired.push('onRequest');
                },
                onResponse: () => {
                    fired.push('onResponse');
                },
                onError: () => {
                    fired.push('onError');
                },
            },
        });
        const obs = await observe(chat, {}, clock);
        checkSeq('(c) hooks fired across the failed run', fired, [
            'onRequest',
            'onResponse',
        ]);
        check('(c) run ok', obs.ok, false);
    }

    // ── (d) the engine HELD the partial and threw it away ────────────────────────────────────
    // `result` is the event that carries the collected array. On a failing stream it is absent,
    // while `delta` fired three times — so the array existed, fully populated, one line above the
    // early `return`.
    {
        const clock = manualClock();
        const api = dropAfter3(clock);
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const c = collectStitchEvents(chat.stream({}));
        await clock.advance(3_600_000);
        const collected = await c;
        check('(d) `delta` events', collected.deltas.length, 3);
        check('(d) `result` event', String(collected.result), 'undefined');
        check('(d) `done.ok`', collected.done?.ok, false);
        note(
            '(d) → engine.ts:1443 pushes every chunk; engine.ts:1467-1472 returns without emitting `result`',
            'the collected array is complete at the moment it is discarded',
        );
    }

    // ── (e) the user-side fix, which is small ────────────────────────────────────────────────
    // Accumulate as you go and treat the `error` event as "stop, keep what you have". Four lines,
    // and it is the only construction that ends a failed stream holding the tokens you paid for.
    {
        const clock = manualClock();
        const api = dropAfter3(clock);
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        let text = '';
        let failure: string | undefined;
        const drain = (async () => {
            for await (const ev of chat.stream({})) {
                if (ev.type === 'delta')
                    text +=
                        contentOf((ev.chunk as { data: unknown }).data) ?? '';
                if (ev.type === 'error') failure = ev.message;
            }
        })();
        await clock.advance(3_600_000);
        await drain;
        check('(e) partial kept', text, 'ABC');
        check('(e) failure known', failure, 'socket reset by peer');
    }

    finish(
        'C7',
        'REACHABLE — through exactly one channel, `.stream()`, and lost through every other. A drop after 3 of 5 tokens leaves a `.stream()` consumer holding `ABC` (measured), because the deltas were DELIVERED before the failure rather than returned after it. Everything buffered is empty: `.safe().data` is `null`, the thrown `StitchError` has own keys `attempts,body,name,status,url` with `body`, `data`, `partial` and `chunks` all `undefined`, and `.inspect()` — the accessor whose whole job is "what did the server actually send?" — returns `data: null`, `raw: null`, `status: 0`. Hooks are not a channel either (measured hook sequence `[onRequest, onResponse]`; `onError` never fires post-200). The engine is holding the answer at the moment it discards it: `delta` fired 3 times and `result` never did, because engine.ts:1467-1472 returns before reaching `resultEvt(chunks, …)` at engine.ts:1492. Better than scenario 3’s batch residue — there the data had no channel at all — but only for a caller already reading `.stream()`',
    );
}

void main();
