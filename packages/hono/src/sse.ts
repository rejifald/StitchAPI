// `streamStitchSse`: stream a stitch's `.stream()` output to the client as Server-Sent Events
// (adapts @stitchapi/nest's `stitchSse` to Hono's `streamSSE`). A streaming/SSE stitch's `.stream()`
// is an `AsyncIterable<StitchEvent>`; this forwards each `delta` chunk as one SSE message, ends the
// stream cleanly on `done`, and turns an `error` event into a final `error`-typed message. When the
// client disconnects, Hono aborts the response — the helper calls the iterator's `return()` so the
// upstream stitch stream is torn down rather than left running.
//
// Edge-safe: built entirely on Hono's `streamSSE` (Fetch/Web Streams) — no `node:*`.
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEMessage, SSEStreamingApi } from 'hono/streaming';
import type { StitchEvent } from 'stitchapi';

/** Anything `streamStitchSse` can drive: a stitch `.stream()` generator, or any event iterable. */
export type StitchEventSource<T> =
    | AsyncIterable<StitchEvent<T>>
    | AsyncGenerator<StitchEvent<T>, void>;

export interface StreamStitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE message `data` string. The default JSON-stringifies the chunk
     * (a string chunk is sent verbatim). Pull text out of a structured chunk with, e.g.,
     * `data: (c) => c.choices[0].delta.content ?? ''`.
     */
    data?: (chunk: unknown) => string;
    /**
     * The SSE `event:` field for each delta message (default none). Set it to label the stream's
     * messages on the client (`event: 'token'`).
     */
    event?: string;
    /**
     * Called once if the underlying stream errors (a stitch `error` event, or a throw). After it
     * runs, an `error`-typed SSE message carrying the error text is written and the stream closes.
     */
    onError?: (err: unknown) => void;
}

function defaultData(chunk: unknown): string {
    return typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
}

/**
 * Stream a stitch's events to the client as SSE. Returns the `Response` produced by Hono's
 * `streamSSE`, so a handler is one line:
 *
 * ```ts
 * import { sseSurface } from 'stitchapi/sse';
 *
 * app.get('/chat', (c) => {
 *   const completion = c.get('stitch').stitch({ kind: sseSurface, path: '/v1/messages' });
 *   return streamStitchSse(c, completion.stream({ body: { prompt: c.req.query('q') } }), {
 *     data: (chunk: any) => chunk.data,
 *   });
 * });
 * ```
 *
 * Each `delta` becomes a `data:` message; a terminal `error` event (or a throw) becomes a final
 * `event: error` message and ends the stream; every control event (`start`/`progress`/`result`/
 * `done`/…) is consumed but not forwarded. On client disconnect the upstream iterator is
 * `return()`-ed so the stitch stream is aborted.
 */
export function streamStitchSse<T>(
    c: Context,
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const toData = options.data ?? defaultData;
    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const iterator = source[Symbol.asyncIterator]();
        // Client disconnect: stop pulling and tear down the upstream stitch stream.
        stream.onAbort(() => {
            void iterator.return?.(undefined);
        });
        try {
            while (true) {
                const { value: event, done } = await iterator.next();
                if (done) break;
                if (event.type === 'delta') {
                    const message: SSEMessage = { data: toData(event.chunk) };
                    if (options.event !== undefined)
                        message.event = options.event;
                    await stream.writeSSE(message);
                } else if (event.type === 'error') {
                    options.onError?.(new Error(event.message));
                    await stream.writeSSE({
                        event: 'error',
                        data: event.message,
                    });
                    return;
                }
                // start / progress / info / drift / result / done are control signals: not forwarded.
            }
        } catch (err) {
            options.onError?.(err);
            await stream.writeSSE({
                event: 'error',
                data: err instanceof Error ? err.message : String(err),
            });
        } finally {
            await iterator.return?.(undefined);
        }
    });
}
