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
//   safe status (default 502), or `undefined` for anything else so the caller can
//   rethrow it untouched.
//
// Built on Web standards (`Response`, `ReadableStream`, `TextEncoder`) only — no
// `next` import — so the same helpers work in Next route handlers, Remix, SvelteKit
// endpoints, Bun, Deno, and Workers. `stitchapi` is the only peer dependency.
import {
    DEFAULT_ERROR_DATA,
    type SseEmitOptions,
    type StitchEventSource,
    deltaFrame,
    resolveDelta,
    resolveError,
    sseFrame,
    toErrorEvent,
} from 'stitchapi/sse-emit';

// ---------------------------------------------------------------------------
// SSE Response
// ---------------------------------------------------------------------------

// The frame types, the `delta`/`error` shorthand folds, the SSE wire serializer, and the
// secure-by-default error framing are shared with every other HTTP adapter via
// `stitchapi/sse-emit`; this file keeps only Next's Web-standard `Response` driver.
export type { StitchEventSource };

export interface SseResponseOptions extends SseEmitOptions {
    /** Extra response headers (merged over the SSE defaults). */
    headers?: Record<string, string>;
    /** Abort the upstream iterator when this fires — pass the route handler's
     * `request.signal` so a client disconnect tears the stitch down. */
    signal?: AbortSignal;
}

/**
 * Stream a stitch's events as a `text/event-stream` `Response`. Each `delta` becomes
 * one frame; an `error` event ends the stream with a named `event: error` frame (a generic
 * `data: error` by default — the raw message is withheld to avoid disclosing internal topology;
 * opt in via `error`); the terminal `result`/`done` closes it.
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { sseResponse } from '@stitchapi/next';
 *
 * export async function POST(request: Request) {
 *     const { prompt } = await request.json();
 *     return sseResponse(chat({ body: { prompt } }).stream(), {
 *         delta: (c) => String(c),
 *         signal: request.signal, // abort the upstream if the client leaves
 *     });
 * }
 * ```
 */
export function sseResponse<T>(
    source: StitchEventSource<T>,
    options: SseResponseOptions = {},
): Response {
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
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
                                deltaFrame(event.chunk, index++, delta),
                            ),
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
                                sseFrame(
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
                        sseFrame(
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
 * {@link ErrorResponseOptions.body}.
 */
export function stitchErrorResponse(
    err: unknown,
    options: ErrorResponseOptions = {},
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
