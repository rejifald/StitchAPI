// @stitchapi/next — Next.js helpers for StitchAPI.
//
// Next App Router route handlers are Web-standard: they take a `Request` and return
// a `Response`. So a stitch already runs in one directly — `const api = seam(...)`,
// then call it in the handler. What's worth a helper is the two bits you'd otherwise
// hand-roll on the Web platform:
//
// - `sseResponse(stitch.stream())` — turn a streaming stitch into a `text/event-stream`
//   `Response` (the Web-standard twin of `@stitchapi/express`'s `streamStitchSse`,
//   which targets a Node `ServerResponse`).
// - `stitchErrorResponse(err)` — map a thrown `StitchError` to a `Response` with a
//   safe status (default 502), so a route handler needs no bespoke error shaping.
//
// Built on Web standards (`Response`, `ReadableStream`, `TextEncoder`) only — no
// `next` import — so the same helpers work in Next route handlers, Remix, SvelteKit
// endpoints, Bun, Deno, and Workers. `stitchapi` is the only peer dependency.
import type { StitchEvent } from 'stitchapi';

// ---------------------------------------------------------------------------
// SSE Response
// ---------------------------------------------------------------------------

/** Anything `sseResponse` can drive: a stitch `.stream()` generator, or any event
 * iterable. */
export type StitchEventSource<T> =
    | AsyncIterable<StitchEvent<T>>
    | AsyncGenerator<StitchEvent<T>, void>;

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

export interface SseResponseOptions {
    /**
     * Map a `delta` chunk to the SSE frame `data`. Default: the chunk itself (a
     * string as-is; anything else `JSON.stringify`-ed). Use it to pull text out of a
     * structured chunk, e.g. `data: (c) => c.choices[0].delta.content`.
     */
    data?: (chunk: unknown) => string;
    /** Emit an `event:` line per frame (the SSE event name). Default: unnamed. */
    event?: string;
    /** Provide an `id:` line per frame (the SSE last-event id), for resumable streams. */
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
    payload?: (event: StitchErrorEvent) => string;
    /** Extra response headers (merged over the SSE defaults). */
    headers?: Record<string, string>;
    /** Abort the upstream iterator when this fires — pass the route handler's
     * `request.signal` so a client disconnect tears the stitch down. */
    signal?: AbortSignal;
}

// One delta chunk → an SSE frame. A multi-line payload is split so every line gets
// its own `data:` prefix (the SSE spec joins them with `\n`); the frame ends blank.
function frame(
    chunk: unknown,
    index: number,
    options: SseResponseOptions,
): string {
    const payload = options.data
        ? options.data(chunk)
        : typeof chunk === 'string'
          ? chunk
          : JSON.stringify(chunk);
    let out = '';
    if (options.event) out += `event: ${options.event}\n`;
    if (options.id) out += `id: ${options.id(chunk, index)}\n`;
    for (const line of payload.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// The generic token written as an `error` frame's `data` by default: the raw upstream message
// is withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
// (`HTTP 401`) never reaches the client. Override with `options.payload`.
const DEFAULT_PAYLOAD = 'error';

// The terminal `error` frame: the fixed `event: error` name plus a (multi-line-safe) data
// payload — every line of `data` gets its own `data:` prefix so a multi-line opt-in payload
// can't break the SSE framing.
function errorFrame(data: string): string {
    let out = 'event: error\n';
    for (const line of data.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// Normalise a thrown value into the terminal `error` event shape, so a `payload` opt-in sees
// a consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — a `payload` hook keys off `name`/`message`.
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

/**
 * Stream a stitch's events as a `text/event-stream` `Response`. Each `delta` becomes
 * one frame; an `error` event ends the stream with a named `event: error` frame (a generic
 * `data: error` by default — the raw message is withheld to avoid disclosing internal topology;
 * opt in via `payload`); the terminal `result`/`done` closes it.
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { sseResponse } from '@stitchapi/next';
 *
 * export async function POST(request: Request) {
 *     const { prompt } = await request.json();
 *     return sseResponse(chat({ body: { prompt } }).stream(), {
 *         data: (c) => String(c),
 *         signal: request.signal, // abort the upstream if the client leaves
 *     });
 * }
 * ```
 */
export function sseResponse<T>(
    source: StitchEventSource<T>,
    options: SseResponseOptions = {},
): Response {
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const event of source) {
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
                        // is not disclosed. Opt in to the real message via `options.payload`.
                        controller.enqueue(
                            encoder.encode(
                                errorFrame(
                                    options.payload
                                        ? options.payload(event)
                                        : DEFAULT_PAYLOAD,
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
                // default — normalise it to an error event so a `payload` opt-in sees a
                // consistent shape.
                controller.enqueue(
                    encoder.encode(
                        errorFrame(
                            options.payload
                                ? options.payload(toErrorEvent(reason))
                                : DEFAULT_PAYLOAD,
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

/** The error a stitch throws on failure: a branded `Error` with the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/** True when `err` is the error a stitch throws on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

// A small map of the statuses this helper emits → their generic reason phrase, used for
// the default body so the raw error message is never echoed to the client.
const STATUS_TEXT: Record<number, string> = {
    500: 'Internal Server Error',
    502: 'Bad Gateway',
};

export interface ErrorResponseOptions {
    /**
     * The HTTP status for the mapped failure. Default `502` for a `StitchError` (an
     * upstream gateway failure) and `500` otherwise — the safe default never leaks an
     * upstream's `401`/`404` semantics to your client. Override with a number, or a
     * function: propagate the upstream status with `(e) => e.status ?? 502`.
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * Shape the JSON body. **Default: a generic, status-tied message**
     * (`{ error: 'Bad Gateway' }`) — the raw `err.message` is deliberately *not* echoed,
     * because it can disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`)
     * to an untrusted client. Provide this to shape the body yourself; pass
     * `(e) => ({ error: e.message })` to opt in to the raw message when the upstream
     * messages are known to be safe to expose.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

/**
 * Map a thrown error to a JSON `Response`. Use it in a route handler's `catch`:
 *
 * ```ts
 * try {
 *     return Response.json(await getUser({ params: { id } }));
 * } catch (err) {
 *     if (isStitchError(err)) return stitchErrorResponse(err);
 *     throw err;
 * }
 * ```
 *
 * The default body is a generic, status-tied message (`{ error: 'Bad Gateway' }`) — the
 * raw `err.message` is **not** echoed, since it can leak internal hostnames or the
 * upstream's status to an untrusted client. Opt in to a custom (or the raw) message with
 * {@link ErrorResponseOptions.body}.
 */
export function stitchErrorResponse(
    err: unknown,
    options: ErrorResponseOptions = {},
): Response {
    const e: StitchErrorLike =
        err instanceof Error ? err : new Error(String(err));
    const fallback = isStitchError(err) ? 502 : 500;
    const status =
        typeof options.status === 'function'
            ? options.status(e)
            : (options.status ?? fallback);
    const body = options.body
        ? options.body(e, status)
        : { error: STATUS_TEXT[status] ?? 'Error' };
    return Response.json(body, { status });
}
