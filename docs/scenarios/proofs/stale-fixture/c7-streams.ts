// C7 — streams: is mid-stream failure deterministic with the published fixtures?
//
// `streamOf` / `streamThenError` / `gatedStream` / `sseStream` are the four stream builders in
// `stitchapi/testing`. The question is whether a mid-stream break — scenario 5's whole subject — is
// reproducible EXACTLY, run after run, with no timing in it.
//
// Measured: yes, and unusually cleanly. The builders are pull-driven (`ReadableStream`'s `pull`,
// one chunk per read), so chunk boundaries are chosen by the fixture rather than by a socket, and
// the same fixture produces byte-identical delta sequences across repeated runs. `streamThenError`
// preserves every delta emitted before the break; `gatedStream` holds a connection open on a
// promise you own; `sseStream` frames well-formed SSE including `id:`/`retry:`/comments.
//
// The one thing they do NOT do is pace: the fixtures carry no time, so `manualClock` has nothing to
// drive in them. Inter-chunk timing is not expressible.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c7-streams.ts
import { sse } from '../../../../packages/core/src/sse';
import { stream } from '../../../../packages/core/src/stream';
import { manualClock } from '../../../../packages/core/src/test-clock';
import { collectStitchEvents } from '../../../../packages/core/src/test-events';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import {
    gatedStream,
    sseStream,
    streamAdapter,
    streamOf,
    streamThenError,
} from '../../../../packages/core/src/test-stream';
import { check, checkSeq, finish, heading, note } from './harness';
import { BASE } from './vendor';

const dec = new TextDecoder();

/** Read a `ReadableStream` to the end, returning the chunks as strings plus any terminal error. */
async function readAll(
    rs: ReadableStream<Uint8Array>,
): Promise<{ chunks: string[]; error: string | null }> {
    const reader = rs.getReader();
    const chunks: string[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(dec.decode(value));
        }
        return { chunks, error: null };
    } catch (e) {
        return { chunks, error: (e as Error).message };
    }
}

async function main(): Promise<void> {
    heading(
        'C7 (a) — `streamOf`: chunk boundaries are the fixture’s to choose',
    );
    {
        const a = await readAll(streamOf(['A', 'B', 'C']));
        checkSeq('three chunks arrive as three reads', a.chunks, [
            'A',
            'B',
            'C',
        ]);
        // The same bytes, split differently — a single SSE line across two chunks.
        const b = await readAll(streamOf(['data: he', 'llo\n\n']));
        checkSeq('…and a line can be split mid-token', b.chunks, [
            'data: he',
            'llo\n\n',
        ]);
        note(
            '(a) → `streamOf` enqueues exactly one chunk per `pull` (test-stream.ts:18-27), so cross-chunk buffering is testable at any boundary you name',
            '',
        );
    }

    heading('C7 (b) — `streamThenError`: the deltas before the break survive');
    {
        const clock = manualClock();
        const api = mockAdapter([
            {
                respond: {
                    headers: { 'content-type': 'text/event-stream' },
                    stream: streamThenError(
                        [
                            'data: {"t":"A"}\n\n',
                            'data: {"t":"B"}\n\n',
                            'data: {"t":"C"}\n\n',
                        ],
                        new Error('socket reset'),
                    ),
                },
            },
        ]);
        const feed = sse({ url: `${BASE}/feed`, adapter: api, clock });
        const c = await collectStitchEvents(feed());
        checkSeq('the event spine', c.types, [
            'start',
            'progress',
            'delta',
            'delta',
            'delta',
            'error',
            'done',
        ]);
        checkSeq(
            'the deltas delivered before the break (data is JSON-parsed)',
            c.deltas.map((d) => (d as { data: unknown }).data),
            [{ t: 'A' }, { t: 'B' }, { t: 'C' }],
        );
        check('the error message', c.error?.message, 'socket reset');
        check('done.ok', c.done?.ok, false);
        note(
            '(b) → a mid-stream failure surfaces as an `error` EVENT with every prior delta intact — not a throw that discards them. That is the assertion scenario 5 needs',
            '',
        );
    }

    heading('C7 (c) — and it is deterministic across runs');
    {
        const run = async (): Promise<string> => {
            const api = mockAdapter([
                {
                    respond: {
                        headers: { 'content-type': 'text/event-stream' },
                        stream: streamThenError(['data: A\n\n', 'data: B\n\n']),
                    },
                },
            ]);
            const feed = sse({ url: `${BASE}/feed`, adapter: api });
            const c = await collectStitchEvents(feed());
            return JSON.stringify({
                types: c.types,
                deltas: c.deltas.map((d) => (d as { data: unknown }).data),
                error: c.error?.message,
                ok: c.done?.ok,
            });
        };
        const runs = [
            await run(),
            await run(),
            await run(),
            await run(),
            await run(),
        ];
        check('5 runs, distinct outcomes', new Set(runs).size, 1);
        note('the single outcome', runs[0]);
        note(
            '(c) → byte-identical five times. The default error is the literal `stream broke mid-flight` (test-stream.ts:58), so even the message is fixed',
            '',
        );
    }

    heading(
        'C7 (d) — a CLEAN truncation is indistinguishable from a complete stream',
    );
    {
        // The counterpart finding: `streamOf` closes the stream, which is a well-formed end. If the
        // vendor drops the connection cleanly mid-response, nothing in the event spine says so.
        const complete = mockAdapter([
            {
                respond: {
                    headers: { 'content-type': 'text/event-stream' },
                    stream: sseStream(['A', 'B', 'C']),
                },
            },
        ]);
        const truncated = mockAdapter([
            {
                respond: {
                    headers: { 'content-type': 'text/event-stream' },
                    stream: sseStream(['A', 'B']),
                },
            },
        ]);
        const full = await collectStitchEvents(
            sse({ url: `${BASE}/f`, adapter: complete })(),
        );
        const cut = await collectStitchEvents(
            sse({ url: `${BASE}/f`, adapter: truncated })(),
        );
        checkSeq('complete spine', full.types, [
            'start',
            'progress',
            'delta',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        checkSeq('truncated spine', cut.types, [
            'start',
            'progress',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        check(
            'both report ok',
            `${String(full.done?.ok)}/${String(cut.done?.ok)}`,
            'true/true',
        );
        note(
            '(d) → the ONLY difference is the delta count. A clean early close is `result` + `done(ok:true)`, same as success — so "the vendor stopped early" is not a failure the fixtures can make the engine report. You have to count deltas yourself',
            '',
        );
    }

    heading(
        'C7 (e) — `gatedStream`: a connection held open on a promise you own',
    );
    {
        let open = true;
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const body = gatedStream('data: first\n\n', gate);
        const api = mockAdapter([
            {
                respond: {
                    headers: { 'content-type': 'text/event-stream' },
                    stream: body,
                },
            },
        ]);
        const feed = sse({ url: `${BASE}/longpoll`, adapter: api });
        const done = collectStitchEvents(feed()).then((c) => {
            open = false;
            return c;
        });
        await new Promise<void>((r) => {
            setTimeout(r, 20);
        });
        check('still open while the gate is unresolved', open, true);
        release();
        const c = await done;
        check('…and it closes when you resolve it', open, false);
        checkSeq('the spine', c.types, [
            'start',
            'progress',
            'delta',
            'result',
            'done',
        ]);
        note(
            '(e) → the "long-lived connection" shape with no timers in it at all. Concurrency and cancellation tests get a deterministic held-open socket',
            '',
        );
    }

    heading('C7 (f) — `sseStream`: the frames it actually writes');
    {
        const frames = await readAll(
            sseStream([
                'plain',
                { data: { t: 1 }, event: 'token', id: 'e1' },
                { data: 'multi\nline' },
                { comment: 'keep-alive', data: '' },
                { data: 'x', retry: 3000 },
            ]),
        );
        checkSeq('one frame per chunk', frames.chunks, [
            'data: plain\n\n',
            'event: token\nid: e1\ndata: {"t":1}\n\n',
            'data: multi\ndata: line\n\n',
            ': keep-alive\ndata: \n\n',
            'retry: 3000\ndata: x\n\n',
        ]);
        note(
            '(f) → a bare string is `{ data }`; a non-string `data` is JSON-stringified; a multi-line payload is split across `data:` lines per the spec; `comment`/`event`/`id`/`retry` all render. These are well-formed frames, not an approximation',
            '',
        );
    }

    heading(
        'C7 (g) — `streamAdapter`: the minimal transport, and its one rule',
    );
    {
        const ok = await collectStitchEvents(
            sse({
                url: `${BASE}/f`,
                adapter: streamAdapter(sseStream(['A'])),
            })(),
        );
        checkSeq('it drives the sse surface', ok.types, [
            'start',
            'progress',
            'delta',
            'result',
            'done',
        ]);
        // It REJECTS a non-streaming request — the one contract it enforces.
        let msg = '';
        try {
            await streamAdapter(streamOf(['x']))({
                url: `${BASE}/f`,
                method: 'GET',
                headers: {},
            });
        } catch (e) {
            msg = (e as Error).message;
        }
        check(
            'a buffered request is refused',
            msg,
            'expected req.stream to be set',
        );
        note(
            '(g) → `streamAdapter` is 8 lines and checks exactly one thing (test-stream.ts:129-131). Compare C3: that is one more runtime check than `mockAdapter` performs on a fixture body',
            '',
        );
    }

    heading('C7 (h) — the fixtures carry no TIME');
    {
        const clock = manualClock();
        const api = mockAdapter([
            {
                respond: {
                    headers: { 'content-type': 'text/event-stream' },
                    stream: sseStream(['A', 'B', 'C']),
                },
            },
        ]);
        const at: number[] = [];
        const feed = sse({ url: `${BASE}/f`, adapter: api, clock });
        for await (const e of feed().stream()) {
            if (e.type === 'delta') at.push(clock.now());
        }
        checkSeq('virtual time at each delta', at, [0, 0, 0]);
        note(
            '(h) → every chunk arrives at virtual 0. There is no `delay` on `SseFixtureEvent` and no per-chunk pacing on `streamOf`, so "the vendor sent a token every 200ms" is not expressible. `mockAdapter.delay` paces the RESPONSE, not the chunks — and it uses a real `setTimeout`, so it is wall-clock (C2)',
            '',
        );
    }

    heading('C7 (i) — the raw `stream` surface, same builders');
    {
        const api = mockAdapter([
            {
                respond: {
                    stream: streamThenError(['{"a":1}\n', '{"a":2}\n']),
                },
            },
        ]);
        const lines = stream({
            url: `${BASE}/ndjson`,
            adapter: api,
            stream: 'ndjson',
        });
        const c = await collectStitchEvents(lines());
        checkSeq('spine', c.types, [
            'start',
            'progress',
            'delta',
            'delta',
            'error',
            'done',
        ]);
        checkSeq('deltas', c.deltas, [{ a: 1 }, { a: 2 }]);
        check('error', c.error?.message, 'stream broke mid-flight');
        note(
            '(i) → the same builders drive the non-SSE `stream` surface, decoded per `stream: "ndjson"`. Determinism is a property of the builder, not of the surface',
            '',
        );
    }

    finish(
        'C7',
        'CONFIRMED — MID-STREAM FAILURE IS FULLY DETERMINISTIC. `streamThenError` over an `sse` stitch produced the spine `start,progress,delta,delta,delta,error,done` with all three deltas intact before the break, `error.message` "socket reset", `done.ok` false — and five repeat runs produced ONE distinct outcome, byte-identical, including the default message `stream broke mid-flight`. `gatedStream` holds a connection open on a promise you resolve (verified open at +20ms, closed on release). `sseStream` writes well-formed frames — a bare string becomes `data: plain\\n\\n`, a non-string `data` is JSON-stringified, a multi-line payload splits across `data:` lines, and `comment`/`event`/`id`/`retry` all render. The same builders drive the raw `stream` surface with `stream: "ndjson"` decoding. TWO LIMITS, both about what a fixture cannot say. (1) A CLEAN early close is indistinguishable from a complete stream: 3 deltas and 2 deltas both end `result` + `done(ok:true)`, so "the vendor stopped early" is a delta count you check yourself, not a failure the engine reports. (2) The fixtures carry no time — all three deltas arrive at `clock.now() === 0`, there is no `delay` on `SseFixtureEvent` and no per-chunk pacing on `streamOf`, so inter-chunk timing is not expressible at all; `mockAdapter.delay` paces the whole response and does it on a real `setTimeout`',
    );
}

void main();
