// The `sse` surface (ADR 0005 Decision 4): Server-Sent Events over fetch + Web Streams (never
// EventSource). The stream hook parses the text/event-stream wire format off the ReadableStream
// and yields one parsed event per `delta` chunk. Most cases drive the frame parser directly over a
// fake stream (precise chunk boundaries); the engine spine + a real-fetch case round it out.
import { seam, stitch } from '../src';
import { lineReader } from '../src/line-reader';
import { sse, sseSurface } from '../src/sse';
import type { SseEvent } from '../src/sse';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';
import {
    collectEvents,
    streamAdapter,
    streamOf,
    streamThenError,
} from './support/streams';

import { z } from 'zod';

// Run the SSE frame parser over the given chunk boundaries and collect the parsed events. A small
// buffer cap can be threaded through `stream.buffer.chars` (unbounded-buffer guard).
async function parse(
    chunks: string[],
    cfg: { stream?: { buffer?: { chars?: number } } } = {},
): Promise<SseEvent[]> {
    const res = { status: 200, headers: {}, body: streamOf(chunks) };
    const out: SseEvent[] = [];
    // `stream` is defined on a streaming surface; tests may assert non-null. Only `stream.buffer.chars`
    // is read off `cfg`, so this partial config suffices — save for `kind`, which is REQUIRED on a
    // resolved config now that an omitted surface resolves to `httpSurface` (ADR 0022 Decision 2).
    for await (const ev of sseSurface.stream!(res, {
        ...cfg,
        kind: sseSurface,
    }))
        out.push(ev as SseEvent);
    return out;
}

describe('sse surface identity (Decisions 4, 11)', () => {
    test('sseSurface has the stable id "sse" and a stream hook', () => {
        expect(sseSurface.id).toBe('sse');
        expect(typeof sseSurface.stream).toBe('function');
    });

    test('kind round-trips through __config as the id string "sse"', () => {
        const s = sse({ url: 'https://x.test/e' });
        const json = JSON.parse(JSON.stringify(s.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('sse');
    });
});

describe('sse frame parser (Decision 4)', () => {
    test('a single data event', async () => {
        expect(await parse(['data: hello\n\n'])).toEqual([{ data: 'hello' }]);
    });

    test('data is JSON-parsed when it parses, else the raw string', async () => {
        expect(await parse(['data: {"x":1}\n\n'])).toEqual([
            { data: { x: 1 } },
        ]);
        expect(await parse(['data: plain text\n\n'])).toEqual([
            { data: 'plain text' },
        ]);
        expect(await parse(['data: 42\n\n'])).toEqual([{ data: 42 }]);
    });

    test('multiple data: lines join with \\n', async () => {
        expect(await parse(['data: a\ndata: b\n\n'])).toEqual([
            { data: 'a\nb' },
        ]);
    });

    test('event / id / retry fields are captured; retry must be an integer', async () => {
        expect(
            await parse(['event: ping\nid: 7\nretry: 1500\ndata: hi\n\n']),
        ).toEqual([{ event: 'ping', id: '7', retry: 1500, data: 'hi' }]);
        // a non-integer retry is ignored
        expect(await parse(['retry: soon\ndata: x\n\n'])).toEqual([
            { data: 'x' },
        ]);
    });

    test('comments (":"-prefixed) are ignored; exactly one leading space is stripped', async () => {
        expect(await parse([': keep-alive\ndata:  x\n\n'])).toEqual([
            { data: ' x' }, // two spaces after colon, one stripped → leading space kept
        ]);
    });

    test('CRLF line endings are handled', async () => {
        expect(await parse(['data: a\r\n\r\n'])).toEqual([{ data: 'a' }]);
    });

    test('a block with no data: line dispatches nothing', async () => {
        // an id-only block sets no data → not dispatched (SSE spec); only the real event yields
        expect(await parse(['id: 1\n\ndata: y\n\n'])).toEqual([{ data: 'y' }]);
    });

    test('an incomplete trailing event (no terminating blank line) is discarded', async () => {
        expect(await parse(['data: full\n\ndata: partial'])).toEqual([
            { data: 'full' },
        ]);
    });

    test('events split across chunk boundaries still parse', async () => {
        expect(
            await parse(['da', 'ta: spl', 'it\n', '\ndata: two', '\n\n']),
        ).toEqual([{ data: 'split' }, { data: 'two' }]);
    });

    test('a field with no value (no colon) is read with an empty value', async () => {
        // `data` alone → one empty data line → data buffer "" → dispatched with empty data
        expect(await parse(['data\n\n'])).toEqual([{ data: '' }]);
    });
});

describe('sse buffer cap — an unbounded body fails instead of OOM-ing (security)', () => {
    // Parity with the `'json'` decoder's per-value cap (json-stream.ts): a malformed / never-closing
    // body is bounded and throws a descriptive Error rather than growing client memory without limit.
    // The engine (runStreaming) turns the throw into an error+done event, so the stream fails cleanly.
    const CAP = 64; // a tiny cap so the test stays fast; the real default is ~8 MB

    test('a long run with NO newline past the cap throws (line-reader guard)', async () => {
        // One chunk of bytes with no `\n` at all — lineReader can never split it, so the un-terminated
        // carry grows past the cap. Without the cap this would buffer the whole (unbounded) body.
        const noNewline = 'data: ' + 'x'.repeat(CAP * 4); // no trailing "\n\n"
        await expect(
            parse([noNewline], { stream: { buffer: { chars: CAP } } }),
        ).rejects.toThrow(
            /un-terminated line exceeded the stream\.buffer\.chars cap/,
        );
    });

    test('endless data: lines with NO dispatching blank line past the cap throws (frame guard)', async () => {
        // Every line IS newline-terminated (so the line-reader guard never trips), but the frame is
        // never dispatched (no blank line), so `frame.dataLines` accumulates without bound. The
        // per-frame guard catches this case the line guard cannot.
        const manyDataLines =
            Array.from({ length: 200 }, () => 'data: chunk').join('\n') + '\n'; // no blank line ⇒ never dispatched
        await expect(
            parse([manyDataLines], { stream: { buffer: { chars: CAP } } }),
        ).rejects.toThrow(
            /un-dispatched event data exceeded the stream\.buffer\.chars cap/,
        );
    });

    test('a normal stream UNDER the cap still parses (no false positive)', async () => {
        // Well under 64 bytes of data per frame, each properly blank-line terminated.
        expect(
            await parse(['data: {"n":1}\n\ndata: {"n":2}\n\n'], {
                stream: { buffer: { chars: CAP } },
            }),
        ).toEqual([{ data: { n: 1 } }, { data: { n: 2 } }]);
    });

    test('a frame at the cap boundary across many small lines is bounded', async () => {
        // Sanity: the frame guard sums data-line bytes (+1 per join), so several small un-dispatched
        // `data:` lines that together exceed the cap still throw — the attack is many lines, not one.
        const lines = Array.from(
            { length: 30 },
            () => 'data: ' + 'y'.repeat(8),
        );
        await expect(
            parse([lines.join('\n') + '\n'], {
                stream: { buffer: { chars: CAP } },
            }),
        ).rejects.toThrow(
            /un-dispatched event data exceeded the stream\.buffer\.chars cap/,
        );
    });
});

describe('sse over the engine (event spine + await)', () => {
    test('emits start → request → delta-per-event → result (collected) → done', async () => {
        const s = sse({
            url: 'https://x.test/e',
            adapter: streamAdapter(
                streamOf(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']),
            ),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.types).toEqual([
            'start',
            'progress',
            'delta',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        expect(ev.deltas).toEqual([{ data: 1 }, { data: 2 }, { data: 3 }]);
        expect(ev.result).toEqual([{ data: 1 }, { data: 2 }, { data: 3 }]);
    });

    test('await resolves to the collected array of events', async () => {
        const s = sse({
            url: 'https://x.test/e',
            adapter: streamAdapter(streamOf(['data: a\n\n', 'data: b\n\n'])),
        });
        expect(await s()).toEqual([{ data: 'a' }, { data: 'b' }]);
    });

    test('an empty stream resolves to [] with no delta events', async () => {
        const s = sse({
            url: 'https://x.test/empty',
            adapter: streamAdapter(streamOf([])),
        });
        const ev = await collectEvents(s.stream());
        expect(ev.types).toEqual(['start', 'progress', 'result', 'done']);
        expect(ev.deltas).toEqual([]);
        expect(ev.result).toEqual([]);
        expect(ev.done?.ok).toBe(true);
    });

    test('a >=400 status fails the open before any delta', async () => {
        const s = sse({
            url: 'https://x.test/err',
            adapter: streamAdapter(streamOf(['data: nope\n\n']), {
                status: 500,
            }),
        });
        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([]);
        expect(ev.error?.status).toBe(500);
        expect(ev.done?.ok).toBe(false);
    });

    test('a mid-stream error ends with error+done, keeping the deltas seen so far', async () => {
        const s = sse({
            url: 'https://x.test/broken',
            adapter: streamAdapter(
                streamThenError(['data: 1\n\n', 'data: 2\n\n']),
            ),
        });
        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([{ data: 1 }, { data: 2 }]);
        expect(ev.types).toContain('error');
        expect(ev.done?.ok).toBe(false);
    });

    test('an unbounded body past the buffer.chars cap fails the stream with error+done (not OOM)', async () => {
        // A body that streams a long run with no newline / no dispatching blank line. The parser's
        // buffer cap throws; runStreaming turns the throw into error+done — a clean failure, not an
        // unbounded-memory grow. (This is the engine-spine counterpart to the frame-parser unit tests.)
        const s = sse({
            url: 'https://x.test/flood',
            stream: { buffer: { chars: 64 } },
            adapter: streamAdapter(streamOf(['data: ' + 'x'.repeat(4096)])), // no "\n\n" terminator
        });
        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([]); // nothing was ever dispatched
        expect(ev.types).toContain('error');
        expect(ev.error?.message).toMatch(/stream\.buffer\.chars/);
        expect(ev.done?.ok).toBe(false);
    });
});

describe('aborting mid-stream stops delivery deterministically (no transport race)', () => {
    // The old version of this test drove a REAL server with a 40ms `chunkDelay` and depended on
    // the abort reaching the transport before the next chunk decoded — flaky under load, since that
    // race could resolve either way. `streamOf` below never reads `req.signal` at all (neither it
    // nor `streamAdapter` are abort-aware), so every chunk is ready the instant it is pulled: the
    // second chunk is UNCONDITIONALLY already "decoded" by the time the consumer aborts and the
    // loop asks for it, on every single run. That reproduces the exact race deterministically and
    // proves the assertions hold only because of `runStreaming`'s own abort guard — never because a
    // transport happened to notice the signal (this one never does).
    test('a chunk already decoded before the caller aborts is still not delivered', async () => {
        const events = sse({
            url: 'https://x.test/abortable',
            adapter: streamAdapter(
                streamOf([
                    'data: {"n":1}\n\n',
                    'data: {"n":2}\n\n',
                    'data: {"n":3}\n\n',
                ]),
            ),
        });
        const ctl = new AbortController();
        const deltas: unknown[] = [];
        let sawError = false;
        let doneOk: boolean | undefined;
        for await (const e of events.stream({ signal: ctl.signal })) {
            if (e.type === 'delta') {
                deltas.push(e.chunk);
                ctl.abort(); // stop after the first event — chunks 2 and 3 are already sitting in
                // `streamOf`, ready to hand over the instant the next `pull()` asks for them
            } else if (e.type === 'error') sawError = true;
            else if (e.type === 'done') doneOk = e.ok;
        }
        expect(deltas).toEqual([{ data: { n: 1 } }]);
        expect(sawError).toBe(true);
        expect(doneOk).toBe(false);
    });

    test('a chunk whose validation aborts is neither collected nor delivered', async () => {
        // The loop-ENTRY guard cannot catch this one. With an `output` contract set, validation is
        // an `await` sitting between that guard and the `chunks.push` + `delta` yield, so an abort
        // landing during it would still see the chunk collected and delivered — the same defect
        // displaced by one await, and reachable by any streaming stitch with an output schema.
        // Aborting from inside `validate` puts the abort in exactly that window on every run, with
        // no timing dependence. Found in review of the loop-entry guard, which claimed to cover
        // "every other effect below" and did not.
        const ctl = new AbortController();
        const events = sse({
            url: 'https://x.test/abort-during-validate',
            adapter: streamAdapter(
                streamOf(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']),
            ),
            output: asValidator({
                validate: (value: unknown) => {
                    ctl.abort();
                    return Promise.resolve({ ok: true as const, value });
                },
            }),
        });
        const deltas: unknown[] = [];
        let sawError = false;
        let doneOk: boolean | undefined;
        for await (const e of events.stream({ signal: ctl.signal })) {
            if (e.type === 'delta') deltas.push(e.chunk);
            else if (e.type === 'error') sawError = true;
            else if (e.type === 'done') doneOk = e.ok;
        }
        // NOT `[{ data: { n: 1 } }]`: the abort landed before this chunk was ever handed over, so
        // the caller sees none of it — and the awaited result, fed by the same `chunks`, agrees.
        expect(deltas).toEqual([]);
        expect(sawError).toBe(true);
        expect(doneOk).toBe(false);
    });

    test('an aborted resumable stream (sse.reconnect) never tries to reconnect', async () => {
        // Every event carries an `id:`, so `resumeToken` sees one on the very first delta —
        // `recoverable` is true the moment the stream drops, exactly the shape that would otherwise
        // reconnect. Proves the reconnect predicate's abort check wins over "recoverable, attempts
        // left": the caller cancelled, so no `progress: reconnect` is ever emitted and the body is
        // never reopened.
        let opens = 0;
        const events = sse({
            url: 'https://x.test/abortable-resumable',
            sse: { reconnect: { attempts: 3, delay: 1 } },
            adapter: (req) => {
                opens++;
                if (!req.stream) throw new Error('expected stream');
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: streamOf([
                        'id: 1\ndata: {"n":1}\n\n',
                        'id: 2\ndata: {"n":2}\n\n',
                        'id: 3\ndata: {"n":3}\n\n',
                    ]),
                });
            },
        });
        const ctl = new AbortController();
        const deltas: unknown[] = [];
        const reconnects: unknown[] = [];
        let sawError = false;
        let doneOk: boolean | undefined;
        for await (const e of events.stream({ signal: ctl.signal })) {
            if (e.type === 'delta') {
                deltas.push(e.chunk);
                ctl.abort(); // stop after the first event
            } else if (e.type === 'progress' && e.phase === 'reconnect') {
                reconnects.push(e);
            } else if (e.type === 'error') sawError = true;
            else if (e.type === 'done') doneOk = e.ok;
        }
        expect(deltas).toEqual([{ id: '1', data: { n: 1 } }]);
        expect(reconnects).toEqual([]); // never even attempted
        expect(sawError).toBe(true);
        expect(doneOk).toBe(false);
        expect(opens).toBe(1); // the body was never reopened
    });
});

describe('sse keeps auth + lifecycle hooks (streaming is not a bypass of the spine)', () => {
    test('auth.apply runs and onRequest/onResponse fire on a streaming open', async () => {
        const seen: string[] = [];
        const s = sse({
            url: 'https://x.test/secure',
            auth: {
                apply: (req) => {
                    req.headers['authorization'] = 'Bearer t';
                },
            },
            hooks: {
                onRequest: ({ req }) => {
                    seen.push(`req:${req?.headers['authorization'] ?? ''}`);
                },
                onResponse: () => {
                    seen.push('res');
                },
            },
            adapter: (req) => {
                if (!req.stream) throw new Error('expected stream');
                seen.push(`adapter:${req.headers['authorization'] ?? ''}`);
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: streamOf(['data: ok\n\n']),
                });
            },
        });
        expect(await s()).toEqual([{ data: 'ok' }]);
        // auth.apply → onRequest → adapter → onResponse, with the auth header threaded throughout.
        expect(seen).toEqual(['req:Bearer t', 'adapter:Bearer t', 'res']);
    });
});

describe('sse per-`delta` validation targets the event `data` (ADR 0005 Addendum)', () => {
    test('`output` validates `.data`, not the envelope; the full event is still delivered', async () => {
        // The schema matches the PAYLOAD. It would FAIL against the whole SseEvent
        // (`{ data: {...} }` has no top-level `tok`), so passing proves `contractValue` narrowed
        // validation to `.data` while the delta still carries the full event.
        const s = sse({
            url: 'https://x.test/v',
            output: asValidator(z.object({ tok: z.string() })),
            adapter: streamAdapter(
                streamOf(['data: {"tok":"hi"}\n\n', 'data: {"tok":"yo"}\n\n']),
            ),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([
            { data: { tok: 'hi' } },
            { data: { tok: 'yo' } },
        ]);
        expect(ev.result).toEqual([
            { data: { tok: 'hi' } },
            { data: { tok: 'yo' } },
        ]);
        expect(ev.drifts).toEqual([]);
        expect(ev.done?.ok).toBe(true);
    });

    test('a bad `.data` payload fails the stream (the offending event is not delivered)', async () => {
        const s = sse({
            url: 'https://x.test/v',
            output: asValidator(z.object({ tok: z.string() })),
            adapter: streamAdapter(
                streamOf(['data: {"tok":"hi"}\n\n', 'data: {"nope":1}\n\n']),
            ),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([{ data: { tok: 'hi' } }]);
        expect(ev.drifts[0]?.level).toBe('error');
        expect(ev.done?.ok).toBe(false);
    });
});

describe('sse over real fetch + Web Streams (browser-first gate)', () => {
    let server: MockServer;
    beforeAll(async () => {
        server = await startMockServer();
    });
    afterAll(async () => {
        await server.close();
    });
    beforeEach(() => {
        server.reset();
    });

    test('parses an event-stream served over HTTP (no EventSource)', async () => {
        const wire = 'event: tick\ndata: {"n":1}\n\ndata: {"n":2}\n\n';
        server.route('GET', '/events', {
            body: Buffer.from(wire),
            headers: { 'content-type': 'text/event-stream' },
        });

        const events = sse({ baseUrl: server.url, path: '/events' });
        expect(await events()).toEqual([
            { event: 'tick', data: { n: 1 } },
            { data: { n: 2 } },
        ]);
        expect(server.calls('/events')[0]?.method).toBe('GET');
    });

    test('decodes a real chunked event-stream (a pause between frames)', async () => {
        server.route('GET', '/ticks', {
            headers: { 'content-type': 'text/event-stream' },
            stream: {
                chunks: [
                    'data: {"n":1}\n\n',
                    'data: {"n":2}\n\n',
                    'data: {"n":3}\n\n',
                ],
                chunkDelay: 15,
            },
        });
        const events = sse({ baseUrl: server.url, path: '/ticks' });
        const ev = await collectEvents(events.stream());
        expect(ev.deltas).toEqual([
            { data: { n: 1 } },
            { data: { n: 2 } },
            { data: { n: 3 } },
        ]);
        expect(ev.result).toEqual(ev.deltas);
        expect(ev.done?.ok).toBe(true);
    });

    test('breaking out of .stream() early cancels the underlying body (no leak)', async () => {
        // Early break `.return()`s the generator chain down to lineReader, whose `finally` now
        // `cancel()`s the underlying stream before releasing the lock — so an abandoned consumer
        // proactively closes the connection instead of leaking it until GC (previously a tracked
        // follow-up: only releaseLock() ran, never cancel()). A cancel-recording stream (fed through
        // streamAdapter) makes the client-side cancel observable, which a real HTTP body can't.
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(
                    new TextEncoder().encode('data: {"n":1}\n\n'),
                );
            },
            cancel() {
                cancelled = true;
            },
        });
        const events = sse({
            url: 'https://x.test/breakable',
            adapter: streamAdapter(body),
        });
        const deltas: unknown[] = [];
        for await (const e of events.stream()) {
            if (e.type === 'delta') {
                deltas.push(e.chunk);
                break; // abandon the rest of the stream
            }
        }
        expect(deltas).toEqual([{ data: { n: 1 } }]);
        expect(cancelled).toBe(true); // the body was cancelled, not just abandoned
    });
});

describe('lineReader teardown + cap (shared streaming plumbing)', () => {
    // lineReader is the byte→line plumbing shared by `sse` and `stream`'s `'lines'`/`'ndjson'`. The
    // two hardenings are proven here at the plumbing level too, independent of the sse frame layer.

    test('an early break cancels the underlying stream before releasing the lock', async () => {
        // A consumer that reads one line then `break`s triggers the generator `.return()`; the
        // `finally` must cancel() the body (proactively closing the connection), not just releaseLock().
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('line\n'));
            },
            cancel() {
                cancelled = true;
            },
        });
        const lines: string[] = [];
        for await (const line of lineReader(stream)) {
            lines.push(line);
            break; // abandon after the first line
        }
        expect(lines).toEqual(['line']);
        expect(cancelled).toBe(true);
    });

    test('a normal drain still cancels (a no-op on a closed stream) and yields all lines', async () => {
        // Cancelling unconditionally in `finally` is safe: cancel() on an already-closed stream is a
        // spec no-op, so a fully-consumed stream still delivers every line.
        const lines: string[] = [];
        for await (const line of lineReader(streamOf(['a\nb\n', 'c']))) {
            lines.push(line);
        }
        expect(lines).toEqual(['a', 'b', 'c']);
    });

    test('a single un-terminated line past the buffer.chars cap throws a descriptive error', async () => {
        // No `\n` ever arrives, so the carry grows unbounded — the cap turns that into a clean throw.
        await expect(async () => {
            for await (const _ of lineReader(streamOf(['x'.repeat(200)]), 64)) {
                void _;
            }
        }).rejects.toThrow(
            /un-terminated line exceeded the stream\.buffer\.chars cap/,
        );
    });
});

describe('sse authoring helpers (Decision 3)', () => {
    test('sse.surface is the sse Surface; sse.stitch aliases the callable', () => {
        expect(sse.surface).toBe(sseSurface);
        const a = sse({ url: 'https://x.test/e' });
        const b = sse.stitch({ url: 'https://x.test/e' });
        expect(a.__config.kind).toBe(b.__config.kind);
    });

    test('sse.bind(existingSeam).stitch(...) creates an sse member of that seam', async () => {
        const api = seam({ baseUrl: 'https://x.test' });
        const events = sse.bind(api).stitch({
            path: '/e',
            adapter: streamAdapter(streamOf(['data: ok\n\n'])),
        });
        expect(await events()).toEqual([{ data: 'ok' }]);
    });

    test('a generic stitch({ kind: sseSurface }) streams the same way', async () => {
        const s = stitch({
            kind: sseSurface,
            url: 'https://x.test/e',
            adapter: streamAdapter(streamOf(['data: via-kind\n\n'])),
        });
        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual([{ data: 'via-kind' }]);
    });
});
