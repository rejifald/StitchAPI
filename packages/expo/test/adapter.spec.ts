// expoFetchAdapter is core's fetchAdapter pointed at a streaming fetch. Drive it
// with a fake WHATWG fetch to prove both the streaming branch (response.body is
// handed back as a ReadableStream) and the unary branch (JSON is parsed) wire up.
import { expoFetchAdapter } from '../src/adapter';

import { describe, expect, test } from 'vitest';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(c) {
            const chunk = chunks[i++];
            if (chunk === undefined) c.close();
            else c.enqueue(enc.encode(chunk));
        },
    });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}

const fetchReturning =
    (make: () => Response): typeof fetch =>
    async () =>
        make();

describe('expoFetchAdapter', () => {
    test('hands back the live ReadableStream body for a streaming request', async () => {
        const adapter = expoFetchAdapter({
            fetch: fetchReturning(
                () =>
                    new Response(streamOf(['data: a\n\n', 'data: b\n\n']), {
                        headers: { 'content-type': 'text/event-stream' },
                    }),
            ),
        });

        const res = await adapter({
            url: 'https://api.test/events',
            method: 'GET',
            headers: {},
            stream: true,
        });

        expect(res.body).toBeInstanceOf(ReadableStream);
        expect(await drain(res.body as ReadableStream<Uint8Array>)).toBe(
            'data: a\n\ndata: b\n\n',
        );
    });

    test('parses a unary JSON response', async () => {
        const adapter = expoFetchAdapter({
            fetch: fetchReturning(
                () =>
                    new Response(JSON.stringify({ ok: true }), {
                        headers: { 'content-type': 'application/json' },
                    }),
            ),
        });

        const res = await adapter({
            url: 'https://api.test/u',
            method: 'GET',
            headers: {},
        });

        expect(res.body).toEqual({ ok: true });
    });
});
