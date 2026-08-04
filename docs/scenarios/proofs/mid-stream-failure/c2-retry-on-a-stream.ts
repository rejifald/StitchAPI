// C2 — THE DECIDING CLAIM. With `retry` configured on a STREAMING stitch and a mid-body drop after
// N deltas have already been yielded to the consumer: are those N deltas RE-EMITTED?
//
// This is the "fragment already held by a downstream accumulator" hazard the research capture calls
// the sharp one. The capture predicts duplication. It is WRONG, and the reason it is wrong is a
// bigger finding than the prediction would have been: `retry` does not run on a streaming stitch AT
// ALL. Not once, for any status, for any `on`. The streaming path (`engine.ts:1248` `runStreaming`)
// is a different function from the buffered `attemptLoop` and has no retry loop in it — its only
// loop is the reconnect loop (C3/C4), which is off by default.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c2-retry-on-a-stream.ts
import { stitch } from '../../../../packages/core/src/index';
import { sse } from '../../../../packages/core/src/sse';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Adapter,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { FakeStreamProvider } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

async function main(): Promise<void> {
    heading('C2 — does `retry` re-emit already-delivered deltas?');

    // ── (a) `retry: { attempts: 3 }` + a mid-body drop after 3 tokens ─────────────────────────
    // The measured delta sequence is `ABC`. Once. Not `ABCABCABC`.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 3, how: 'error' },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const obs = await observe(chat, {}, clock);
        checkSeq(
            '(a) DELTA SEQUENCE the consumer observed',
            obs.data.map((d) => JSON.stringify(d).slice(0, 40)),
            [
                '{"object":"chat.completion.chunk","choic',
                '{"object":"chat.completion.chunk","choic',
                '{"object":"chat.completion.chunk","choic',
            ],
        );
        check('(a) TEXT the accumulator holds', obs.text, 'ABC');
        check('(a) opens the server saw', api.opens.length, 1);
        check('(a) done.ok', obs.ok, false);
        check('(a) any content duplicated?', obs.text === 'ABC', true);
        note(
            '(a) → NO duplication. Also no retry: `attempts: 3` produced ONE open',
            'the capture predicted `ABCABCABC`; the measurement is `ABC`',
        );
    }

    // ── (b) the control — `retry` is not merely "not triggered", it is INERT on a stream ──────
    // Same status, same `retry`, two surfaces. A 503 is in the default `retry.on`
    // (`[429, 502, 503, 504]` — engine.ts:612), so the buffered stitch retries it 4 times. The
    // streaming stitch opens ONCE and gives up.
    {
        const mk503 = (): { adapter: Adapter; count: () => number } => {
            let n = 0;
            return {
                count: () => n,
                adapter: () => {
                    n++;
                    return Promise.resolve({
                        status: 503,
                        headers: {},
                        body: { error: 'overloaded' },
                    } satisfies AdapterResponse);
                },
            };
        };

        const clockA = manualClock();
        const a = mk503();
        const buffered = stitch({
            url: URL,
            adapter: a.adapter,
            clock: clockA,
            retry: { attempts: 4 },
        });
        const pa = buffered.safe({});
        await clockA.advance(3_600_000);
        await pa;

        const clockB = manualClock();
        const b = mk503();
        const streaming = sse({
            url: URL,
            adapter: b.adapter,
            clock: clockB,
            retry: { attempts: 4 },
        });
        const pb = streaming.safe({});
        await clockB.advance(3_600_000);
        const rb = await pb;

        check('(b) BUFFERED stitch, retry.attempts 4 → requests', a.count(), 4);
        check(
            '(b) STREAMING stitch, retry.attempts 4 → requests',
            b.count(),
            1,
        );
        check('(b) streaming ok', rb.ok, false);
        check('(b) streaming error.attempts', rb.error?.attempts, 1);
        note(
            '(b) → same config, same status, same engine',
            '`retry` is read for the reconnect BACKOFF and nothing else on a streaming surface',
        );
    }

    // ── (c) the one thing `retry` DOES do on a stream: pace a reconnect ───────────────────────
    // `runStreaming` falls back to `backoffDelay(attempt + 1, cfg.retry)` (engine.ts:1481) when no
    // server `retry:` and no `reconnect.delay` is set. So `retry.backoff` is live — as a CURVE for
    // the reconnect loop, never as an attempt count.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            cut: { after: 1, how: 'error', onOpens: [1, 2, 3, 4] },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: { attempts: 3 } },
            retry: { attempts: 1, backoff: { curve: 'fixed', base: '5s' } },
        });
        await observe(chat, {}, clock);
        checkSeq('(c) virtual ms between opens', api.gaps, [5000, 5000, 5000]);
        check(
            '(c) opens, with retry.attempts 1',
            api.opens.length,
            4, // 1 + reconnect.attempts 3 — the RECONNECT cap, not the retry cap
        );
        note(
            '(c) → `retry.attempts: 1` and four opens happened anyway',
            'the two knobs that look like they cap the same thing cap different things',
        );
    }

    // ── (d) the default reconnect backoff, when no `retry` block is authored ──────────────────
    // `backoffDelay` defaults to `expo-jitter` off base 100 (resilience.ts:39-56), so the first
    // reconnect lands in [0, 100) ms. A dropped LLM stream is replayed within a tenth of a second.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            ids: 'per-token',
            cut: { after: 1, how: 'error', onOpens: [1, 2, 3, 4] },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
        });
        await observe(chat, {}, clock);
        const gaps = api.gaps;
        check('(d) reconnects', gaps.length, 3);
        check(
            '(d) first reconnect wait < 100ms',
            (gaps[0] as number) < 100,
            true,
        );
        check(
            '(d) every wait < 500ms',
            gaps.every((g) => g < 500),
            true,
        );
        note(
            '(d) measured waits (ms)',
            gaps.map((g) => Math.round(g)).join(', '),
        );
    }

    finish(
        'C2',
        'NO — and the capture is refuted twice over. The measured delta sequence under `retry: { attempts: 3 }` with a drop after 3 of 5 tokens is `ABC`, ONE time: no fragment is replayed into a downstream accumulator. The reason is that `retry` does not run on a streaming stitch AT ALL — the control pins it: the same `retry: { attempts: 4 }` against the same always-503 fake makes 4 requests on a buffered stitch and 1 on an `sse` one, and `error.attempts` is 1. `runStreaming` (engine.ts:1248) has no attempt loop; the only loop is the reconnect loop. `retry` is not ignored, though — `retry.backoff` supplies the reconnect CURVE (`fixed 5s` → measured gaps 5000,5000,5000) while `retry.attempts` is inert there, so the two knobs that look like one cap different things. And the default reconnect backoff is `expo-jitter` off base 100: measured first wait under 100ms. The duplication hazard is real in this library, but it is `sse.reconnect` that causes it (C4), not `retry`',
    );
}

void main();
