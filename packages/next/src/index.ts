// @stitchapi/next — Next.js helpers for StitchAPI.
//
// Next App Router route handlers are Web-standard: they take a `Request` and return
// a `Response`. So a stitch already runs in one directly — `const api = seam(...)`,
// then call it in the handler. What's worth a helper is the two bits you'd otherwise
// hand-roll on the Web platform:
//
// - `streamStitchSse(stitch.stream())` — turn a streaming stitch into a
//   `text/event-stream` `Response` (the Web-standard twin of `@stitchapi/express`'s
//   `streamStitchSse`, which targets a Node `ServerResponse`).
// - `stitchErrorResponse(err)` — map a thrown `StitchError` to a `Response` with a
//   safe status (default 502), or `undefined` for anything else so the caller can
//   rethrow it untouched.
//
// Built on Web standards (`Response`, `ReadableStream`, `TextEncoder`) only — no
// `next` import — so the same helpers work in Next route handlers, Remix, SvelteKit
// endpoints, Bun, Deno, and Workers. `stitchapi` is the only peer dependency.
import type { StitchEvent, StitchEventSource } from 'stitchapi';

// ---------------------------------------------------------------------------
// SSE Response
// ---------------------------------------------------------------------------

/**
 * Anything `streamStitchSse` can drive: the canonical event-stream intake from the
 * `stitchapi` barrel — an event iterable (a `.stream()` generator), or anything that
 * hands one back (a `StitchResult`, a stitch stub).
 */
export type { StitchEventSource } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

export interface StreamStitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE frame `data`. Default: the chunk itself (a
     * string as-is; anything else `JSON.stringify`-ed). Use it to pull text out of a
     * structured chunk, e.g. `data: (c) => c.choices[0].delta.content`. Receives the
     * zero-based frame index alongside the chunk.
     */
    data?: (chunk: unknown, index: number) => string;
    /**
     * Emit an `event:` line per delta frame (the SSE event name): a fixed name, or a
     * function of the chunk for per-frame names. Default: none (an unnamed `message`
     * event, which `EventSource.onmessage` receives).
     */
    event?: string | ((chunk: unknown) => string);
    /**
     * Provide an `id:` line per delta frame (the SSE last-event id), e.g. for
     * resumable streams. Receives the chunk and the zero-based frame index.
     */
    id?: (chunk: unknown, index: number) => string;
    /**
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw
     * mid-stream, normalised to an error event). **Default: a generic token (`data: error`)**
     * — the raw `event.message` is deliberately *not* echoed, because it can disclose internal
     * network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to
     * an untrusted client. Opt in with `(e) => e.message` when the upstream messages are known
     * safe, or return your own payload (e.g. `() => JSON.stringify({ error: 'stream failed' })`).
     * A multi-line return gets one `data:` line each (SSE spec); the `event: error` name is fixed.
     */
    errorData?: (event: StitchErrorEvent) => string;
    /**
     * Called once, server-side, if the underlying stream errors (a stitch `error` event, or a
     * throw) — use it to observe/log the real failure. It does **not** shape the client-facing
     * frame: the SSE `data` sent to the client is controlled by `errorData` (a generic token by
     * default), so the raw message reaches your logs here but not the client.
     */
    onError?: (err: unknown) => void;
    /**
     * Extra response headers (merged over the SSE defaults). Host-specific: this helper
     * *builds* the Web `Response`, so header shaping happens here — hosts that write to a
     * live response (Express, Fastify) set headers on it directly instead.
     */
    headers?: Record<string, string>;
    /**
     * Abort the upstream iterator when this fires — pass the route handler's
     * `request.signal` so a client disconnect tears the stitch down. Host-specific:
     * Web-standard hosts signal disconnect via `AbortSignal`, where Node hosts use the
     * response's `close` event.
     */
    signal?: AbortSignal;
}

// One delta chunk → an SSE frame. A multi-line payload is split so every line gets
// its own `data:` prefix (the SSE spec joins them with `\n`); the frame ends blank.
function frame(
    chunk: unknown,
    index: number,
    options: StreamStitchSseOptions,
): string {
    const payload = options.data
        ? options.data(chunk, index)
        : typeof chunk === 'string'
          ? chunk
          : JSON.stringify(chunk);
    let out = '';
    if (options.event !== undefined) {
        const name =
            typeof options.event === 'function'
                ? options.event(chunk)
                : options.event;
        out += `event: ${name}\n`;
    }
    if (options.id) out += `id: ${options.id(chunk, index)}\n`;
    for (const line of payload.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// The generic token written as an `error` frame's `data` by default: the raw upstream message
// is withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
// (`HTTP 401`) never reaches the client. Override with `options.errorData`.
const DEFAULT_ERROR_DATA = 'error';

// The terminal `error` frame: the fixed `event: error` name plus a (multi-line-safe) data
// payload — every line of `data` gets its own `data:` prefix so a multi-line opt-in payload
// can't break the SSE framing.
function errorFrame(data: string): string {
    let out = 'event: error\n';
    for (const line of data.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// Normalise a thrown value into the terminal `error` event shape, so an `errorData` opt-in sees
// a consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — an `errorData` hook keys off `name`/`message`.
function toErrorEvent(reason: unknown): StitchErrorEvent {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    return {
        type: 'error',
        name: e.name,
        message: e.message,
        attempts: 0,
        at: 0,
    };
}

// Resolve the canonical intake to the event iterable: an iterable is used as-is; anything
// carrying a `.stream()` (a `StitchResult`, a stitch stub) hands its stream over.
function toIterable<T>(
    source: StitchEventSource<T>,
): AsyncIterable<StitchEvent<T>> {
    return typeof (source as { stream?: unknown }).stream === 'function'
        ? (source as { stream(): AsyncIterable<StitchEvent<T>> }).stream()
        : (source as AsyncIterable<StitchEvent<T>>);
}

/**
 * Stream a stitch's events as a `text/event-stream` `Response`. Each `delta` becomes
 * one frame; an `error` event ends the stream with a named `event: error` frame (a generic
 * `data: error` by default — the raw message is withheld to avoid disclosing internal topology;
 * opt in via `errorData`); the terminal `result`/`done` closes it.
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { streamStitchSse } from '@stitchapi/next';
 *
 * export async function POST(request: Request) {
 *     const { prompt } = await request.json();
 *     return streamStitchSse(chat({ body: { prompt } }).stream(), {
 *         data: (c) => String(c),
 *         signal: request.signal, // abort the upstream if the client leaves
 *     });
 * }
 * ```
 */
export function streamStitchSse<T>(
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const event of toIterable(source)) {
                    if (options.signal?.aborted) break;
                    if (event.type === 'delta') {
                        controller.enqueue(
                            encoder.encode(
                                frame(event.chunk, index++, options),
                            ),
                        );
                    } else if (event.type === 'error') {
                        // Surface the failure as a named `error` frame, then stop — but by default
                        // write a generic token, never the raw `event.message`, so an internal
                        // hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`)
                        // is not disclosed. `onError` gets the real failure server-side; opt the
                        // client in to the real message via `options.errorData`.
                        options.onError?.(new Error(event.message));
                        controller.enqueue(
                            encoder.encode(
                                errorFrame(
                                    options.errorData
                                        ? options.errorData(event)
                                        : DEFAULT_ERROR_DATA,
                                ),
                            ),
                        );
                        break;
                    }
                    // 'result' / 'done' / 'start' / 'progress' → not framed; the stream
                    // ends when the iterator does.
                }
            } catch (reason) {
                // A throw (not a surfaced `error` event): still withhold the raw message by
                // default — normalise it to an error event so an `errorData` opt-in sees a
                // consistent shape. `onError` observes the original thrown value.
                options.onError?.(reason);
                controller.enqueue(
                    encoder.encode(
                        errorFrame(
                            options.errorData
                                ? options.errorData(toErrorEvent(reason))
                                : DEFAULT_ERROR_DATA,
                        ),
                    ),
                );
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            ...options.headers,
        },
    });
}

// ---------------------------------------------------------------------------
// Error Response
// ---------------------------------------------------------------------------

/** The error a stitch rejects with on failure: a branded `Error` carrying the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/** True when `err` is the error a stitch rejects with on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

const BAD_GATEWAY = 502;

// A small map of the statuses this helper emits → their generic reason phrase, used for
// the default body so the raw error message is never echoed to the client.
const STATUS_TEXT: Record<number, string> = {
    500: 'Internal Server Error',
    502: 'Bad Gateway',
};

export interface StitchErrorOptions {
    /**
     * The HTTP status for the mapped response. Default `502 Bad Gateway` — **every** upstream
     * failure is reported as a gateway error, regardless of the upstream's own status. This is the
     * safe default: it never leaks an upstream's `401`/`404`/etc. semantics to your client. Override
     * per call — a fixed number, or a function for full control: propagate the upstream status with
     * `(e) => e.status ?? 502`, or remap specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The JSON body for a mapped failure. **Default: a generic, status-tied message**
     * (`{ error: 'Bad Gateway' }`) — the raw `err.message` is deliberately *not* echoed, because it
     * can disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to an
     * untrusted client. Override to shape your own error envelope; pass `(e) => ({ error: e.message })`
     * to opt in to the raw message when the upstream messages are known to be safe to expose.
     * Receives the mapped status alongside the error.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

/**
 * Map a thrown stitch failure to a JSON {@link Response}, or `undefined` when `err` is not a
 * Stitch error (so a caller can rethrow / fall through). The status is `502` by default; override
 * it via {@link StitchErrorOptions.status}. Use it in a route handler's `catch`:
 *
 * ```ts
 * try {
 *     return Response.json(await getUser({ params: { id } }));
 * } catch (err) {
 *     const mapped = stitchErrorResponse(err);
 *     if (mapped) return mapped; // or: return stitchErrorResponse(err) ?? throwAgain(err)
 *     throw err;
 * }
 * ```
 *
 * The default body is a generic, status-tied message (`{ error: 'Bad Gateway' }`) — the
 * raw `err.message` is **not** echoed, since it can leak internal hostnames or the
 * upstream's status to an untrusted client. Opt in to a custom (or the raw) message with
 * {@link StitchErrorOptions.body}.
 */
export function stitchErrorResponse(
    err: unknown,
    options: StitchErrorOptions = {},
): Response | undefined {
    if (!isStitchError(err)) return undefined;
    const { status = BAD_GATEWAY } = options;
    const code = typeof status === 'function' ? status(err) : status;
    // Default body is a generic, status-tied message — the raw `err.message` is deliberately
    // withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
    // (`HTTP 401`) never reaches the client. Opt in via `options.body`.
    const body = options.body
        ? options.body(err, code)
        : { error: STATUS_TEXT[code] ?? 'Error' };
    return Response.json(body, { status: code });
}
