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

/**
 * Stream a stitch's events as a `text/event-stream` `Response`. Each `delta` becomes
 * one frame; an `error` event ends the stream with a named `event: error` frame; the
 * terminal `result`/`done` closes it.
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
                        controller.enqueue(
                            encoder.encode(
                                `event: error\ndata: ${JSON.stringify({
                                    name: event.name,
                                    message: event.message,
                                    ...(event.status !== undefined
                                        ? { status: event.status }
                                        : {}),
                                })}\n\n`,
                            ),
                        );
                        break;
                    }
                    // 'result' / 'done' / 'start' / 'progress' → not framed; the stream
                    // ends when the iterator does.
                }
            } catch (reason) {
                controller.enqueue(
                    encoder.encode(
                        `event: error\ndata: ${JSON.stringify({
                            message:
                                reason instanceof Error
                                    ? reason.message
                                    : String(reason),
                        })}\n\n`,
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
export type StitchError = Error & { status?: number };

/** True when `err` is the error a stitch throws on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchError {
    return err instanceof Error && err.name === 'StitchError';
}

export interface ErrorResponseOptions {
    /**
     * The HTTP status for the mapped failure. Default `502` for a `StitchError` (an
     * upstream gateway failure) and `500` otherwise — the safe default never leaks an
     * upstream's `401`/`404` semantics to your client. Override with a number, or a
     * function: propagate the upstream status with `(e) => e.status ?? 502`.
     */
    status?: number | ((err: StitchError) => number);
    /** Shape the JSON body. Default `{ error: err.message }`. */
    body?: (err: StitchError, status: number) => unknown;
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
 */
export function stitchErrorResponse(
    err: unknown,
    options: ErrorResponseOptions = {},
): Response {
    const e: StitchError = err instanceof Error ? err : new Error(String(err));
    const fallback = isStitchError(err) ? 502 : 500;
    const status =
        typeof options.status === 'function'
            ? options.status(e)
            : (options.status ?? fallback);
    const body = options.body ? options.body(e, status) : { error: e.message };
    return Response.json(body, { status });
}
