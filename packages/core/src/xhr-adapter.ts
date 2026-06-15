// A browser-only Adapter backed by XMLHttpRequest. Its reason to exist over fetchAdapter is
// UPLOAD progress: `fetch` cannot report bytes sent, but `xhr.upload` can (ADR 0005 Decision 9).
// Zero-dependency; it reuses the shared body-encoding / response-decoding helpers so its wire
// behaviour matches fetchAdapter exactly. It is buffered-only — it rejects `req.stream` (use
// fetchAdapter to stream). Like axiosAdapter takes its client, this takes an optional XHR
// constructor (default `globalThis.XMLHttpRequest`) so it is testable off-browser.
import { decodeResponseBody, encodeRequestBody } from './http-adapter';
import type { Adapter, AdapterRequest, AdapterResponse } from './types';

/** The byte-progress shape XHR emits (a structural subset of the DOM `ProgressEvent`). */
export interface XhrProgress {
    lengthComputable: boolean;
    loaded: number;
    total: number;
}

/** The minimal surface of an XMLHttpRequest the adapter needs — structurally satisfied by the
 *  browser global. Mirrors the `AxiosLike` pattern so the transport stays dependency-injectable. */
export interface XhrLike {
    responseType: string;
    readonly status: number;
    readonly response: unknown;
    readonly upload: { onprogress: ((e: XhrProgress) => void) | null };
    onload: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    onprogress: ((e: XhrProgress) => void) | null;
    open(method: string, url: string, async: boolean): void;
    setRequestHeader(name: string, value: string): void;
    getAllResponseHeaders(): string;
    send(body: string | FormData | null): void;
    abort(): void;
}
export type XhrLikeCtor = new () => XhrLike;

/**
 * Wrap `XMLHttpRequest` as a stitch {@link Adapter} with upload + download progress. Pass a
 * constructor to inject a custom/fake XHR (testing, non-browser polyfills); defaults to the
 * browser global. Throws if no constructor is available, and rejects `stream` (buffered-only).
 */
export function xhrAdapter(XHR?: XhrLikeCtor): Adapter {
    return function xhrAdapterRequest(
        req: AdapterRequest,
    ): Promise<AdapterResponse> {
        if (req.stream) {
            return Promise.reject(
                new Error(
                    'xhrAdapter does not support streaming responses; use fetchAdapter for `stream`.',
                ),
            );
        }
        const Ctor =
            XHR ?? (globalThis.XMLHttpRequest as XhrLikeCtor | undefined);
        if (!Ctor) {
            return Promise.reject(
                new Error(
                    'xhrAdapter requires XMLHttpRequest (browser only). Pass a constructor for other runtimes.',
                ),
            );
        }

        return new Promise<AdapterResponse>((resolve, reject) => {
            const xhr = new Ctor();
            xhr.open(req.method.toUpperCase(), req.url, true);
            xhr.responseType = 'arraybuffer';

            // Encode the body with the shared helper so json/form/multipart match fetchAdapter.
            const { body, contentType } = encodeRequestBody(req);
            const headers = { ...req.headers };
            if (contentType && !hasHeader(headers, 'content-type'))
                headers['content-type'] = contentType;
            for (const [k, v] of Object.entries(headers))
                xhr.setRequestHeader(k, v);

            const onProgress = req.onProgress;
            if (onProgress) {
                xhr.upload.onprogress = (e) => {
                    onProgress(
                        e.lengthComputable
                            ? {
                                  phase: 'upload',
                                  loaded: e.loaded,
                                  total: e.total,
                              }
                            : { phase: 'upload', loaded: e.loaded },
                    );
                };
                xhr.onprogress = (e) => {
                    onProgress(
                        e.lengthComputable
                            ? {
                                  phase: 'download',
                                  loaded: e.loaded,
                                  total: e.total,
                              }
                            : { phase: 'download', loaded: e.loaded },
                    );
                };
            }

            xhr.onload = () => {
                const resHeaders = parseHeaders(xhr.getAllResponseHeaders());
                const contentTypeResp = resHeaders['content-type'] ?? '';
                const bytes =
                    (xhr.response as ArrayBuffer | null) ?? new ArrayBuffer(0);
                resolve({
                    status: xhr.status,
                    headers: resHeaders,
                    body: decodeResponseBody(
                        req.responseType,
                        contentTypeResp,
                        bytes,
                    ),
                });
            };
            xhr.onerror = () => {
                reject(new Error('xhrAdapter: network error'));
            };
            xhr.onabort = () => {
                reject(new Error('xhrAdapter: aborted'));
            };

            if (req.signal) {
                if (req.signal.aborted) xhr.abort();
                else
                    req.signal.addEventListener('abort', () => {
                        xhr.abort();
                    });
            }

            xhr.send(body ?? null);
        });
    };
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

// Parse the raw CRLF-joined header block from getAllResponseHeaders() into a lowercased map.
function parseHeaders(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.trim().split(/[\r\n]+/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        out[line.slice(0, idx).trim().toLowerCase()] = line
            .slice(idx + 1)
            .trim();
    }
    return out;
}
