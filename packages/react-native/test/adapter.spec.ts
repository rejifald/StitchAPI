// rnStreamAdapter: streaming requests read XMLHttpRequest.responseText incrementally
// and surface it as a ReadableStream<Uint8Array> (the same shape fetchAdapter hands
// back, which core's sse/stream decoders consume); unary requests delegate.
import { rnStreamAdapter } from '../src/adapter';
import type { RnStreamingXhr, RnStreamingXhrCtor } from '../src/adapter';

import type { Adapter, AdapterRequest } from 'stitchapi';
import { describe, expect, test } from 'vitest';

// A fake XMLHttpRequest the test drives by hand: emit headers, push response-text
// slices, then complete — mirroring how RN populates `responseText` as bytes land.
class FakeStreamingXhr implements RnStreamingXhr {
    responseType = '';
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    sentBody: string | null = null;
    aborted = false;
    private resHeaders = 'content-type: text/event-stream\r\n';

    open(): void {
        this.readyState = 1;
    }
    setRequestHeader(): void {}
    getAllResponseHeaders(): string {
        return this.resHeaders;
    }
    send(body?: string | null): void {
        this.sentBody = body ?? null;
    }
    abort(): void {
        this.aborted = true;
        this.onabort?.();
    }

    // --- test drivers ---
    emitHeaders(status = 200, headers?: string): void {
        this.status = status;
        if (headers !== undefined) this.resHeaders = headers;
        this.readyState = 2;
        this.onreadystatechange?.();
    }
    push(chunk: string): void {
        this.responseText += chunk;
        this.readyState = 3;
        this.onprogress?.();
        this.onreadystatechange?.();
    }
    complete(): void {
        this.readyState = 4;
        this.onload?.();
    }
}

// A constructor that hands back a preexisting instance, so the test keeps a handle
// on the XHR `rnStreamAdapter` creates internally.
function ctorReturning(instance: RnStreamingXhr): RnStreamingXhrCtor {
    return function FakeCtor(this: unknown) {
        return instance;
    } as unknown as RnStreamingXhrCtor;
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
    out += decoder.decode();
    return out;
}

const streamReq = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    url: 'https://api.test/events',
    method: 'GET',
    headers: {},
    stream: true,
    ...over,
});

describe('rnStreamAdapter — streaming branch', () => {
    test('surfaces incremental responseText as an ordered ReadableStream', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });

        const resP = adapter(streamReq());
        xhr.emitHeaders();
        const res = await resP;

        expect(res.body).toBeInstanceOf(ReadableStream);
        xhr.push('data: a\n\n');
        xhr.push('data: b\n\n');
        xhr.complete();

        expect(await drain(res.body as ReadableStream<Uint8Array>)).toBe(
            'data: a\n\ndata: b\n\n',
        );
    });

    test('resolves the response at HEADERS_RECEIVED, before the body completes', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });

        const resP = adapter(streamReq());
        xhr.emitHeaders(
            201,
            'x-trace: 7\r\ncontent-type: text/event-stream\r\n',
        );
        const res = await resP; // resolved though no body bytes have arrived yet

        expect(res.status).toBe(201);
        expect(res.headers['x-trace']).toBe('7');
        expect(res.url).toBe('https://api.test/events');

        xhr.push('data: late\n\n');
        xhr.complete();
        expect(await drain(res.body as ReadableStream<Uint8Array>)).toBe(
            'data: late\n\n',
        );
    });

    test('reassembles a frame split across chunk boundaries', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });
        const resP = adapter(streamReq());
        xhr.emitHeaders();
        const res = await resP;

        xhr.push('data: hel');
        xhr.push('lo\n\n');
        xhr.complete();
        expect(await drain(res.body as ReadableStream<Uint8Array>)).toBe(
            'data: hello\n\n',
        );
    });

    test('does not split a surrogate pair across chunks', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });
        const resP = adapter(streamReq());
        xhr.emitHeaders();
        const res = await resP;

        // '😀' is 😀 — push the halves in separate chunks.
        xhr.push('x\uD83D');
        xhr.push('\uDE00y');
        xhr.complete();
        expect(await drain(res.body as ReadableStream<Uint8Array>)).toBe(
            'x😀y',
        );
    });

    test('JSON-encodes a non-string POST body for a streaming request', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });
        const resP = adapter(
            streamReq({ method: 'POST', body: { prompt: 'hi' } }),
        );
        xhr.emitHeaders();
        await resP;
        xhr.complete();
        expect(xhr.sentBody).toBe('{"prompt":"hi"}');
    });

    test('rejects when the request is already aborted', async () => {
        const xhr = new FakeStreamingXhr();
        const adapter = rnStreamAdapter({ XHR: ctorReturning(xhr) });
        const ac = new AbortController();
        ac.abort();
        await expect(adapter(streamReq({ signal: ac.signal }))).rejects.toThrow(
            /abort/i,
        );
    });
});

describe('rnStreamAdapter — unary branch', () => {
    test('delegates non-streaming requests to the unary adapter', async () => {
        const seen: AdapterRequest[] = [];
        const unary: Adapter = async (req) => {
            seen.push(req);
            return { status: 200, headers: {}, body: { ok: true } };
        };
        const adapter = rnStreamAdapter({ unary });

        const res = await adapter({
            url: 'https://api.test/u',
            method: 'GET',
            headers: {},
        });

        expect(res.body).toEqual({ ok: true });
        expect(seen).toHaveLength(1);
    });
});
