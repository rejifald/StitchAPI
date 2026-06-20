/**
 * S5 — shared fetch-shim core.
 *
 * Returns a function with the WHATWG `fetch(input, init?)` signature, backed
 * entirely by the sandbox-sim dispatch core. No real network is ever opened; an
 * unknown host/route returns the sandbox-404 response.
 *
 * The Node (18+) and browser Worker environments expose the same WHATWG `URL`,
 * `Headers`, `Response`, `ReadableStream`, and `TextDecoder` globals, so a single
 * implementation serves both. `adapters/node.ts` and `adapters/browser.ts` remain
 * as named entry points re-exporting `createFetchShim` from here — they are the
 * documented place to specialise if a future environment ever needs a divergent
 * body reader (e.g. a Node-only `Buffer` / `node:stream` `Readable` path).
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
} from '../../../../docs/sandbox/contracts/sim';
import { dispatch } from '../dispatch';

/** Normalise the fetch `input` to a `URL` (string, `URL`, or `Request`). */
function normalizeUrl(input: RequestInfo | URL): URL {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL((input as Request).url);
}

/** Normalise the method, defaulting to `GET` and upper-casing. */
function normalizeMethod(input: RequestInfo | URL, init?: RequestInit): string {
    const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
    return method.toUpperCase();
}

/** Normalise headers from `init` or a `Request` input into a `Headers`. */
function normalizeHeaders(
    input: RequestInfo | URL,
    init?: RequestInit,
): Headers {
    const rawHeaders =
        init?.headers ?? (input instanceof Request ? input.headers : undefined);
    return rawHeaders instanceof Headers
        ? rawHeaders
        : new Headers(rawHeaders as HeadersInit | undefined);
}

/** Best-effort parse: try JSON, fall back to the raw text. */
function parseJsonOrText(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** Drain a byte stream into a decoded string. */
async function drainStream(
    stream: ReadableStream<Uint8Array>,
): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    const merged = chunks.reduce((a, b) => {
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
    }, new Uint8Array(0));
    return new TextDecoder().decode(merged);
}

/**
 * Parse the request body — best-effort: JSON when it parses, text otherwise,
 * `undefined` when absent. A `ReadableStream` is drained to text first; any
 * other value (Blob, FormData, …) is passed through untouched.
 */
async function readBody(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<unknown> {
    const rawBody =
        init?.body ?? (input instanceof Request ? input.body : undefined);
    if (rawBody === undefined || rawBody === null) return undefined;
    if (typeof rawBody === 'string') return parseJsonOrText(rawBody);
    if (rawBody instanceof ReadableStream) {
        return parseJsonOrText(
            await drainStream(rawBody as ReadableStream<Uint8Array>),
        );
    }
    return rawBody;
}

/** Build a SimRequest from the raw fetch arguments. */
async function toSimRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<SimRequest> {
    return {
        method: normalizeMethod(input, init),
        url: normalizeUrl(input),
        headers: normalizeHeaders(input, init),
        body: await readBody(input, init),
    };
}

/** Pipe a sim response's `AsyncIterable` chunks into a WHATWG `ReadableStream`. */
function streamToReadable(
    stream: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of stream) {
                    controller.enqueue(chunk);
                }
                controller.close();
            } catch (err) {
                controller.error(err);
            }
        },
    });
}

/** Convert a SimResponse to a WHATWG Response. */
function toResponse(
    simRes: ReturnType<typeof dispatch> extends Promise<infer R> ? R : never,
): Response {
    const { status, headers: simHeaders, body, stream } = simRes;
    const responseHeaders = new Headers(simHeaders);

    if (stream !== undefined) {
        return new Response(streamToReadable(stream), {
            status,
            headers: responseHeaders,
        });
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
 * Inject this into the Node isolate / Worker scope in place of the real `fetch`.
 *
 * `getDefaultKnobs` (optional) is read on EVERY call, so the host can vary the
 * baseline knobs between runs (the playground's "Response knobs" panel) without
 * rebuilding the shim. URL knobs still win — see `dispatch`.
 */
export function createFetchShim(
    handlers: SimHandler[],
    getDefaultKnobs?: () => SimKnobs | undefined,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async function sandboxFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const simReq = await toSimRequest(input, init);
        const simRes = await dispatch(handlers, simReq, getDefaultKnobs?.());
        return toResponse(simRes);
    };
}
