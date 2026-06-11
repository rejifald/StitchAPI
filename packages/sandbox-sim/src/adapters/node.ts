/**
 * S5 — Node fetch-shim adapter.
 *
 * Functionally equivalent to adapters/browser.ts — both export `createFetchShim`
 * backed by the same dispatch core. The implementation is structurally identical
 * because Node 18+ ships the same WHATWG `URL`, `Headers`, `Response`, and
 * `ReadableStream` globals as the browser Worker environment.
 *
 * If a future Node-only surface needs a divergent body reader (e.g. `Buffer`,
 * `node:stream` `Readable`) this is the file to specialise. For now the two
 * adapters are effectively identical; a note is included in the S5 report as
 * required by the spec.
 *
 * Environment assumptions: Node 18+ with `--experimental-fetch` (default on)
 * or Node 21+ where the fetch globals are stable.
 */
import type {
    SimHandler,
    SimRequest,
} from '../../../../docs/sandbox/contracts/sim';
import { dispatch } from '../dispatch';

/** Build a SimRequest from the raw fetch arguments. */
async function toSimRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<SimRequest> {
    const url =
        typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL((input as Request).url);

    const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');

    const rawHeaders =
        init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers =
        rawHeaders instanceof Headers
            ? rawHeaders
            : new Headers(rawHeaders as HeadersInit | undefined);

    let body: unknown;
    const rawBody =
        init?.body ?? (input instanceof Request ? input.body : undefined);
    if (rawBody !== undefined && rawBody !== null) {
        if (typeof rawBody === 'string') {
            try {
                body = JSON.parse(rawBody);
            } catch {
                body = rawBody;
            }
        } else if (rawBody instanceof ReadableStream) {
            const reader = (rawBody as ReadableStream<Uint8Array>).getReader();
            const chunks: Uint8Array[] = [];
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
            }
            const text = new TextDecoder().decode(
                chunks.reduce((a, b) => {
                    const c = new Uint8Array(a.length + b.length);
                    c.set(a);
                    c.set(b, a.length);
                    return c;
                }, new Uint8Array(0)),
            );
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        } else {
            body = rawBody;
        }
    }

    return { method: method.toUpperCase(), url, headers, body };
}

/** Convert a SimResponse to a WHATWG Response. */
function toResponse(
    simRes: ReturnType<typeof dispatch> extends Promise<infer R> ? R : never,
): Response {
    const { status, headers: simHeaders, body, stream } = simRes;

    const responseHeaders = new Headers(simHeaders);

    if (stream !== undefined) {
        const readable = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for await (const chunk of stream!) {
                        controller.enqueue(chunk);
                    }
                    controller.close();
                } catch (err) {
                    controller.error(err);
                }
            },
        });
        return new Response(readable, { status, headers: responseHeaders });
    }

    const bodyText =
        body === undefined || body === null
            ? ''
            : typeof body === 'string'
              ? body
              : JSON.stringify(body);

    return new Response(bodyText || null, { status, headers: responseHeaders });
}

/**
 * Creates a `fetch`-shaped function backed entirely by the sandbox-sim dispatch.
 * Inject this into the Node isolate scope in place of the real `fetch`.
 */
export function createFetchShim(
    handlers: SimHandler[],
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async function sandboxFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const simReq = await toSimRequest(input, init);
        const simRes = await dispatch(handlers, simReq);
        return toResponse(simRes);
    };
}
