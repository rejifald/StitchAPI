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
import { decodeResponseBody, encodeRequestBody } from './http-adapter';
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
    responseType?: string;
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
        // the adapter's `{ phase, loaded, total? }` shape and wire them only when the call asked.
        const onProgress = req.onProgress;
        const progress = (
            phase: AdapterProgress['phase'],
        ): ((e: AxiosLikeProgressEvent) => void) => {
            const cb = onProgress as (p: AdapterProgress) => void;
            return (e) => {
                cb(
                    e.total !== undefined
                        ? { phase, loaded: e.loaded, total: e.total }
                        : { phase, loaded: e.loaded },
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
                ...(req.signal ? { signal: req.signal } : {}),
                ...(onProgress
                    ? {
                          onUploadProgress: progress('upload'),
                          onDownloadProgress: progress('download'),
                      }
                    : {}),
                validateStatus: () => true, // never throw on non-2xx; the engine decides
            }),
        );

        const resHeaders = normalizeHeaders(res.headers);
        const contentTypeResp = resHeaders['content-type'] ?? '';
        const parsed = decodeResponseBody(
            req.responseType,
            contentTypeResp,
            toArrayBuffer(res.data),
        );
        return { status: res.status, headers: resHeaders, body: parsed };
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

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

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
