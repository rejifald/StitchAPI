// The `stream` surface (ADR 0005 Decision 5): raw response streaming with a configurable
// decoder (`bytes` default / `lines` / `ndjson` / `json`), emitting one `delta` chunk per decoded
// item. The structural `json` tokenizer itself is unit-tested in json-stream.spec.ts.
// Plus Decision 12: a streaming member is exempt from the seam concurrency bucket but still
// charges the rate gate at open. Streams are driven by a fake adapter over Web Streams, so chunk
// boundaries are fully controlled (no socket).
import { createThrottle } from '../src/resilience';
import { seam } from '../src/seam';
import { chainThrottle, createStoreThrottle, memoryStore } from '../src/store';
import { stream, streamSurface } from '../src/stream';
import { now } from '../src/util';
import { asValidator } from './support/schema';
import {
    collectEvents,
    gatedStream,
    streamAdapter,
    streamOf,
    streamThenError,
} from './support/streams';

import { z } from 'zod';

const td = new TextDecoder();
const enc = new TextEncoder();

describe('stream surface identity (Decisions 5, 11)', () => {
    test('streamSurface has the stable id "stream" and a stream hook', () => {
        expect(streamSurface.id).toBe('stream');
        expect(typeof streamSurface.stream).toBe('function');
    });

    test('kind round-trips through __config as the id string "stream"', () => {
        const s = stream({ url: 'https://x.test/s' });
        const json = JSON.parse(JSON.stringify(s.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('stream');
    });

    // The binder is implemented loose and `as`-cast to `StreamSeamApi['stitch']` (the `download.ts`
    // idiom), so its declared member type cannot vouch for the runtime wiring — the cast is exactly
    // what the compiler stops checking. This pins that a bound member still resolves through the
    // seam's baseUrl and streams, which is the sse binder's counterpart test.
    test('stream.bind(existingSeam).stitch(...) creates a stream member of that seam', async () => {
        const api = seam({ baseUrl: 'https://x.test' });
        const chunks = stream.bind(api).stitch({
            path: '/s',
            stream: 'lines',
            adapter: streamAdapter(streamOf(['a\nb\n'])),
        });
        expect(await chunks()).toEqual(['a', 'b']);
    });
});

describe('stream decoders (Decision 5)', () => {
    test('default decode is "bytes": delta chunks are Uint8Array, await collects them', async () => {
        const s = stream({
            url: 'https://x.test/b',
            adapter: streamAdapter(streamOf(['ab', 'cd'])),
        });

        const chunks = await s();
        expect(chunks.every((c) => c instanceof Uint8Array)).toBe(true);
        const joined = chunks.map((c) => td.decode(c)).join('');
        expect(joined).toBe('abcd');
    });

    test('decode "lines": UTF-8 split on \\n, one string per line, across chunk boundaries', async () => {
        const s = stream({
            url: 'https://x.test/l',
            stream: { decode: 'lines' },
            // a line ("hello") is split across two chunks; the last line has no trailing \n
            adapter: streamAdapter(streamOf(['he', 'llo\nwor', 'ld'])),
        });

        expect(await s()).toEqual(['hello', 'world']);
    });

    test('decode "ndjson": each non-blank line is JSON.parsed', async () => {
        const s = stream({
            url: 'https://x.test/n',
            stream: { decode: 'ndjson' },
            adapter: streamAdapter(
                streamOf(['{"a":1}\n', '\n', '{"b":', '2}\n']),
            ),
        });

        expect(await s()).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test('decode "json": a top-level array emits one delta per element', async () => {
        const s = stream({
            url: 'https://x.test/j',
            stream: { decode: 'json' },
            // the array body is split across chunks, including mid-element
            adapter: streamAdapter(streamOf(['[{"a":1},{"a', '":2},{"a":3}]'])),
        });

        expect(await s()).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    });

    test('decode "json": concatenated values + pretty-printed records (ndjson would break)', async () => {
        const s = stream({
            url: 'https://x.test/j',
            stream: { decode: 'json' },
            // pretty-printed objects with INTERNAL newlines, concatenated with no separator —
            // the exact shape ndjson's \n-split mangles. Chunked at awkward offsets.
            adapter: streamAdapter(
                streamOf(['{\n  "a": 1\n}{\n  "b', '": [1,\n2]\n}']),
            ),
        });

        expect(await s()).toEqual([{ a: 1 }, { b: [1, 2] }]);
    });

    test('decode "json": a }/]/" inside a string is not structure (one delta)', async () => {
        const s = stream({
            url: 'https://x.test/j',
            stream: { decode: 'json' },
            adapter: streamAdapter(streamOf(['{"s":"a}b]c\\"d"}'])),
        });

        expect(await s()).toEqual([{ s: 'a}b]c"d' }]);
    });
});

describe('abandoned-stream teardown (issue #686 §2)', () => {
    // `break`ing out of a `.stream()` loop `.return()`s the generator chain down to the decoder,
    // whose `finally` must cancel() the body — releasing the lock alone leaves the response stream
    // open, so the vendor keeps writing (and billing) into a connection nobody reads. `lines`/
    // `ndjson` already got this from lineReader; these pin the other two decoders to the same
    // behaviour. A cancel-recording endless body makes the client-side cancel observable, which a
    // real HTTP body can't, and it is only ever torn down by the consumer.
    function endlessBody(chunk: string): {
        body: ReadableStream<Uint8Array>;
        cancelled: () => boolean;
    } {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(enc.encode(chunk));
            },
            cancel() {
                cancelled = true;
            },
        });
        return { body, cancelled: () => cancelled };
    }

    test('the default "bytes" decoder cancels the body on an early break', async () => {
        const { body, cancelled } = endlessBody('chunk');
        const s = stream({
            url: 'https://x.test/breakable-bytes',
            adapter: streamAdapter(body),
        });

        const deltas: unknown[] = [];
        for await (const e of s.stream()) {
            if (e.type === 'delta') {
                deltas.push(e.chunk);
                break; // abandon the rest of the stream
            }
        }
        expect(deltas.map((c) => td.decode(c as Uint8Array))).toEqual([
            'chunk',
        ]);
        expect(cancelled()).toBe(true); // cancelled, not merely unlocked
    });

    test('decode "json" cancels the body on an early break', async () => {
        // Concatenated top-level objects with no separator → one delta each, so the consumer has a
        // value to break on while the body is still open.
        const { body, cancelled } = endlessBody('{"n":1}');
        const s = stream({
            url: 'https://x.test/breakable-json',
            stream: { decode: 'json' },
            adapter: streamAdapter(body),
        });

        const deltas: unknown[] = [];
        for await (const e of s.stream()) {
            if (e.type === 'delta') {
                deltas.push(e.chunk);
                break;
            }
        }
        expect(deltas).toEqual([{ n: 1 }]);
        expect(cancelled()).toBe(true);
    });

    test('a normal drain still cancels (a no-op on a closed stream) and loses no chunks', async () => {
        // Cancelling unconditionally in `finally` is safe: cancel() on an already-closed stream is a
        // spec no-op, so a fully-consumed stream still delivers everything, on both decoders.
        const bytes = stream({
            url: 'https://x.test/drained-bytes',
            adapter: streamAdapter(streamOf(['ab', 'cd'])),
        });
        expect((await bytes()).map((c) => td.decode(c)).join('')).toBe('abcd');

        const json = stream({
            url: 'https://x.test/drained-json',
            stream: { decode: 'json' },
            adapter: streamAdapter(streamOf(['[{"a":1},{"a":2}]'])),
        });
        expect(await json()).toEqual([{ a: 1 }, { a: 2 }]);
    });
});

describe('stream event spine (Decisions 5, 12)', () => {
    test('emits start → request → delta* → result → done; result is the collected array', async () => {
        const s = stream({
            url: 'https://x.test/e',
            stream: { decode: 'lines' },
            adapter: streamAdapter(streamOf(['one\n', 'two\n', 'three\n'])),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.types).toEqual([
            'start',
            'progress', // request
            'delta',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        expect(ev.deltas).toEqual(['one', 'two', 'three']);
        expect(ev.result).toEqual(['one', 'two', 'three']); // await resolves to the collection
        expect(ev.done?.ok).toBe(true);
    });

    test('the engine asks the transport for the live body (req.stream = true)', async () => {
        let sawStream: boolean | undefined;
        const s = stream({
            url: 'https://x.test/f',
            adapter: (req) => {
                sawStream = req.stream;
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: streamOf(['x']),
                });
            },
        });

        await s();
        expect(sawStream).toBe(true);
    });

    test('a >=400 status fails the call (the stream opened with an error status)', async () => {
        const s = stream({
            url: 'https://x.test/err',
            adapter: streamAdapter(streamOf(['nope']), { status: 503 }),
        });

        await expect(s()).rejects.toThrow(/503/);
    });

    test('an empty stream resolves to [] with no delta events', async () => {
        const s = stream({
            url: 'https://x.test/empty',
            stream: { decode: 'lines' },
            adapter: streamAdapter(streamOf([])),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.types).toEqual(['start', 'progress', 'result', 'done']);
        expect(ev.deltas).toEqual([]);
        expect(ev.result).toEqual([]);
        expect(ev.done?.ok).toBe(true);
    });

    test('a mid-stream error ends with error+done, keeping the deltas seen so far', async () => {
        const s = stream({
            url: 'https://x.test/broken',
            stream: { decode: 'lines' },
            adapter: streamAdapter(streamThenError(['one\n', 'two\n'])),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.deltas).toEqual(['one', 'two']);
        expect(ev.types).toContain('error');
        expect(ev.done?.ok).toBe(false);
    });

    test('decode "json": a never-closing value past the buffer.chars cap surfaces an error event', async () => {
        const s = stream({
            url: 'https://x.test/overflow',
            stream: { decode: 'json', buffer: { chars: 64 } },
            // an open object whose single string value never closes — the in-progress slice grows
            // without bound (nothing can be emitted/compacted), so the cap trips.
            adapter: streamAdapter(
                streamOf(['{"s":"', 'a'.repeat(50), 'a'.repeat(50)]),
            ),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.types).toContain('error');
        expect(ev.error?.message).toMatch(/stream\.buffer\.chars/);
        expect(ev.done?.ok).toBe(false);
    });
});

describe('per-`delta` validation against `output` (ADR 0005 Addendum)', () => {
    test('all records pass: every delta flows, no drift, result is the collection', async () => {
        const s = stream({
            url: 'https://x.test/v',
            stream: { decode: 'ndjson' },
            output: asValidator(z.object({ n: z.number() })),
            adapter: streamAdapter(streamOf(['{"n":1}\n', '{"n":2}\n'])),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.types).toEqual([
            'start',
            'progress',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        expect(ev.deltas).toEqual([{ n: 1 }, { n: 2 }]);
        expect(ev.result).toEqual([{ n: 1 }, { n: 2 }]);
        expect(ev.drifts).toEqual([]);
        expect(ev.done?.ok).toBe(true);
    });

    test('an error-level violation fails the stream before that delta is emitted', async () => {
        const s = stream({
            url: 'https://x.test/v',
            stream: { decode: 'ndjson' },
            // a bare validator (no DriftSpec) → every failure is error-level (no `watch`).
            output: asValidator(z.object({ n: z.number() })),
            adapter: streamAdapter(
                streamOf(['{"n":1}\n', '{"bad":true}\n', '{"n":3}\n']),
            ),
        });

        const ev = await collectEvents(s.stream());
        // record 1 delivered; record 2 fails → drift(error)+error+done(false); record 3 never read.
        expect(ev.deltas).toEqual([{ n: 1 }]);
        expect(ev.types).toEqual([
            'start',
            'progress',
            'delta',
            'drift',
            'error',
            'done',
        ]);
        expect(ev.drifts[0]?.level).toBe('error');
        expect(ev.error?.message).toMatch(/contract violation/);
        expect(ev.result).toBeUndefined();
        expect(ev.done?.ok).toBe(false);
    });

    test('await rejects when a record violates the contract', async () => {
        const s = stream({
            url: 'https://x.test/v',
            stream: { decode: 'ndjson' },
            output: asValidator(z.object({ n: z.number() })),
            adapter: streamAdapter(streamOf(['{"bad":1}\n'])),
        });

        await expect(s()).rejects.toThrow(/contract violation/);
    });

    test('no `output` → no validation, no drift (the delta path is untouched)', async () => {
        const s = stream({
            url: 'https://x.test/v',
            stream: { decode: 'ndjson' },
            adapter: streamAdapter(streamOf(['{"anything":1}\n'])),
        });

        const ev = await collectEvents(s.stream());
        expect(ev.drifts).toEqual([]);
        expect(ev.deltas).toEqual([{ anything: 1 }]);
        expect(ev.done?.ok).toBe(true);
    });

    test('decode "json": `output` validates each emitted value; a bad one fails the stream', async () => {
        const s = stream({
            url: 'https://x.test/vj',
            stream: { decode: 'json' },
            output: asValidator(z.object({ n: z.number() })),
            // a top-level array whose second element violates the schema
            adapter: streamAdapter(
                streamOf(['[{"n":1},{"bad":true},{"n":3}]']),
            ),
        });

        const ev = await collectEvents(s.stream());
        // element 1 delivered; element 2 fails → drift(error)+error+done(false); element 3 unseen.
        expect(ev.deltas).toEqual([{ n: 1 }]);
        expect(ev.types).toEqual([
            'start',
            'progress',
            'delta',
            'drift',
            'error',
            'done',
        ]);
        expect(ev.error?.message).toMatch(/contract violation/);
        expect(ev.done?.ok).toBe(false);
    });
});

describe('Decision 12 — streaming is concurrency-exempt but rate-charged', () => {
    test('a long-lived stream does NOT pin the concurrency slot', async () => {
        // concurrency: 1. Stream 1 opens and stays open (gated). If a streaming open held the
        // single slot for the connection's life, stream 2 could never acquire it and would hang.
        let release1!: () => void;
        const gate = new Promise<void>((r) => {
            release1 = r;
        });
        let opened1!: () => void;
        const stream1Open = new Promise<void>((r) => {
            opened1 = r;
        });

        let opens = 0;
        const s = stream({
            url: 'https://x.test/c',
            stream: { decode: 'lines' },
            throttle: { concurrency: 1 },
            adapter: (req) => {
                if (!req.stream) throw new Error('expected stream');
                const n = ++opens;
                if (n === 1) {
                    opened1();
                    return Promise.resolve({
                        status: 200,
                        headers: {},
                        body: gatedStream('hold\n', gate),
                    });
                }
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: streamOf(['second\n']),
                });
            },
        });

        // Pump stream 1 in the background; it parks reading the open (gated) body.
        const pump1 = collectEvents(s.stream());
        await stream1Open;

        // Stream 2 must fully open + complete despite the single concurrency slot.
        expect(await s()).toEqual(['second']);
        expect(opens).toBe(2);

        release1();
        const ev1 = await pump1;
        expect(ev1.result).toEqual(['hold']);
    });

    test('createThrottle: a rateOnly acquire takes NO concurrency slot (never released)', async () => {
        const t = createThrottle({ concurrency: 1 });
        // Two rate-only acquires with concurrency:1 and no release: if either took the slot the
        // second (or the normal acquire below) would block forever.
        await t.acquire('k', { rateOnly: true });
        await t.acquire('k', { rateOnly: true });
        // The slot was never consumed, so a normal acquire still proceeds immediately.
        const r = await t.acquire('k');
        expect(r.waited).toBe(0);
    });

    test('createStoreThrottle: rateOnly skips concurrency but DOES charge the rate gate', async () => {
        const store = memoryStore();
        const t = createStoreThrottle({ concurrency: 1, rate: '100/s' }, store);
        // Both opens are charged (Decision 12: the rate gate bills at open). Asserted through the
        // limiter rather than its bookkeeping: three rate-only acquires must take two full
        // spacings to get through, which is what "charged" means to a caller. The previous version
        // read the per-window counter key directly, which pinned the fallback's internal
        // representation — with a `reserve`-capable store the same charges land on the ADR 0024
        // cursor and no counter key exists at all, so it broke without the behaviour changing.
        const start = now();
        await t.acquire('svc', { rateOnly: true });
        await t.acquire('svc', { rateOnly: true });
        await t.acquire('svc', { rateOnly: true });
        // spacing is 10ms at 100/s; the first is free, so three acquires span ~20ms.
        expect(now() - start).toBeGreaterThanOrEqual(15);
    });

    test('chainThrottle forwards rateOnly to every gate (seam bucket + member)', async () => {
        const t = chainThrottle([
            createThrottle({ concurrency: 1 }),
            createThrottle({ concurrency: 1 }),
        ]);
        // Both gates are concurrency:1; a rate-only acquire must skip BOTH, so repeated
        // un-released acquires never deadlock.
        await t.acquire('k', { rateOnly: true });
        await t.acquire('k', { rateOnly: true });
        const r = await t.acquire('k', { rateOnly: true });
        expect(r.waited).toBe(0);
    });
});
