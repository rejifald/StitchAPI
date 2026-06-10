import type { Adapter, AdapterRequest, AdapterResponse } from './types';

// Returns an Adapter backed by Node's global `fetch`. Never throws on non-2xx —
// only network/abort errors propagate; the engine decides what to do with the response.
export function fetchAdapter(): Adapter {
    return async function fetchAdapterRequest(
        req: AdapterRequest,
    ): Promise<AdapterResponse> {
        const method = req.method.toUpperCase();
        const headers: Record<string, string> = { ...req.headers };

        // Body encoding: never send a body for GET/HEAD. Encode per req.bodyType
        // (default 'json'): 'form' -> x-www-form-urlencoded, 'multipart' -> FormData.
        let body: string | FormData | undefined;
        const noBodyMethod = method === 'GET' || method === 'HEAD';
        const hasContentType = () =>
            Object.keys(headers).some(
                (k) => k.toLowerCase() === 'content-type',
            );
        if (!noBodyMethod && req.body !== undefined && req.body !== null) {
            if (typeof req.body === 'string') {
                body = req.body;
            } else if (req.bodyType === 'form') {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(
                    req.body as Record<string, unknown>,
                )) {
                    if (v !== undefined && v !== null)
                        params.append(k, String(v));
                }
                body = params.toString();
                if (!hasContentType())
                    headers['content-type'] =
                        'application/x-www-form-urlencoded';
            } else if (req.bodyType === 'multipart') {
                const form = new FormData();
                for (const [k, v] of Object.entries(
                    req.body as Record<string, unknown>,
                )) {
                    appendForm(form, k, v);
                }
                body = form; // do NOT set content-type — fetch adds the multipart boundary
            } else {
                body = JSON.stringify(req.body);
                if (!hasContentType())
                    headers['content-type'] = 'application/json';
            }
        }

        // Send the request. Network/abort errors propagate to the caller.
        const response = await fetch(req.url, {
            method,
            headers,
            body,
            signal: req.signal,
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

        // Parse the body: JSON when content-type is json-ish, else text.
        const contentType = (resHeaders['content-type'] || '').toLowerCase();
        const isJson =
            contentType.includes('application/json') ||
            contentType.includes('+json');
        let parsed: unknown;
        if (isJson) {
            const text = await response.text();
            parsed = text === '' ? undefined : JSON.parse(text);
        } else {
            parsed = await response.text();
        }

        return { status: response.status, headers: resHeaders, body: parsed };
    };
}

// Append a value to multipart FormData: a Blob/Uint8Array becomes a file part; a
// { value, filename?, type? } wrapper becomes a named file; everything else a string field.
function appendForm(form: FormData, key: string, v: unknown): void {
    if (v instanceof Blob) return void form.append(key, v);
    if (v instanceof Uint8Array) return void form.append(key, new Blob([v]));
    if (
        v &&
        typeof v === 'object' &&
        'value' in (v as Record<string, unknown>)
    ) {
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
        return;
    }
    form.append(key, String(v));
}
