import { compact } from './compact';
import type {
    Adapter,
    AdapterProgress,
    AdapterRequest,
    AdapterResponse,
    MultipartNesting,
    ResponseType,
} from './types';

/** Options for {@link fetchAdapter}: thread a per-stitch undici dispatcher and/or
 *  override the global `fetch` — without StitchAPI ever importing undici (zero deps). */
export interface FetchAdapterOptions {
    /** An undici Dispatcher/Agent (proxy, custom CA, interface binding). Passed straight
     *  to Node's `fetch` as the non-standard `dispatcher` init option. Typed `unknown` to
     *  avoid a hard undici dependency — the runtime stays zero-deps; you bring your own Agent. */
    dispatcher?: unknown;
    /** Override the global `fetch` (testing / custom runtimes). Defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
}

// The standard `RequestInit` has no `dispatcher` field (it's an undici extension Node's
// `fetch` honors), so the init is typed locally as RequestInit widened with the extra key —
// no `any`, in the spirit of the `as BlobPart` narrowings below. The intersection stays
// assignable to RequestInit, so the call site needs no cast.
type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

// Returns an Adapter backed by Node's global `fetch`. Never throws on non-2xx —
// only network/abort errors propagate; the engine decides what to do with the response.
// Pass `opts.dispatcher` to route the request through an undici Agent (proxy, custom CA,
// interface binding); pass `opts.fetch` to swap in a different fetch (testing / runtimes).
export function fetchAdapter(opts?: FetchAdapterOptions): Adapter {
    // Resolve the fetch implementation once (override wins; else the global).
    const fetchImpl = opts?.fetch ?? fetch;
    const fetchAdapterRequest: Adapter = async function fetchAdapterRequest(
        req: AdapterRequest,
    ): Promise<AdapterResponse> {
        const method = req.method.toUpperCase();
        const headers: Record<string, string> = { ...req.headers };

        // Encode the body per req.bodyType (shared with other transports). The returned
        // content-type is applied only when the caller hasn't set one; multipart returns
        // none, leaving fetch to add the boundary itself.
        const { body, contentType } = encodeRequestBody(req);
        if (contentType && !hasHeader(headers, 'content-type')) {
            headers['content-type'] = contentType;
        }

        // Build the init as a typed local; `compact` drops `body`/`dispatcher` when absent,
        // so the non-standard `dispatcher` key stays off unless a dispatcher is supplied.
        // `redirect: 'manual'` — we follow redirects ourselves (see followRedirects) so a
        // cross-origin hop drops the auth/custom headers instead of leaking them.
        const init: FetchInitWithDispatcher = compact({
            method,
            headers,
            body,
            signal: req.signal,
            dispatcher: opts?.dispatcher,
            redirect: 'manual',
        });

        // Send the request and follow any redirects ourselves, stripping credential/custom
        // headers on cross-origin hops. Network/abort errors propagate to the caller. The
        // local init type (with the undici-only `dispatcher`) widens cleanly to RequestInit.
        const { response, url: finalUrl } = await followRedirects(
            fetchImpl,
            req.url,
            init,
            headers,
        );

        // Collect response headers with lowercased keys; join multiple set-cookie with ', '.
        const resHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            resHeaders[key.toLowerCase()] = value;
        });
        const getSetCookie = response.headers.getSetCookie?.bind(
            response.headers,
        );
        const setCookies = getSetCookie ? getSetCookie() : undefined;
        if (setCookies && setCookies.length > 0) {
            resHeaders['set-cookie'] = setCookies.join(', ');
        } else {
            const single = response.headers.get('set-cookie');
            if (single !== null) {
                resHeaders['set-cookie'] = single;
            }
        }

        // Streaming surfaces (sse/stream) ask for the live body: hand back the ReadableStream
        // unparsed (ADR 0005 Q1 — `body` carries the stream when `req.stream` is set).
        if (req.stream) {
            return {
                status: response.status,
                headers: resHeaders,
                body: response.body,
                url: finalUrl,
            };
        }

        // Download progress: read the body in chunks, reporting bytes as they arrive, then
        // decode the assembled bytes exactly as the buffered path would (ADR 0005 Decision 9).
        if (req.onProgress) {
            const bytes = await readWithProgress(response, req.onProgress);
            const contentType = resHeaders['content-type'] ?? '';
            return {
                status: response.status,
                headers: resHeaders,
                body: decodeResponseBody(req.responseType, contentType, bytes),
                url: finalUrl,
            };
        }

        // Read the body. An explicit responseType wins (arrayBuffer/blob for binary
        // downloads, text/json to force a shape); otherwise auto-detect by content-type.
        let parsed: unknown;
        const responseType = req.responseType;
        if (responseType === 'arrayBuffer') {
            parsed = await response.arrayBuffer();
        } else if (responseType === 'blob') {
            parsed = await response.blob();
        } else if (responseType === 'text') {
            parsed = await response.text();
        } else {
            const contentType = (
                resHeaders['content-type'] ?? ''
            ).toLowerCase();
            const isJson =
                responseType === 'json' ||
                contentType.includes('application/json') ||
                contentType.includes('+json');
            if (isJson) {
                const text = await response.text();
                parsed = text === '' ? undefined : JSON.parse(text);
            } else {
                parsed = await response.text();
            }
        }

        return {
            status: response.status,
            headers: resHeaders,
            body: parsed,
            url: finalUrl,
        };
    };
    // `fetch` streams a response (so `stream`/`sse` ride it) and reports `direction: 'download'`
    // progress while reading a buffered body, but cannot report bytes SENT — the upload phase stays
    // silent, so `'uploadProgress'` is absent from `supports`. Declaring it lets the engine teach
    // instead of no-op when a call asks for upload progress.
    fetchAdapterRequest.capabilities = {
        name: 'fetchAdapter',
        supports: ['stream', 'downloadProgress'],
    };
    return fetchAdapterRequest;
}

// Read a response body to completion, reporting download progress per chunk (ADR 0005
// Decision 9). Returns the full bytes so the caller decodes them per responseType — the same
// `decodeResponseBody` the buffered path uses, so a progress read parses identically.
async function readWithProgress(
    response: Response,
    onProgress: (p: AdapterProgress) => void,
): Promise<ArrayBuffer> {
    const lenHeader = response.headers.get('content-length');
    const parsedLen = lenHeader != null ? Number(lenHeader) : NaN;
    const total = Number.isFinite(parsedLen) ? parsedLen : undefined;
    const reader = response.body?.getReader();
    if (!reader) {
        onProgress(
            total !== undefined
                ? { direction: 'download', loaded: 0, total }
                : { direction: 'download', loaded: 0 },
        );
        return new ArrayBuffer(0);
    }
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(
            total !== undefined
                ? { direction: 'download', loaded, total }
                : { direction: 'download', loaded },
        );
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }
    return out.buffer;
}

// Hop cap — matches the platform default (Node/undici stop at 20) so a redirect loop can't spin.
const MAX_REDIRECTS = 20;

// Send a request with `redirect: 'manual'` and follow any redirects OURSELVES, so a cross-origin
// hop drops the auth/custom headers (headersForRedirect) instead of leaking them — undici/axios
// only strip `authorization`/`cookie`, never custom headers like `x-api-key`/`x-amz-*`.
//
// Browser semantics: with `redirect: 'manual'` a browser returns an OPAQUE-redirect response
// (`type: 'opaqueredirect'`, status 0, no readable Location) that cannot be followed from JS. We
// detect that (no `location`) and return it as-is — the browser is already following the redirect
// under CORS, which itself prevents the cross-origin custom-header leak (preflight). So:
// manual-follow where the 3xx is readable (Node/undici), platform-safe otherwise. Returns the
// final response and the URL it came from (for AdapterResponse.url).
async function followRedirects(
    fetchImpl: typeof fetch,
    startUrl: string,
    init: FetchInitWithDispatcher,
    startHeaders: Record<string, string>,
): Promise<{ response: Response; url: string }> {
    let url = startUrl;
    let headers = startHeaders;
    let method = init.method ?? 'GET';
    let body = init.body;
    for (let hop = 0; ; hop++) {
        const response = await fetchImpl(
            url,
            compact({ ...init, method, headers, body }),
        );
        const status = response.status;
        const location =
            status >= 300 && status < 400
                ? response.headers.get('location')
                : null;
        // Not a followable redirect (normal response, an opaque-redirect in the browser, or a
        // 3xx with no Location) → hand it back. Stop before exceeding the hop cap too.
        if (location === null || hop >= MAX_REDIRECTS) return { response, url };
        const next = new URL(location, url).toString();
        // Strip credential/custom headers when the next hop leaves the origin (the whole point).
        headers = headersForRedirect(headers, url, next);
        // Fetch redirect model: 303 (and 301/302 on a non-GET/HEAD) become a bodyless GET; 307/308
        // keep method and body. Rebuild headers without content-type when the body is dropped —
        // and always via a fresh object, since a same-origin headersForRedirect aliased the input.
        if (
            status === 303 ||
            (status < 303 && method !== 'GET' && method !== 'HEAD')
        ) {
            method = 'GET';
            body = undefined;
            const stripped: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers))
                if (k.toLowerCase() !== 'content-type') stripped[k] = v;
            headers = stripped;
        }
        url = next;
    }
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

// ---- cross-origin redirect credential guard -------------------------------
// Auth strategies put credentials in CUSTOM request headers (`apiKey` → `x-api-key`;
// `awsSigV4` → `authorization` + `x-amz-*`). The default HTTP redirect policy re-sends
// every request header to the redirect target. undici/axios strip `authorization`/`cookie`
// on a cross-origin hop but NOT custom headers, so `x-api-key`/`x-amz-*` would leak to an
// unintended host (open-redirect / compromised endpoint) — the "capability, not a
// credential" invariant. So on a CROSS-origin hop we keep only the CORS request-header
// safelist (accept / accept-language / content-language / content-type) and drop the rest
// — which covers `authorization`, `cookie`, `proxy-authorization`, and every custom auth
// header at once. Same-origin hops keep headers intact (the common case; auth continues).
// This is the browser's own fetch redirect model, applied on Node where the platform
// wouldn't. Shared by both the fetch manual-follow loop and the axios `beforeRedirect` hook
// so the policy is identical (and to keep the added bundle cost to one tiny function).

// Same origin = same scheme + host + port. `URL.host` includes the port, so comparing
// protocol + host covers all three (an implicit-vs-explicit default port like :443 is the one
// edge this over-strips — acceptable, it only ever errs toward dropping credentials). `a` is
// the current absolute request URL, `b` the resolved (absolute) redirect target.
const sameOrigin = (a: string, b: string): boolean => {
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.protocol === ub.protocol && ua.host === ub.host;
    } catch {
        return false; // unparseable → treat as cross-origin (fail safe: strip)
    }
};

// The CORS-safelisted request header names — the only ones a browser forwards on a
// cross-origin redirect. Everything else (auth/cookie/custom) is dropped.
const CORS_SAFELIST = new Set([
    'accept',
    'accept-language',
    'content-language',
    'content-type',
]);

/**
 * Given the headers for the hop from `from` to `to`, return the headers to actually send:
 * unchanged when same-origin, or only the CORS-safelisted subset when cross-origin (dropping
 * every credential/custom header). Exported for the axios adapter's `beforeRedirect` hook and
 * the fetch manual-follow loop to share one policy.
 */
export function headersForRedirect(
    headers: Record<string, string>,
    from: string,
    to: string,
): Record<string, string> {
    if (sameOrigin(from, to)) return headers;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (CORS_SAFELIST.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

// Encode a request body per `bodyType` (default 'json'). Shared across transports so
// form/multipart/json encoding is identical regardless of the underlying HTTP client.
// Returns the encoded body and the content-type to set when the caller hasn't already;
// multipart returns no content-type, leaving the transport to add the boundary.
export function encodeRequestBody(req: AdapterRequest): {
    body: string | FormData | undefined;
    contentType?: string;
} {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return { body: undefined };
    if (req.body === undefined || req.body === null) return { body: undefined };
    if (typeof req.body === 'string') return { body: req.body };
    if (req.bodyType === 'form') {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(
            req.body as Record<string, unknown>,
        )) {
            if (v !== undefined && v !== null) params.append(k, String(v));
        }
        return {
            body: params.toString(),
            contentType: 'application/x-www-form-urlencoded',
        };
    }
    if (req.bodyType === 'multipart') {
        const form = new FormData();
        encodeMultipart(
            form,
            req.body as Record<string, unknown>,
            req.multipart?.nesting ?? 'bracket',
        );
        return { body: form };
    }
    return { body: JSON.stringify(req.body), contentType: 'application/json' };
}

// Decode raw response bytes into the value the engine sees: an explicit responseType wins
// (arrayBuffer/blob for binary, text/json to force a shape), otherwise JSON is auto-detected
// by content-type. Shared by transports that hand back bytes (e.g. the axios adapter, which
// requests an arraybuffer and decodes here so its parsing matches fetchAdapter exactly).
export function decodeResponseBody(
    responseType: ResponseType | undefined,
    contentType: string,
    bytes: ArrayBuffer,
): unknown {
    if (responseType === 'arrayBuffer') return bytes;
    if (responseType === 'blob')
        return new Blob(
            [bytes],
            contentType ? { type: contentType } : undefined,
        );
    const text = new TextDecoder().decode(bytes);
    if (responseType === 'text') return text;
    const ct = contentType.toLowerCase();
    const isJson =
        responseType === 'json' ||
        ct.includes('application/json') ||
        ct.includes('+json');
    if (isJson) return text === '' ? undefined : JSON.parse(text);
    return text;
}

// ---- multipart encoding (ADR 0005 Decision 6) -----------------------------
// A value that becomes a binary file part: a Blob, a raw byte view, or a
// { value, filename?, type? } file wrapper. Anything else is a nested object/scalar.
//
// The wrapper is recognised ONLY when it is actually file-ish: `value` is binary (a Blob /
// Uint8Array / ArrayBuffer), OR an explicit `filename`/`type` marks it a file part (so
// `{ value: 'text', filename: 'note.txt' }` is still a named text part). A plain domain object that
// merely HAPPENS to carry a `value` key — e.g. `{ value: 100, currency: 'USD' }` — is NOT a file:
// treating it as one encoded `value` as a tiny Blob and silently DROPPED its siblings. Such an
// object falls through here and recurses as a normal nested object instead.
function isFileWrapper(v: object): boolean {
    const w = v as { value?: unknown; filename?: unknown; type?: unknown };
    return (
        w.value instanceof Blob ||
        w.value instanceof Uint8Array ||
        w.value instanceof ArrayBuffer ||
        w.filename !== undefined ||
        w.type !== undefined
    );
}

function isFileLeaf(v: unknown): boolean {
    return (
        v instanceof Blob ||
        v instanceof Uint8Array ||
        (typeof v === 'object' &&
            v !== null &&
            'value' in (v as Record<string, unknown>) &&
            isFileWrapper(v))
    );
}

// Append one file leaf as a multipart file part (named, when a filename is given).
function appendFilePart(form: FormData, key: string, v: unknown): void {
    if (v instanceof Blob) {
        form.append(key, v);
        return;
    }
    if (v instanceof Uint8Array) {
        // `as BlobPart`: on TS 5.7+ TypedArrays are generic over their backing
        // buffer (Uint8Array<ArrayBufferLike>), and ArrayBufferLike admits
        // SharedArrayBuffer, which the DOM BlobPart rejects. The instanceof
        // guard proves this is a real byte view, so assert (matches f.value below).
        form.append(key, new Blob([v as BlobPart]));
        return;
    }
    const f = v as { value: unknown; filename?: string; type?: string };
    const blob =
        f.value instanceof Blob
            ? f.value
            : new Blob(
                  [f.value as BlobPart],
                  f.type ? { type: f.type } : undefined,
              );
    if (f.filename) form.append(key, blob, f.filename);
    else form.append(key, blob);
}

// Legacy 'none' nesting: top-level keys only — a file leaf becomes a file part, anything
// else is stringified (so a nested object becomes the literal "[object Object]").
function appendForm(form: FormData, key: string, v: unknown): void {
    if (isFileLeaf(v)) {
        appendFilePart(form, key, v);
        return;
    }
    form.append(key, String(v));
}

// Compose a child field name under a parent. Root keys (no parent) are bare; nested keys
// are `parent[child]` (bracket) or `parent.child` (dot).
function joinKey(parent: string, child: string | number, dot: boolean): string {
    if (parent === '') return String(child);
    return dot ? `${parent}.${child}` : `${parent}[${child}]`;
}

// Recursive flatten for 'bracket'/'dot': a file leaf becomes a binary part at its flattened
// key, a scalar a string part, and nested objects/arrays recurse with composed keys.
// null/undefined are skipped so no empty parts are emitted.
function flattenInto(
    form: FormData,
    value: unknown,
    key: string,
    dot: boolean,
): void {
    if (value === undefined || value === null) return;
    if (isFileLeaf(value)) {
        appendFilePart(form, key, value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            flattenInto(form, item, joinKey(key, i, dot), dot);
        });
        return;
    }
    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>))
            flattenInto(form, v, joinKey(key, k, dot), dot);
        return;
    }
    if (typeof value === 'string') {
        form.append(key, value);
        return;
    }
    if (
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        typeof value === 'boolean'
    )
        form.append(key, String(value));
}

// 'json' nesting: pull every file leaf out into its own bracket-path-keyed part (collected in
// `files`) and return the remaining structure (files removed) to be JSON-encoded as one part.
function stripFiles(
    value: unknown,
    key: string,
    files: [string, unknown][],
): unknown {
    if (isFileLeaf(value)) {
        files.push([key, value]);
        return undefined;
    }
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        value.forEach((item, i) => {
            const kept = stripFiles(item, joinKey(key, i, false), files);
            if (kept !== undefined) out.push(kept);
        });
        return out;
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const kept = stripFiles(v, joinKey(key, k, false), files);
            if (kept !== undefined) out[k] = kept;
        }
        return out;
    }
    return value;
}

// Encode a multipart body per `nesting` (ADR 0005 Decision 6). Default 'bracket'.
function encodeMultipart(
    form: FormData,
    body: Record<string, unknown>,
    nesting: MultipartNesting,
): void {
    if (nesting === 'none') {
        for (const [k, v] of Object.entries(body)) appendForm(form, k, v);
        return;
    }
    if (nesting === 'json') {
        const files: [string, unknown][] = [];
        const json = stripFiles(body, '', files);
        // One JSON part (the `payload` field) carries all non-file data; each hoisted file
        // rides as a binary part keyed by its bracket path so the server can correlate it.
        form.append('payload', JSON.stringify(json));
        for (const [k, v] of files) appendFilePart(form, k, v);
        return;
    }
    const dot = nesting === 'dot';
    for (const [k, v] of Object.entries(body)) flattenInto(form, v, k, dot);
}
