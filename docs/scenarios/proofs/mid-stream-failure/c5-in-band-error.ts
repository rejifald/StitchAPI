// C5 — an in-band `data: {"error": {...}}` frame arriving at HTTP 200. Can it become a REAL
// failure? The capture nominates three candidates: `verdictOf`, a custom surface's `interpret`, and
// hooks. Two of the three are structurally unavailable on a streaming surface, and the reason is
// worth stating precisely because it also answers "when does `interpret` run relative to the body".
//
// It does not run. Not once, not early, not late. `runStreaming` (engine.ts:1248) never calls
// `interpretOf(surface)` — the only verdict it takes is `classifyStatus(res.status, cfg)` at
// engine.ts:1371, which is deliberately status-only because at open time there is no buffered body
// to rule on. So the surface hook that exists precisely to say "this 200 is actually a failure" is
// dead code on every streaming surface.
//
// The one thing that DOES work is `output`, and it works well: per-`delta` contract validation
// (engine.ts:1414-1436) runs BEFORE the delta is emitted, so a rejecting schema both fails the run
// and withholds the bad frame from the consumer.
//
//   pnpm exec tsx docs/scenarios/proofs/mid-stream-failure/c5-in-band-error.ts
import { stitch } from '../../../../packages/core/src/index';
import { sse, sseSurface } from '../../../../packages/core/src/sse';
import type { StandardSchemaV1 } from '../../../../packages/core/src/standard-schema';
import type { Surface } from '../../../../packages/core/src/surface';
import { verdictOf } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeStreamProvider, errorOf } from './fake-llm-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { observe } from './observe';

const URL = 'https://api.openai.example/v1/chat/completions';
const TOKENS = ['A', 'B', 'C', 'D', 'E'];

/** A provider that streams 2 tokens and then an in-band error frame, at HTTP 200 throughout. */
const inBand = (clock: ReturnType<typeof manualClock>): FakeStreamProvider =>
    new FakeStreamProvider({ clock, tokens: TOKENS, errorFrameAfter: 2 });

async function main(): Promise<void> {
    heading('C5 — an in-band error frame at HTTP 200: can it fail the call?');

    // ── (a) the default: it is just another delta, and the run SUCCEEDS ───────────────────────
    {
        const clock = manualClock();
        const api = inBand(clock);
        const chat = sse({ url: URL, adapter: api.adapter(), clock });
        const obs = await observe(chat, {}, clock);
        check('(a) text delivered', obs.text, 'AB');
        check('(a) in-band error frames observed', obs.errorFrames, 1);
        check('(a) done.ok', obs.ok, true);
        checkSeq('(a) event spine', obs.events, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'delta', // ← the error frame, indistinguishable from a token at the engine level
            'result',
            'done',
        ]);
        note(
            '(a) → the provider said it failed and the client says it succeeded',
            'the error is in the delta array; nothing looks at it',
        );
    }

    // ── (b) a custom surface's `interpret` — NEVER CALLED ─────────────────────────────────────
    // The obvious move: clone `sseSurface`, add an `interpret` that composes `verdictOf`. It
    // typechecks, it is the documented seam for "this 200 is a failure" (surface.ts:174-191), and
    // on a streaming surface it runs ZERO times.
    {
        let interpretCalls = 0;
        const guarded: Surface = {
            ...sseSurface,
            id: 'sse-guarded',
            interpret: (res, cfg) => {
                interpretCalls++;
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const clock = manualClock();
        const api = inBand(clock);
        const chat = stitch({
            url: URL,
            kind: guarded,
            adapter: api.adapter(),
            clock,
        });
        const r = await chat.safe({});
        check('(b) times `interpret` ran', interpretCalls, 0);
        check('(b) ok', r.ok, true);
        check('(b) collected deltas', (r.data as unknown[] | null)?.length, 3);
        note(
            '(b) → `interpret` is the surface model’s answer to this exact question',
            'and `runStreaming` never calls it: only `classifyStatus(res.status)` at engine.ts:1371',
        );
    }

    // ── (c) `verdict.flag` — silently inert on a stream ───────────────────────────────────────
    // `verdict.flag` is read by `verdictOf`, which only `interpret` calls. On a streaming stitch it
    // is accepted by the config, typechecks, and does nothing at all — not even a drift finding.
    {
        const clock = manualClock();
        const api = inBand(clock);
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            verdict: { flag: 'ok' },
        });
        const r = await chat.safe({});
        check('(c) `verdict.flag: "ok"` → ok', r.ok, true);
        check('(c) collected deltas', (r.data as unknown[] | null)?.length, 3);
        const rep = await chat.report({});
        check('(c) drift findings from the inert flag', rep.findings.length, 0);
    }

    // ── (d) hooks — `onResponse` fires before a single frame is parsed ────────────────────────
    // `hooks.onResponse` runs at engine.ts:1352, immediately after the adapter returns and before
    // the body is decoded, so `ctx.res.body` is a live `ReadableStream` and there is nothing in it
    // to inspect yet. Reading it would consume the stream out from under the surface.
    {
        const clock = manualClock();
        const api = inBand(clock);
        let bodyKind = '';
        let deltasAtHook = -1;
        const seen: string[] = [];
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            hooks: {
                onResponse: (ctx) => {
                    seen.push('onResponse');
                    bodyKind =
                        ctx.res?.body instanceof ReadableStream
                            ? 'ReadableStream'
                            : typeof ctx.res?.body;
                    deltasAtHook = 0;
                },
                onError: (ctx) => {
                    seen.push(
                        `onError:${String((ctx.error as Error).message)}`,
                    );
                },
            },
        });
        const obs = await observe(chat, {}, clock);
        check(
            '(d) `onResponse` fired',
            seen.filter((s) => s === 'onResponse').length,
            1,
        );
        check('(d) `ctx.res.body` at hook time', bodyKind, 'ReadableStream');
        check('(d) deltas available at hook time', deltasAtHook, 0);
        check(
            '(d) `onError` fired for the in-band error',
            seen.some((s) => s.startsWith('onError')),
            false,
        );
        check('(d) run still ok', obs.ok, true);
    }

    // ── (e) `onError` does not fire for a TRANSPORT drop either ──────────────────────────────
    // Worth pinning while we are here: the mid-body `catch` at engine.ts:1446-1449 records the
    // error and returns `'error'` WITHOUT calling `hooks.onError` (only the open-phase catch at
    // engine.ts:1354 does). So a stream that fails after the 200 fires no error hook at all, even
    // though the run fails.
    {
        const clock = manualClock();
        const api = new FakeStreamProvider({
            clock,
            tokens: TOKENS,
            cut: { after: 2, how: 'error' },
        });
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
        checkSeq('(e) hooks fired on a mid-body drop', fired, [
            'onRequest',
            'onResponse',
        ]);
        check('(e) run ok', obs.ok, false);
        note(
            '(e) → the run failed and `hooks.onError` never fired',
            'a hook-based error pipeline misses every post-200 stream failure',
        );
    }

    // ── (f) `output` — the ONE thing that works, and it works properly ────────────────────────
    // Per-`delta` contract validation (engine.ts:1414-1436) runs before the delta is emitted, on the
    // value the surface's `contractValue` picks (`sse` → the event's `data`). An `error` finding
    // fails the stream — and the offending frame is WITHHELD from the consumer.
    {
        const rejectErrorFrames: StandardSchemaV1 = {
            '~standard': {
                version: 1,
                vendor: 'mid-stream-failure-proof',
                validate: (value: unknown) =>
                    errorOf(value) !== undefined
                        ? {
                              issues: [
                                  {
                                      message: `provider sent an in-band error: ${String(errorOf(value)?.message)}`,
                                  },
                              ],
                          }
                        : { value },
            },
        };
        const clock = manualClock();
        const api = inBand(clock);
        const chat = sse({
            url: URL,
            adapter: api.adapter(),
            clock,
            output: rejectErrorFrames,
        });
        const obs = await observe(chat, {}, clock);
        checkSeq('(f) event spine', obs.events, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'drift', // the contract rejected the error frame
            'error',
            'done',
        ]);
        check('(f) text delivered', obs.text, 'AB');
        check(
            '(f) was the error frame delivered to the consumer?',
            obs.errorFrames,
            0,
        );
        check('(f) done.ok', obs.ok, false);
        check('(f) error.message', obs.error, 'contract violation (drift)');

        const p = chat.safe({});
        await clock.advance(3_600_000);
        const r = await p;
        check('(f) await → ok', r.ok, false);
        check(
            '(f) await → error.message',
            r.error?.message,
            'contract violation (drift)',
        );
        note(
            '(f) → the message the schema authored is on the drift FINDING, not the error',
            'the thrown error says only `contract violation (drift)`; `.report().findings` carries the detail',
        );
        const rep = await chat.report({});
        check('(f) findings on the report', rep.findings.length >= 1, true);
        note('(f) finding detail', rep.findings[0]?.detail ?? '(none)');
    }

    finish(
        'C5',
        'YES, but through exactly ONE seam, and it is not the one the capture nominates. A custom surface’s `interpret` runs ZERO times on a streaming stitch (measured) — `runStreaming` never calls `interpretOf`, only `classifyStatus(res.status, cfg)` at engine.ts:1371, so the surface hook whose job is "this 200 is really a failure" is dead code here; `verdict.flag` rides the same path and is silently inert (ok:true, and not even a drift finding). Hooks cannot see it either: `onResponse` fires before a single frame is parsed (`ctx.res.body` measured as a live `ReadableStream`), and `hooks.onError` does not fire for an in-band error NOR for a real transport drop — measured hook sequence on a mid-body drop is `[onRequest, onResponse]` while the run fails. What works is `output`: per-`delta` validation runs BEFORE the delta is emitted, so a schema that rejects `{ error: … }` frames turns the frame into `drift` → `error` → `done(ok:false)` AND withholds it from the consumer (measured: 0 error frames delivered, text `AB`). The cost is that the thrown message is the generic `contract violation (drift)` — the schema’s own message survives only on `.report().findings`',
    );
}

void main();
