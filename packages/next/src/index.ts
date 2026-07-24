// @stitchapi/next — Next.js helpers for StitchAPI.
//
// Next App Router route handlers are Web-standard: they take a `Request` and return
// a `Response`. So a stitch already runs in one directly — `const api = seam(...)`,
// then call it in the handler. What's worth a helper is the two bits you'd otherwise
// hand-roll on the Web platform:
//
// - `streamStitchSse(stitch.stream())` — turn a streaming stitch into a `text/event-stream`
//   `Response` (the Web-standard twin of `@stitchapi/express`'s `streamStitchSse`,
//   which targets a Node `ServerResponse`).
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

// The canonical event-source intake, from the core barrel: the event iterable itself (a `.stream()`
// generator), or anything that hands one back (a `StitchResult`, a stitch stub).
export type { StitchEventSource } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

/** Shape a `delta` chunk into the SSE frame `data`. */
type DeltaShaper = (chunk: unknown) => string;
/** Shape a terminal `error` event into the SSE frame `data`. */
type ErrorShaper = (event: StitchErrorEvent) => string;

// How each `delta` becomes a frame. The bare {@link DeltaShaper} form (`delta: (c) => …`) is
// shorthand for `{ data: (c) => … }`.
interface DeltaFrameOptions {
    /**
     * Map a `delta` chunk to the SSE frame `data`. Default: the chunk itself (a
     * string as-is; anything else `JSON.stringify`-ed). Pull text out of a structured
     * chunk with, e.g., `(c) => c.choices[0].delta.content`.
     */
    data?: DeltaShaper;
    /** Emit an `event:` line per frame (the SSE event name). Default: unnamed. */
    event?: string;
    /** Provide an `id:` line per frame (the SSE last-event id), for resumable streams. */
    id?: (chunk: unknown, index: number) => string;
}

// How the terminal `error` becomes the final frame. The bare {@link ErrorShaper} form
// (`error: (e) => …`) is shorthand for `{ data: (e) => … }`.
interface ErrorFrameOptions {
    /**
     * Shape the SSE `data` written for the terminal `error` event (or an uncaught throw
     * mid-stream, normalised to an error event). **Default: a generic token (`data: error`)**
     * — the raw `event.message` is deliberately *not* echoed, because it can disclose internal
     * network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to
     * an untrusted client. Opt in with `(e) => e.message` when the upstream messages are known
     * safe, or return your own payload (e.g. `() => JSON.stringify({ error: 'stream failed' })`).
     * A multi-line return gets one `data:` line each (SSE spec).
     */
    data?: ErrorShaper;
    /** The `event:` name of the terminal error frame. Default `'error'`. */
    event?: string;
    /**
     * Observe the real, server-side failure (a stitch `error` event, or a throw) — use it to
     * log/trace. It does **not** shape the client frame: what the client receives is controlled
     * by {@link ErrorFrameOptions.data} (a generic token by default), so the raw message reaches
     * your logs here but never the client.
     */
    observe?: (err: unknown) => void;
}

export interface StreamStitchSseOptions {
    /**
     * How each `delta` becomes a frame. Pass a **function** as shorthand for `{ data }`
     * (`delta: (c) => c.text`), or the full `{ data, event, id }` object to set the SSE
     * `event:` / `id:` lines too.
     */
    delta?: DeltaShaper | DeltaFrameOptions;
    /**
     * How the terminal error becomes the final frame. Pass a **function** as shorthand for
     * `{ data }` (`error: (e) => e.message`), or the full `{ data, event, observe }` object. By
     * default the client gets a generic `data: error` token — the raw message is withheld to
     * avoid disclosing internal topology.
     */
    error?: ErrorShaper | ErrorFrameOptions;
    /** Extra response headers (merged over the SSE defaults). */
    headers?: Record<string, string>;
    /** Abort the upstream iterator when this fires — pass the route handler's
     * `request.signal` so a client disconnect tears the stitch down. */
    signal?: AbortSignal;
}

// Expand the function-shorthand form of each frame option to its full config object.
const asDelta = (o: DeltaShaper | DeltaFrameOptions = {}): DeltaFrameOptions =>
    typeof o === 'function' ? { data: o } : o;
const asError = (o: ErrorShaper | ErrorFrameOptions = {}): ErrorFrameOptions =>
    typeof o === 'function' ? { data: o } : o;

// One delta chunk → an SSE frame. A multi-line payload is split so every line gets
// its own `data:` prefix (the SSE spec joins them with `\n`); the frame ends blank.
function frame(
    chunk: unknown,
    index: number,
    delta: DeltaFrameOptions,
): string {
    const payload = delta.data
        ? delta.data(chunk)
        : typeof chunk === 'string'
          ? chunk
          : JSON.stringify(chunk);
    let out = '';
    if (delta.event) out += `event: ${delta.event}\n`;
    if (delta.id) out += `id: ${delta.id(chunk, index)}\n`;
    for (const line of payload.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// The generic token written as an `error` frame's `data` by default: the raw upstream message
// is withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
// (`HTTP 401`) never reaches the client. Override with `error.data`.
const DEFAULT_ERROR_DATA = 'error';

// The terminal `error` frame: the (configurable, default `error`) event name plus a
// (multi-line-safe) data payload — every line of `data` gets its own `data:` prefix so a
// multi-line opt-in payload can't break the SSE framing.
function errorFrame(data: string, event: string): string {
    let out = `event: ${event}\n`;
    for (const line of data.split('\n')) out += `data: ${line}\n`;
    return `${out}\n`;
}

// Normalise a thrown value into the terminal `error` event shape, so an `error.data` opt-in sees
// a consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — an `error.data` hook keys off `name`/`message`.
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

// Resolve the canonical intake to the event iterable itself: a `.stream()`-bearing source (a
// `StitchResult`, a stitch stub) is asked for its stream; an iterable is used as-is.
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
 * opt in via `error`); the terminal `result`/`done` closes it.
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { streamStitchSse } from '@stitchapi/next';
 *
 * export async function POST(request: Request) {
 *     const { prompt } = await request.json();
 *     return streamStitchSse(chat({ body: { prompt } }).stream(), {
 *         delta: (c) => String(c),
 *         signal: request.signal, // abort the upstream if the client leaves
 *     });
 * }
 * ```
 */
export function streamStitchSse<T>(
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const delta = asDelta(options.delta);
    const error = asError(options.error);
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const event of toIterable(source)) {
                    if (options.signal?.aborted) break;
                    if (event.type === 'delta') {
                        controller.enqueue(
                            encoder.encode(frame(event.chunk, index++, delta)),
                        );
                    } else if (event.type === 'error') {
                        // Surface the failure as a named `error` frame, then stop — but by default
                        // write a generic token, never the raw `event.message`, so an internal
                        // hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`)
                        // is not disclosed. Opt in via `error.data`; `error.observe` sees the real
                        // failure server-side.
                        error.observe?.(new Error(event.message));
                        controller.enqueue(
                            encoder.encode(
                                errorFrame(
                                    error.data
                                        ? error.data(event)
                                        : DEFAULT_ERROR_DATA,
                                    error.event ?? 'error',
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
                // default — normalise it to an error event so an `error.data` opt-in sees a
                // consistent shape.
                error.observe?.(reason);
                controller.enqueue(
                    encoder.encode(
                        errorFrame(
                            error.data
                                ? error.data(toErrorEvent(reason))
                                : DEFAULT_ERROR_DATA,
                            error.event ?? 'error',
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

export interface StitchErrorOptions {
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
 * Map a thrown `StitchError` to a JSON `Response`, or `undefined` when `err` is not a Stitch
 * error — so the caller can rethrow / fall through with `?? throw err`. Use it in a route
 * handler's `catch`:
 *
 * ```ts
 * try {
 *     return Response.json(await getUser({ params: { id } }));
 * } catch (err) {
 *     const mapped = stitchErrorResponse(err);
 *     if (mapped) return mapped; // undefined → not a StitchError
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
    const status =
        typeof options.status === 'function'
            ? options.status(err)
            : (options.status ?? 502);
    const body = options.body
        ? options.body(err, status)
        : { error: STATUS_TEXT[status] ?? 'Error' };
    return Response.json(body, { status });
}
