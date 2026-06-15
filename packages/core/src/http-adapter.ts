import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    MultipartNesting,
    ResponseType,
} from './types';

// Returns an Adapter backed by Node's global `fetch`. Never throws on non-2xx —
// only network/abort errors propagate; the engine decides what to do with the response.
export function fetchAdapter(): Adapter {
    return async function fetchAdapterRequest(
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

        // Send the request. Network/abort errors propagate to the caller.
        const response = await fetch(req.url, {
            method,
            headers,
            ...(body !== undefined ? { body } : {}),
            ...(req.signal ? { signal: req.signal } : {}),
        });

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

        return { status: response.status, headers: resHeaders, body: parsed };
    };
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

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
// { value, filename?, type? } wrapper. Anything else is a scalar field.
function isFileLeaf(v: unknown): boolean {
    return (
        v instanceof Blob ||
        v instanceof Uint8Array ||
        (typeof v === 'object' &&
            v !== null &&
            'value' in (v as Record<string, unknown>))
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
