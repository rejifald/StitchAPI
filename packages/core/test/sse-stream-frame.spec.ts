// SSE framing (frameSse via sseStream) + streamAdapter guard in src/test-stream.ts. testing-kit.spec
// frames two object events; the other branches of the framer go untested:
//   - the bare-string shorthand → `data: <s>\n\n`;
//   - the full line ordering: comment → event → id → retry → data;
//   - a multi-line string `data` splits into one `data:` line per line;
//   - a non-string `data` is JSON-encoded onto a single `data:` line;
//   - streamAdapter requires req.stream (rejects otherwise) and returns the body when set.
import { sseSurface } from '../src/sse';
import type { SseEvent } from '../src/sse';
import { sseStream, streamAdapter, streamOf } from '../src/test-stream';
import type { AdapterRequest } from '../src/types';

const td = new TextDecoder();
async function toText(rs: ReadableStream<Uint8Array>): Promise<string> {
    const reader = rs.getReader();
    let text = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += td.decode(value);
    }
    return text;
}

describe('sseStream / frameSse', () => {
    test('a bare string event is shorthand for { data }', async () => {
        expect(await toText(sseStream(['hi', 'there']))).toBe(
            'data: hi\n\ndata: there\n\n',
        );
    });

    test('frames comment → event → id → retry → data in that order', async () => {
        const text = await toText(
            sseStream([
                {
                    comment: 'keep-alive',
                    event: 'tick',
                    id: '7',
                    retry: 1000,
                    data: 'payload',
                },
            ]),
        );
        expect(text).toBe(
            ': keep-alive\nevent: tick\nid: 7\nretry: 1000\ndata: payload\n\n',
        );
    });

    test('a multi-line string data becomes one data: line per line', async () => {
        expect(await toText(sseStream([{ data: 'line1\nline2' }]))).toBe(
            'data: line1\ndata: line2\n\n',
        );
    });

    test('a non-string data is JSON-encoded on a single data: line', async () => {
        expect(await toText(sseStream([{ data: { n: 2 } }]))).toBe(
            'data: {"n":2}\n\n',
        );
    });
});

describe('streamAdapter', () => {
    const req = (stream?: boolean): AdapterRequest => ({
        url: 'https://h/x',
        method: 'GET',
        headers: {},
        ...(stream ? { stream: true } : {}),
    });

    test('returns the body (and init) for a streaming request', async () => {
        const body = streamOf(['x']);
        const adapter = streamAdapter(body, {
            status: 201,
            headers: { 'content-type': 'text/event-stream' },
        });
        const res = await adapter(req(true));
        expect(res.status).toBe(201);
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.body).toBe(body);
    });

    test('rejects when req.stream is not set', async () => {
        const adapter = streamAdapter(streamOf(['x']));
        await expect(adapter(req(false))).rejects.toThrow(/req\.stream/);
    });
});

// P17: `SseFixtureEvent.retry` is a consumer-authored duration, so it takes `number | string` and
// is parsed at the single wire-write site. This one is load-bearing rather than cosmetic: the SSE
// grammar IGNORES a non-numeric `retry:` value (sse.ts `applyFieldLine`), so an unparsed `'3s'`
// would not fail loudly — it would be dropped on the wire and the reconnect delay would silently
// fall back to the client default.
describe('sseStream: retry takes a duration token (P17)', () => {
    test("a retry of '3s' is written to the wire as retry: 3000", async () => {
        expect(await toText(sseStream([{ retry: '3s', data: 'x' }]))).toBe(
            'retry: 3000\ndata: x\n\n',
        );
    });

    test('a token keeps its place in the comment → event → id → retry → data ordering', async () => {
        const text = await toText(
            sseStream([
                {
                    comment: 'keep-alive',
                    event: 'tick',
                    id: '7',
                    retry: '1.5m',
                    data: 'payload',
                },
            ]),
        );
        expect(text).toBe(
            ': keep-alive\nevent: tick\nid: 7\nretry: 90000\ndata: payload\n\n',
        );
    });

    test('a raw-ms number is unchanged, and a numeric string reads as ms', async () => {
        expect(await toText(sseStream([{ retry: 1000, data: 'a' }]))).toBe(
            'retry: 1000\ndata: a\n\n',
        );
        expect(await toText(sseStream([{ retry: '1000', data: 'a' }]))).toBe(
            'retry: 1000\ndata: a\n\n',
        );
    });

    test('an unreadable token lands on its default: no retry: line at all', async () => {
        expect(await toText(sseStream([{ retry: 'soon', data: 'x' }]))).toBe(
            'data: x\n\n',
        );
    });

    // The end-to-end half: the parser on the other side of the wire must see a number. Before the
    // widening this frame carried `retry: 3s`, which `applyFieldLine` drops — the parsed event came
    // back with no `retry` at all and nothing anywhere reported a problem.
    test("a '3s' fixture reaches the sse parser as retry: 3000", async () => {
        const out: SseEvent[] = [];
        for await (const ev of sseSurface.stream!(
            {
                status: 200,
                headers: {},
                body: sseStream([{ retry: '3s', id: 't2', data: 'hi' }]),
            },
            { kind: sseSurface },
        ))
            out.push(ev as SseEvent);
        expect(out).toEqual([{ id: 't2', retry: 3000, data: 'hi' }]);
    });
});
