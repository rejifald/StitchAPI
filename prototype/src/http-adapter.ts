import type { Adapter, AdapterRequest, AdapterResponse } from './types';

// Returns an Adapter backed by Node's global `fetch`. Never throws on non-2xx —
// only network/abort errors propagate; the engine decides what to do with the response.
export function fetchAdapter(): Adapter {
    return async function fetchAdapterRequest(req: AdapterRequest): Promise<AdapterResponse> {
        const method = req.method.toUpperCase();
        const headers: Record<string, string> = { ...req.headers };

        // Body handling: never send a body for GET/HEAD.
        let body: string | undefined;
        const noBodyMethod = method === 'GET' || method === 'HEAD';
        if (!noBodyMethod && req.body !== undefined && req.body !== null) {
            if (typeof req.body === 'string') {
                body = req.body;
            } else {
                body = JSON.stringify(req.body);
                const hasContentType = Object.keys(headers).some(
                    (k) => k.toLowerCase() === 'content-type',
                );
                if (!hasContentType) {
                    headers['content-type'] = 'application/json';
                }
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
        const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
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
        const isJson = contentType.includes('application/json') || contentType.includes('+json');
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
