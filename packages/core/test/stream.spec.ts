// The `stream` surface (ADR 0005 Decision 5): raw response streaming with a configurable
// decoder (`bytes` default / `lines` / `ndjson`), emitting one `delta` chunk per decoded item.
// Plus Decision 12: a streaming member is exempt from the seam concurrency bucket but still
// charges the rate gate at open. Streams are driven by a fake adapter over Web Streams, so chunk
// boundaries are fully controlled (no socket).
import { createThrottle } from '../src/resilience';
import { chainThrottle, createStoreThrottle, memoryStore } from '../src/store';
import { stream, streamSurface } from '../src/stream';
import { now } from '../src/util';
import {
    collectEvents,
    gatedStream,
    streamAdapter,
    streamOf,
} from './support/streams';

const td = new TextDecoder();

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
});

describe('stream decoders (Decision 5)', () => {
    test('default decode is "bytes": delta chunks are Uint8Array, await collects them', async () => {
        const s = stream({
            url: 'https://x.test/b',
            adapter: streamAdapter(streamOf(['ab', 'cd'])),
        });

        const chunks = await s();
        expect(chunks.every((c) => c instanceof Uint8Array)).toBe(true);
        const joined = chunks.map((c) => td.decode(c as Uint8Array)).join('');
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
        expect(r.waitedMs).toBe(0);
    });

    test('createStoreThrottle: rateOnly skips concurrency but DOES charge the rate window', async () => {
        const store = memoryStore();
        const t = createStoreThrottle({ concurrency: 1, rate: '100/s' }, store);
        await t.acquire('svc', { rateOnly: true });
        await t.acquire('svc', { rateOnly: true });
        // The fixed-window counter records BOTH opens (Decision 12: charge the rate gate at open).
        const windowStart = Math.floor(now() / 1000) * 1000;
        expect(await store.get(`rl:svc:${windowStart}`)).toBe(2);
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
        expect(r.waitedMs).toBe(0);
    });
});
