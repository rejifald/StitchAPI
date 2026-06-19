// rnStreamAdapter — a streaming-capable transport for React Native.
//
// StitchAPI is streaming-first, but bare RN's global `fetch` cannot stream:
// `response.body` is `undefined`, not a `ReadableStream` (facebook/react-native#27741).
// RN's `XMLHttpRequest`, however, exposes `responseText` INCREMENTALLY as bytes
// arrive — the mechanism `react-native-sse` and friends rely on. This adapter
// wraps that growing text in a real `ReadableStream<Uint8Array>`, which is exactly
// what core's `sse` / `stream` / `json-stream` decoders consume via `getReader()`.
//
// Non-streaming (unary) requests need none of this, so they delegate to core's
// `xhrAdapter` (buffered XHR with upload/download progress) — one transport that
// streams when asked and buffers otherwise.
import { assertStreamingPolyfills } from './polyfills';

import { xhrAdapter } from 'stitchapi';
import type { Adapter, AdapterRequest, AdapterResponse } from 'stitchapi';

/**
 * The minimal structural surface of `XMLHttpRequest` the streaming branch needs —
 * the real RN (and browser) global satisfies it. Distinct from core's `XhrLike`,
 * which reads a buffered `arraybuffer` `response`; here we read the incremental
 * `responseText`.
 */
export interface RnStreamingXhr {
    responseType: string;
    readonly readyState: number;
    readonly status: number;
    readonly responseText: string;
    onreadystatechange: (() => void) | null;
    onprogress: (() => void) | null;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    open(method: string, url: string, async?: boolean): void;
    setRequestHeader(name: string, value: string): void;
    getAllResponseHeaders(): string;
    send(body?: string | null): void;
    abort(): void;
}
export type RnStreamingXhrCtor = new () => RnStreamingXhr;

/** Options for {@link rnStreamAdapter}. */
export interface RnStreamAdapterOptions {
    /**
     * Inject the `XMLHttpRequest` constructor for the streaming branch (testing /
     * custom runtimes). Defaults to `globalThis.XMLHttpRequest`.
     */
    XHR?: RnStreamingXhrCtor;
    /**
     * Transport for non-streaming (unary) requests. Defaults to core's
     * {@link xhrAdapter}; pass your own to delegate unary traffic elsewhere.
     */
    unary?: Adapter;
}

const XHR_HEADERS_RECEIVED = 2;
const XHR_DONE = 4;

/**
 * A stitch {@link Adapter} that streams on React Native. Streaming responses are
 * read incrementally from `XMLHttpRequest.responseText` and surfaced as a
 * `ReadableStream<Uint8Array>`; unary responses delegate to the `unary` transport
 * (core's `xhrAdapter` by default).
 *
 * ```ts
 * import { seam } from 'stitchapi';
 * import { rnStreamAdapter } from '@stitchapi/react-native';
 *
 * const api = seam({ adapter: rnStreamAdapter() });
 * ```
 */
export function rnStreamAdapter(opts: RnStreamAdapterOptions = {}): Adapter {
    const unary = opts.unary ?? xhrAdapter();
    return function rnStreamAdapterRequest(
        req: AdapterRequest,
    ): Promise<AdapterResponse> {
        if (!req.stream) return unary(req);
        return streamViaXhr(req, opts.XHR);
    };
}

function streamViaXhr(
    req: AdapterRequest,
    XHR?: RnStreamingXhrCtor,
): Promise<AdapterResponse> {
    assertStreamingPolyfills();
    const Ctor =
        XHR ?? (globalThis.XMLHttpRequest as RnStreamingXhrCtor | undefined);
    if (!Ctor) {
        return Promise.reject(
            new Error(
                'rnStreamAdapter requires XMLHttpRequest; pass `XHR` for non-RN runtimes.',
            ),
        );
    }

    const { body, contentType } = encodeStreamBody(req);
    const headers: Record<string, string> = { ...req.headers };
    if (contentType && !hasHeader(headers, 'content-type')) {
        headers['content-type'] = contentType;
    }

    return new Promise<AdapterResponse>((resolve, reject) => {
        const xhr = new Ctor();
        xhr.open(req.method.toUpperCase(), req.url, true);
        // 'text' keeps `responseText` incrementally readable as bytes arrive; an
        // 'arraybuffer' responseType would only resolve once, fully buffered.
        xhr.responseType = 'text';

        const encoder = new TextEncoder();
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
            null;
        let emitted = 0; // chars of responseText already enqueued
        let settled = false; // AdapterResponse resolved (headers seen)?
        let closed = false; // stream closed or errored?
        let pendingError: unknown = null;
        let pendingClose = false;

        const pump = (): void => {
            if (!controller || closed) return;
            const text = xhr.responseText;
            let end = text.length;
            if (end > emitted) {
                // Don't split a surrogate pair across chunks: hold back a trailing
                // lone high surrogate until its low half arrives next tick.
                const lastCode = text.charCodeAt(end - 1);
                if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
            }
            if (end > emitted) {
                const slice = text.slice(emitted, end);
                emitted = end;
                controller.enqueue(encoder.encode(slice));
            }
        };

        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                pump();
                if (pendingError !== null) c.error(pendingError);
                else if (pendingClose) c.close();
            },
            cancel() {
                try {
                    xhr.abort();
                } catch {
                    /* request already finished */
                }
            },
        });

        const settle = (): void => {
            if (settled) return;
            settled = true;
            resolve({
                status: xhr.status,
                headers: parseHeaders(xhr.getAllResponseHeaders()),
                body: stream,
                url: req.url,
            });
        };
        const closeStream = (): void => {
            if (closed) return;
            closed = true;
            if (controller) controller.close();
            else pendingClose = true;
        };
        const errorStream = (err: unknown): void => {
            if (closed) return;
            closed = true;
            if (controller) controller.error(err);
            else pendingError = err;
        };

        xhr.onreadystatechange = (): void => {
            if (xhr.readyState >= XHR_HEADERS_RECEIVED) settle();
            pump();
            if (xhr.readyState >= XHR_DONE) closeStream();
        };
        xhr.onprogress = (): void => {
            pump();
        };
        xhr.onload = (): void => {
            settle();
            pump();
            closeStream();
        };
        xhr.onerror = (): void => {
            const err = new Error('rnStreamAdapter: network error');
            if (!settled) reject(err);
            else errorStream(err);
        };
        xhr.onabort = (): void => {
            const err = new Error('rnStreamAdapter: request aborted');
            if (!settled) reject(err);
            else errorStream(err);
        };

        for (const [name, value] of Object.entries(headers)) {
            xhr.setRequestHeader(name, value);
        }

        if (req.signal) {
            if (req.signal.aborted) xhr.abort();
            else
                req.signal.addEventListener('abort', () => {
                    try {
                        xhr.abort();
                    } catch {
                        /* request already finished */
                    }
                });
        }

        xhr.send(body ?? null);
    });
}

// A streaming request's body is, in practice, either none (an `sse` GET) or a JSON
// payload (an `stream` POST, e.g. an LLM chat prompt) — form/multipart bodies are
// not streaming-response shapes. Encode that common case; a pre-stringified body is
// passed through untouched.
function encodeStreamBody(req: AdapterRequest): {
    body: string | null;
    contentType?: string;
} {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return { body: null };
    if (req.body === undefined || req.body === null) return { body: null };
    if (typeof req.body === 'string') return { body: req.body };
    return { body: JSON.stringify(req.body), contentType: 'application/json' };
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

// Parse the CRLF-joined block from getAllResponseHeaders() into a lowercased map.
function parseHeaders(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        if (key) out[key] = line.slice(idx + 1).trim();
    }
    return out;
}
