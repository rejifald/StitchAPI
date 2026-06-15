// The `sse` surface (ADR 0005 Decision 4): Server-Sent Events over fetch + Web Streams (never
// EventSource). The stream hook parses the text/event-stream wire format off the ReadableStream
// and yields one parsed event per `delta` chunk. Most cases drive the frame parser directly over a
// fake stream (precise chunk boundaries); the engine spine + a real-fetch case round it out.
import { seam, stitch } from '../src';
import { sse, sseSurface } from '../src/sse';
import type { SseEvent } from '../src/sse';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { collectEvents, streamAdapter, streamOf } from './support/streams';

// Run the SSE frame parser over the given chunk boundaries and collect the parsed events.
async function parse(chunks: string[]): Promise<SseEvent[]> {
    const res = { status: 200, headers: {}, body: streamOf(chunks) };
    const out: SseEvent[] = [];
    // `stream` is defined on a streaming surface; tests may assert non-null.
    for await (const ev of sseSurface.stream!(res, {}))
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
});

describe('sse authoring helpers (Decision 3)', () => {
    test('sse.surface is the sse Surface; sse.stitch aliases the callable', () => {
        expect(sse.surface).toBe(sseSurface);
        const a = sse({ url: 'https://x.test/e' });
        const b = sse.stitch({ url: 'https://x.test/e' });
        expect(a.__config.kind).toBe(b.__config.kind);
    });

    test('sse.seam(existingSeam).stitch(...) creates an sse member of that seam', async () => {
        const api = seam({ baseUrl: 'https://x.test' });
        const events = sse.seam(api).stitch({
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
