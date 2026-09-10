// An Adapter backed by a caller-supplied axios-compatible client. StitchAPI's runtime is
// zero-dependency, so axios is never imported here — you pass in your own instance:
//
//   import axios from 'axios';
//   import { axiosAdapter, stitch } from 'stitchapi';
//   const getUser = stitch({ url: '…/users/{id}', adapter: axiosAdapter(axios) });
//
// Body encoding (json/form/multipart) and response parsing reuse the same helpers as
// fetchAdapter, so behavior is identical across transports. The client is asked for raw
// bytes (responseType 'arraybuffer') and told never to throw on non-2xx — the engine
// decides what a given status means.
import { compact } from './compact';
import {
    decodeResponseBody,
    encodeRequestBody,
    headersForRedirect,
} from './http-adapter';
import type {
    Adapter,
    AdapterProgress,
    AdapterRequest,
    AdapterResponse,
} from './types';

/** The byte-progress event axios passes to `onUploadProgress`/`onDownloadProgress` — the subset the
 *  adapter reads (axios's `AxiosProgressEvent` carries more, e.g. `rate`/`estimated`). */
export interface AxiosLikeProgressEvent {
    loaded: number;
    total?: number;
}
/** The minimal surface of an axios instance the adapter needs — structurally satisfied by `axios`. */
export interface AxiosLikeConfig {
    url: string;
    method: string;
    headers?: Record<string, string>;
    data?: unknown;
    // Narrower than `string` on purpose: axios types this as its own `ResponseType` union, and a
    // plain `string` makes `AxiosLikeConfig` unassignable to `AxiosRequestConfig` — which made
    // `axiosAdapter(axios)` itself fail to typecheck against real axios (#708). The adapter only
    // ever sends 'arraybuffer' (below), so narrowing to a subset of axios's union costs nothing.
    responseType?: 'arraybuffer' | 'json' | 'text';
    signal?: AbortSignal;
    validateStatus?: ((status: number) => boolean) | null;
    onUploadProgress?: (e: AxiosLikeProgressEvent) => void;
    onDownloadProgress?: (e: AxiosLikeProgressEvent) => void;
    [key: string]: unknown;
}
export interface AxiosLikeResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    data: unknown;
    // The config axios actually dispatched, echoed back on the response — read for its `url` so
    // `AdapterResponse.url` is populated on this transport too (#708 §2). Declared as a minimal
    // OPTIONAL bag rather than reusing `AxiosLikeConfig`, on purpose: real axios types this as
    // `InternalAxiosRequestConfig`, whose `url`/`method` are optional, so requiring `AxiosLikeConfig`
    // here would make `AxiosResponse` unassignable to `AxiosLikeResponse` and break
    // `axiosAdapter(axios)` exactly the way the §1 fix above did. Keep it a structural subset.
    config?: { url?: string };
}
export interface AxiosLike {
    request(config: AxiosLikeConfig): Promise<AxiosLikeResponse>;
}

/**
 * Wrap an axios-compatible `client` (typically the default `axios` export or an
 * `axios.create()` instance) as a stitch {@link Adapter}. `defaults` are merged under every
 * request — e.g. `{ proxy, httpsAgent, timeout }` — and are overridden by per-call values.
 */
export function axiosAdapter(
    client: AxiosLike,
    defaults: Partial<AxiosLikeConfig> = {},
): Adapter {
    const axiosAdapterRequest: Adapter = async function axiosAdapterRequest(
        req: AdapterRequest,
    ): Promise<AdapterResponse> {
        // Buffered-only transport (ADR 0005 Decision 9): a streaming surface must use
        // fetchAdapter. Fail loudly rather than silently buffering a stream.
        if (req.stream) {
            throw new Error(
                'axiosAdapter does not support streaming responses; use fetchAdapter for `stream`.',
            );
        }
        const headers: Record<string, string> = {
            ...defaults.headers,
            ...req.headers,
        };
        const { body, contentType } = encodeRequestBody(req);
        if (contentType && !hasHeader(headers, 'content-type')) {
            headers['content-type'] = contentType;
        }

        // Byte progress: axios reports both phases natively, so translate its progress events into
        // the adapter's `{ direction, loaded, total? }` shape and wire them only when the call asked.
        const onProgress = req.onProgress;
        const progress = (
            direction: AdapterProgress['direction'],
        ): ((e: AxiosLikeProgressEvent) => void) | undefined => {
            if (onProgress === undefined) return undefined;
            const cb = onProgress;
            return (e) => {
                cb(
                    e.total !== undefined
                        ? { direction, loaded: e.loaded, total: e.total }
                        : { direction, loaded: e.loaded },
                );
            };
        };

        const res = await client.request(
            compact({
                ...defaults,
                url: req.url,
                method: req.method.toUpperCase(),
                headers,
                data: body,
                responseType: 'arraybuffer',
                signal: req.signal,
                onUploadProgress: progress('upload'),
                onDownloadProgress: progress('download'),
                validateStatus: () => true, // never throw on non-2xx; the engine decides
                // Credential-leak guard on redirects (same policy as fetchAdapter): axios follows
                // 3xx via follow-redirects, which strips `authorization`/`cookie` cross-origin but
                // NOT custom auth headers (`x-api-key`, `x-amz-*`) — so a redirect to another host
                // would leak them. This hook fires before each hop; when the next hop leaves the
                // ORIGINAL origin we replace the outgoing headers with the CORS-safelisted subset
                // (headersForRedirect drops everything else). Same-origin hops keep headers intact.
                beforeRedirect: makeBeforeRedirect(req.url, headers),
            }),
        );

        const resHeaders = normalizeHeaders(res.headers);
        const contentTypeResp = resHeaders['content-type'] ?? '';
        const parsed = decodeResponseBody(
            req.response,
            contentTypeResp,
            toArrayBuffer(res.data),
        );
        return {
            status: res.status,
            headers: resHeaders,
            body: parsed,
            url: responseUrl(res, req.url),
        };
    };
    // Buffered-only (it rejects `stream`), but axios reports byte progress for BOTH phases, which
    // the adapter now wires — so `supports` carries the two progress phases. Requires an axios that
    // honours `onUploadProgress`/`onDownloadProgress` (v1+); older clients simply never fire them.
    axiosAdapterRequest.capabilities = {
        name: 'axiosAdapter',
        supports: ['uploadProgress', 'downloadProgress'],
    };
    return axiosAdapterRequest;
}

// The URL to report as `AdapterResponse.url`. `fetchAdapter` sets that field from the response
// it actually got back, so it is the FINAL url after redirects; axios exposes no such thing — its
// response carries only the config it dispatched. So this is the REQUEST url, and a followed 3xx
// makes the two differ: what is reported is where the request was aimed, not necessarily where it
// landed. #708 §2 accepts that explicitly — the request URL is strictly better than `undefined`,
// which is what this transport reported before, silently breaking `StitchError.url` and the
// `download` filename fallback (ADR 0005 Decision 8) for every axios caller.
//
// `res.config.url` is preferred over the `req.url` we passed in because a request interceptor may
// have rewritten it, so it is the closer account of what axios actually requested; a client that
// echoes no config (or an empty url) falls back to `req.url`, which is always a non-empty string.
function responseUrl(res: AxiosLikeResponse, requestUrl: string): string {
    const dispatched = res.config?.url;
    return dispatched !== undefined && dispatched !== ''
        ? dispatched
        : requestUrl;
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

// Build the axios/follow-redirects `beforeRedirect(options)` hook that enforces the
// cross-origin credential-strip policy shared with fetchAdapter. `options` describes the NEXT
// request; follow-redirects lets the hook mutate `options.headers` in place. We reconstruct the
// destination URL from `options` and, when it leaves the ORIGINAL request origin, overwrite the
// header set with only the CORS-safelisted subset (headersForRedirect) — dropping every
// credential/custom header. Comparing each hop against the original origin is correct: once a
// chain leaves the origin, the original credentials must never reappear downstream.
function makeBeforeRedirect(
    originalUrl: string,
    originalHeaders: Record<string, string>,
): (options: Record<string, unknown>) => void {
    return (options) => {
        // follow-redirects carries the next hop's headers on `options.headers`; use them when
        // present, else the headers we sent. Reassign the whole object (the documented way to
        // change headers from beforeRedirect) — no dynamic delete, and it replaces the reference
        // follow-redirects reads. Unknown destination shape → dest '' fails safe (cross-origin).
        const current = options['headers'];
        const from: Record<string, string> = isStringRecord(current)
            ? current
            : originalHeaders;
        options['headers'] = headersForRedirect(
            from,
            originalUrl,
            redirectHref(options) ?? '',
        );
    };
}

// Narrow an unknown to a string-keyed header record (a plain object). Used to read the outgoing
// headers off the follow-redirects `options` bag without an unchecked assertion.
function isStringRecord(v: unknown): v is Record<string, string> {
    return typeof v === 'object' && v !== null;
}

// Reconstruct the absolute destination URL from a follow-redirects `options` bag. It exposes the
// parsed target as `href`, or as `protocol` + `host`/`hostname`(+`port`) + `path`. Returns
// undefined if nothing usable is present (caller then fails safe and strips).
function redirectHref(options: Record<string, unknown>): string | undefined {
    const href = options['href'];
    if (typeof href === 'string' && href) return href;
    const protocol = options['protocol'];
    const host = options['host'] ?? options['hostname'];
    if (typeof protocol === 'string' && typeof host === 'string' && host) {
        return `${protocol}//${host}`;
    }
    return undefined;
}

// Lowercase header keys to match fetchAdapter; join a multi-valued set-cookie with ', '.
function normalizeHeaders(
    h: Record<string, string | string[] | undefined>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined) continue;
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }
    return out;
}

// Normalize whatever the client handed back (ArrayBuffer, Node Buffer/typed array, or — if
// it ignored responseType — a string or already-parsed object) into raw bytes for decoding.
function toArrayBuffer(data: unknown): ArrayBuffer {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        // copy the exact byte view into its own ArrayBuffer
        return new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        ).slice().buffer;
    }
    if (data === undefined || data === null) return new ArrayBuffer(0);
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return new TextEncoder().encode(text).buffer;
}
