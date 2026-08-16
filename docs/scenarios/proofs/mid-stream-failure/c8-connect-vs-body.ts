// C8 — THE OTHER DECIDING CLAIM. Can retry be enabled for the CONNECT phase (a 503 before any byte
// is written — safe to replay, nothing has been delivered) and disabled once bytes have flowed
// (unsafe — a replay duplicates content the consumer already has)? That is the policy every LLM
// client actually wants, and it is the one thing this scenario is really asking for.
//
// The answer is that NO combination of config expresses it. `retry` does not run on a streaming
// stitch at all (C2), and `sse.reconnect` covers only half of the connect phase: it retries a
// TRANSPORT throw (nothing was delivered, so nothing can duplicate — engine.ts:1518 counts an
// empty spine as recoverable), but an HTTP-status refusal is terminal before the reconnect loop
// ever sees it. Since #647 the flag no longer drags body replay in with it (C4) — the gap that
// remains is precisely the 503-before-any-byte.
//
// There is a clean seam, and it is `Surface.execute` (surface.ts:133): a transport that owns the
// connect and nothing else. It is called at engine.ts:1400, inside the resilience chain, BEFORE the
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
    // `classifyStatus` at engine.ts:1420 makes a rejected status TERMINAL — `return 'fail'` — so the
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

    // ── (c) …but a transport-level THROW is reconnected ──────────────────────────────────────
    // An `ECONNREFUSED` (the adapter rejects) returns `'error'` from `openAndDecode`
    // (engine.ts:1402-1408), and with zero chunks delivered the drop counts as recoverable
    // (engine.ts:1518) — so `reconnect` does cover the THROWN half of the connect phase. The
    // status half, the one real providers use to refuse, it never sees.
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
            '(c) → so `reconnect: true` DOES retry a refused connect — when the refusal is a THROW',
            'an HTTP-status refusal stays terminal (b), and a 503 is how an overloaded provider actually refuses',
        );
    }

    // ── (d) the config trick that used to appear to work, and the silent success it hides ────
    // `verdict.accept: [503]` makes the 503 an acceptable status, so the streaming path opens its
    // (buffered, non-stream) body, decodes nothing, and returns `'closed'`. Before #647 a close
    // was treated as a drop, so this actually reconnected — measured then: 9 opens against this
    // healing server, with the answer replayed 7 times once it healed. Now a clean close is the
    // stream FINISHING (engine.ts:1524-1529), so the accepted 503 ENDS the run: the trick no
    // longer buys even the connect retry, and a server that is 503 FOREVER still resolves the
    // call SUCCESSFULLY with zero deltas.
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
        check('(d) opens against a healing server', healing.opens.length, 1);
        check(
            '(d) text — the server healed and was never asked again',
            a.text,
            '',
        );
        check('(d) …and that empty run "succeeded"', a.ok, true);

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
            '(d) → an accepted 503 resolves as a SUCCESSFUL empty stream',
            'still true after #647 — the trick was never a connect retry, only a silent-failure generator',
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
            '#647 made the last two engine behaviour — only a drop reconnects, and never without a token once bytes flowed — so the one still missing is the phase split, and `execute` is still how you write it',
        );
    }

    finish(
        'C8',
        'NOT IN CONFIG — the phases are still not separately addressable, and the gap that remains is the HTTP-status connect refusal. `retry` never runs on a streaming stitch (measured: 1 open against a 503 with `retry: { attempts: 4 }`, versus 4 on the buffered control), so the one case where replay is unambiguously safe is the one case it cannot cover. `sse.reconnect` does not cover it either: `classifyStatus` makes a rejected status terminal (measured: 1 open with BOTH `retry` and `reconnect` on, 0 reconnects). It DOES retry a transport-level throw — measured 4 connect attempts on `ECONNREFUSED`, safe because nothing was delivered — and since #647 that no longer drags body replay in with it (C4). The config workaround is now a pure trap: `verdict.accept: [503]` no longer reconnects at all — measured 1 open against a healing server, empty text, `ok: true` (before #647: 9 opens, the answer replayed 7 times) — and a permanently-503 server still resolves SUCCESSFULLY with `data: []`. What works is unchanged, `Surface.execute` (surface.ts:133): 10 lines of transport that retry only the connect. Measured in one run — 2 × 503 absorbed, then a body that drops after 3 tokens delivered ONCE (`ABC`), `done(ok:false)`, 0 reconnects. Missing, machine-checked: `retry.phase`, `reconnect.onlyOnDrop`, `reconnect.requireToken` — the last two became engine behaviour in #647; the phase split still needs `execute`',
    );
}

void main();
