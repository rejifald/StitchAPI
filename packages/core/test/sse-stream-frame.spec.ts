// SSE framing (frameSse via sseStream) + streamAdapter guard in src/test-stream.ts. testing-kit.spec
// frames two object events; the other branches of the framer go untested:
//   - the bare-string shorthand → `data: <s>\n\n`;
//   - the full line ordering: comment → event → id → retry → data;
//   - a multi-line string `data` splits into one `data:` line per line;
//   - a non-string `data` is JSON-encoded onto a single `data:` line;
//   - streamAdapter requires req.stream (rejects otherwise) and returns the body when set.
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
