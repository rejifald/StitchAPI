/**
 * S5 — Browser fetch-shim adapter.
 *
 * Returns a function with the WHATWG `fetch(input, init?)` signature, backed
 * entirely by the sandbox-sim dispatch core. No real network is ever opened;
 * an unknown host/route returns the sandbox-404 response.
 *
 * Designed for injection into a Web Worker's scope:
 *   self.fetch = createFetchShim(handlers);
 *
 * Environment assumptions: WHATWG `URL`, `Headers`, `Response`, `ReadableStream`,
 * and `TextEncoder` are available as globals (true in all modern Workers).
 */
import type {
    SimHandler,
    SimRequest,
} from '../../../../docs/playground/contracts/sim';
import { dispatch } from '../dispatch';

/** Build a SimRequest from the raw fetch arguments. */
async function toSimRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<SimRequest> {
    // Normalise URL.
    const url =
        typeof input === 'string'
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL((input as Request).url);

    // Normalise method.
    const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');

    // Normalise headers.
    const rawHeaders =
        init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers =
        rawHeaders instanceof Headers
            ? rawHeaders
            : new Headers(rawHeaders as HeadersInit | undefined);

    // Parse body — best-effort: try JSON, fall back to text, ignore errors.
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
            // Consume the stream into text then attempt JSON parse.
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
        // Pipe the AsyncIterable into a ReadableStream.
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

    // Non-streaming: serialise body to JSON (or text if already a string).
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
 * Inject this into the Worker scope in place of the real `fetch`.
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
