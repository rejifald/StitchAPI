// C8 — THE OTHER DECIDING CLAIM. Can retry be enabled for the CONNECT phase (a 503 before any byte
// is written — safe to replay, nothing has been delivered) and disabled once bytes have flowed
// (unsafe — a replay duplicates content the consumer already has)? That is the policy every LLM
// client actually wants, and it is the one thing this scenario is really asking for.
//
// The answer is that NO combination of config expresses it, for a reason that is easy to miss: the
// two phases are not separately addressable. `retry` does not run on a streaming stitch at all
// (C2), and `sse.reconnect` is a SINGLE flag that governs both phases at once — turn it on to get
// connect recovery and you have also turned on the body replay that duplicates content (C4).
//
// There is a clean seam, and it is `Surface.execute` (surface.ts:118): a transport that owns the
// connect and nothing else. It is called at engine.ts:1351, inside the resilience chain, BEFORE the
// body is decoded — so a retry loop inside it provably cannot re-deliver a delta.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c8-connect-vs-body.ts
import { stitch } from '../../../../packages/core/src/index';
import { sse, sseSurface } from '../../../../packages/core/src/sse';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { FakeStreamProvider } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

/**
 * USER CODE — the `sse` surface with a connect-phase-only retry in its transport. Ten executable
 * lines. It cannot possibly duplicate a delta: by the time it returns, not one byte of the body has
 * been read, and it is never re-entered for a body failure.
 */
function sseRetryingConnect(inner: Adapter, attempts = 4): Surface {
    return {
        ...sseSurface,
        id: 'sse-connect-retry',
        execute: async (req: AdapterRequest): Promise<AdapterResponse> => {
            let last: AdapterResponse | undefined;
            for (let i = 0; i < attempts; i++) {
                last = await inner(req);
                if (![429, 502, 503, 504].includes(last.status)) return last;
            }
            return last as AdapterResponse;
        },
    };
}

async function main(): Promise<void> {
    heading('C8 — connect-phase retry ON, body-phase retry OFF: expressible?');

    // ── (a) `retry` does not reach the connect phase of a stream ─────────────────────────────
    // A 503 before any byte, with `retry: { attempts: 4 }`. The buffered control retries it four
    // times (503 is in the default `retry.on`); the streaming stitch opens once and fails.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 2 },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 4 },
        });
        const obs = await observe(chat, {}, clock);
        check('(a) opens', api.opens.length, 1);
        check('(a) done.ok', obs.ok, false);
        check('(a) error.message', obs.error, 'HTTP 503');
        note(
            '(a) → the ONE case where replaying is unambiguously safe, and `retry` cannot do it',
            'nothing was delivered, so nothing could be duplicated — and it still gives up',
        );
    }

    // ── (b) `reconnect` does not reach it either, when the refusal is an HTTP STATUS ─────────
    // `classifyStatus` at engine.ts:1371 makes a rejected status TERMINAL — `return 'fail'` — so the
    // reconnect loop never sees it. Documented as deliberate ("the server actively refused").
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 2 },
        });
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            sse: { reconnect: true },
            retry: { attempts: 4 },
        });
        const obs = await observe(chat, {}, clock);
        check(
            '(b) opens with BOTH retry and reconnect on',
            api.opens.length,
            1,
        );
        check('(b) reconnects', obs.reconnects, 0);
        check('(b) done.ok', obs.ok, false);
    }

    // ── (c) …but a transport-level THROW is reconnected — by the same flag that duplicates ───
    // An `ECONNREFUSED` (the adapter rejects) returns `'error'` from `openAndDecode`
    // (engine.ts:1353-1359), which IS reconnectable. So connect recovery does exist — welded to the
    // body replay. One flag, two phases, no way to separate them.
    {
        const clock = manualClock();
        let calls = 0;
        const refusing: Adapter = () => {
            calls++;
            return Promise.reject(new Error('ECONNREFUSED'));
        };
        const chat = sse({
            url: URL,
            adapter: refusing,
            clock,
            sse: { reconnect: true },
        });
        const obs = await observe(chat, {}, clock);
        check('(c) connect attempts on a THROWN failure', calls, 4);
        check('(c) done.ok', obs.ok, false);
        check('(c) error.message', obs.error, 'ECONNREFUSED');
        note(
            '(c) → so `reconnect: true` DOES retry a refused connect',
            'and the same `reconnect: true` replays the whole answer once bytes flow (C4)',
        );
    }

    // ── (d) the config trick that appears to work, and the silent success it hides ───────────
    // `verdict.accept: [503]` makes the 503 an acceptable status, so the streaming path opens its
    // (buffered, non-stream) body, decodes nothing, returns `'closed'` — and reconnects. It works.
    // It also means a server that is 503 FOREVER resolves the call SUCCESSFULLY with zero deltas.
    {
        const clock = manualClock();
        const healing = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 2 },
        });
        const a = await observe(
            sse({
                url: URL,
                adapter: healing.adapter(),
                clock,
                verdict: { accept: [503] },
                sse: { reconnect: { attempts: 8 } },
            }),
            {},
            clock,
        );
        check('(d) opens against a healing server', healing.opens.length, 9);
        check(
            '(d) text — note the replays after it healed',
            a.text,
            'ABCDEABCDEABCDEABCDEABCDEABCDEABCDE',
        );

        const dead = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 999 },
        });
        const chat = sse({
            url: URL,
            adapter: dead.adapter(),
            clock,
            verdict: { accept: [503] },
            sse: { reconnect: true },
        });
        const p = chat.safe({});
        await clock.advance(3_600_000);
        const r = await p;
        check('(d) permanently-503 server → ok', r.ok, true);
        check(
            '(d) permanently-503 server → data',
            JSON.stringify(r.data),
            '[]',
        );
        note(
            '(d) → four 503s in a row resolve as a SUCCESSFUL empty stream',
            'the workaround for the missing connect retry is a silent-failure generator',
        );
    }

    // ── (e) the seam that DOES express the split: `Surface.execute` ──────────────────────────
    // Connect retried until it lands, body NOT retried when it drops. Both halves measured in one
    // run: 2 refusals absorbed, then a body that dies after 3 tokens, delivered once.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 2 },
            cut: { after: 3, how: 'error', onOpens: [3] }, // open 3 is the first 200
        });
        const chat = stitch({
            url: URL,
            kind: sseRetryingConnect(api.adapter()),
            clock,
        });
        const obs = await observe(chat, {}, clock);
        check('(e) transport calls (2 × 503 + 1 × 200)', api.opens.length, 3);
        check('(e) TEXT delivered — once, not replayed', obs.text, 'ABC');
        check('(e) done.ok (the body failure is NOT swallowed)', obs.ok, false);
        check('(e) error.message', obs.error, 'socket reset by peer');
        check('(e) reconnects', obs.reconnects, 0);

        // …and the happy path is untouched.
        const healthy = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            connect: { status: 503, healAfter: 1 },
        });
        const ok = await observe(
            stitch({
                url: URL,
                kind: sseRetryingConnect(healthy.adapter()),
                clock,
            }),
            {},
            clock,
        );
        check('(e) healthy run → text', ok.text, 'ABCDE');
        check('(e) healthy run → done.ok', ok.ok, true);
        check('(e) healthy run → transport calls', healthy.opens.length, 2);
        note(
            '(e) → 10 lines, and the policy is exactly right',
            '`execute` runs before a byte is decoded, so it structurally cannot re-deliver a delta',
        );
    }

    // ── (f) what is missing, machine-checked ─────────────────────────────────────────────────
    // Neither knob has a phase. A `@ts-expect-error` that is NOT an error fails `tsc`, so these
    // three lines are a compile-time assertion that the vocabulary has no way to say it.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({ clock, tokens: TOKENS });
        stitch({
            url: URL,
            kind: sseSurface,
            adapter: api.adapter(),
            clock,
            // @ts-expect-error — `retry` has no phase selector.
            retry: { attempts: 3, phase: 'connect' },
        });
        stitch({
            url: URL,
            kind: sseSurface,
            adapter: api.adapter(),
            clock,
            // @ts-expect-error — `reconnect` cannot be told to fire only on a drop, never on a close.
            sse: { reconnect: { attempts: 3, onlyOnDrop: true } },
        });
        stitch({
            url: URL,
            kind: sseSurface,
            adapter: api.adapter(),
            clock,
            // @ts-expect-error — and it cannot be told to refuse when there is no resume token.
            sse: { reconnect: { attempts: 3, requireToken: true } },
        });
        checkSeq(
            '(f) config keys that would express the policy',
            ['retry.phase', 'reconnect.onlyOnDrop', 'reconnect.requireToken'],
            ['retry.phase', 'reconnect.onlyOnDrop', 'reconnect.requireToken'],
        );
        note(
            '(f) → all three are compile errors (machine-checked by the `@ts-expect-error`s above)',
            'the smallest real fix is `reconnect.requireToken`: it alone would turn C4 from silent replay into a refusal',
        );
    }

    finish(
        'C8',
        'NOT IN CONFIG — and the reason is that the two phases are not separately addressable. `retry` never runs on a streaming stitch (measured: 1 open against a 503 with `retry: { attempts: 4 }`, versus 4 on the buffered control), so the one case where replay is unambiguously safe is the one case it cannot cover. `sse.reconnect` does not help either when the refusal is an HTTP status: `classifyStatus` makes a rejected status terminal (measured: 1 open with BOTH `retry` and `reconnect` on, 0 reconnects). It DOES retry a transport-level throw — measured 4 connect attempts on `ECONNREFUSED` — but that is the same single flag that replays the whole answer once bytes flow, so the two policies cannot be set independently. The config workaround is worse than the gap: `verdict.accept: [503]` + `reconnect` does retry the connect (measured: 9 opens against a healing server) but a permanently-503 server then resolves SUCCESSFULLY with `data: []`, and once it heals it replays the answer 7 times. What works is `Surface.execute` (surface.ts:118): 10 lines of transport that retry only the connect. Measured in one run — 2 × 503 absorbed, then a body that drops after 3 tokens delivered ONCE (`ABC`), `done(ok:false)`, 0 reconnects. Missing, machine-checked: `retry.phase`, `reconnect.onlyOnDrop`, `reconnect.requireToken`',
    );
}

void main();
