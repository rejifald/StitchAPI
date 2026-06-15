// Adapter contract extension (ADR 0005 Decision 9): a streaming response body + byte-progress.
// fetchAdapter returns the live ReadableStream when `stream` is set, and reports download
// progress (then decodes as usual) when `onProgress` is set. axios stays buffered-only and
// throws on `stream`.
import { axiosAdapter, fetchAdapter } from '../src';
import type { AdapterProgress } from '../src/types';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

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

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out;
}

describe('fetchAdapter streaming (ADR 0005 Decision 9)', () => {
    test('stream:true hands back the live ReadableStream body, unparsed', async () => {
        server.route('GET', '/s', { body: { hello: 'world' } });

        const res = await fetchAdapter()({
            url: server.url + '/s',
            method: 'GET',
            headers: {},
            stream: true,
        });

        expect(res.body).toBeInstanceOf(ReadableStream);
        const bytes = await drain(res.body as ReadableStream<Uint8Array>);
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
            hello: 'world',
        });
    });

    test('onProgress reports download bytes (total from content-length); body still decodes', async () => {
        const payload = { items: Array.from({ length: 50 }, (_, i) => i) };
        const len = new TextEncoder().encode(JSON.stringify(payload)).length;
        // pin a content-length so the `total` path is exercised (the mock server is otherwise chunked)
        server.route('GET', '/d', {
            body: payload,
            headers: { 'content-length': String(len) },
        });

        const events: AdapterProgress[] = [];
        const res = await fetchAdapter()({
            url: server.url + '/d',
            method: 'GET',
            headers: {},
            onProgress: (p) => events.push(p),
        });

        // buffered path: the body is still decoded to JSON
        expect(res.body).toEqual(payload);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.phase === 'download')).toBe(true);
        const last = events[events.length - 1];
        expect(last?.loaded).toBe(len);
        expect(last?.total).toBe(len);
    });

    test('onProgress still reports loaded when content-length is absent (chunked)', async () => {
        server.route('GET', '/c', { body: { ok: true } });

        const events: AdapterProgress[] = [];
        await fetchAdapter()({
            url: server.url + '/c',
            method: 'GET',
            headers: {},
            onProgress: (p) => events.push(p),
        });

        expect(events.length).toBeGreaterThan(0);
        const last = events[events.length - 1];
        expect(last?.phase).toBe('download');
        expect(last?.loaded).toBeGreaterThan(0);
        expect(last?.total).toBeUndefined(); // omitted, never guessed
    });
});

describe('axiosAdapter rejects streaming (ADR 0005 Decision 9)', () => {
    test('throws a clear error when stream:true is requested', async () => {
        const client = {
            request: async () => ({
                status: 200,
                headers: {},
                data: new ArrayBuffer(0),
            }),
        };
        await expect(
            axiosAdapter(client)({
                url: 'http://h/x',
                method: 'GET',
                headers: {},
                stream: true,
            }),
        ).rejects.toThrow(/stream/i);
    });
});
