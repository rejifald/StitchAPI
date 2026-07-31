// `streamStitchSse`: stream a stitch's `.stream()` output to the client as Server-Sent Events
// (adapts @stitchapi/nest's `stitchSse` to Hono's `streamSSE`). A streaming/SSE stitch's `.stream()`
// is an `AsyncIterable<StitchEvent>`; this forwards each `delta` chunk as one SSE message, ends the
// stream cleanly on `done`, and turns an `error` event into a final `error`-typed message. When the
// client disconnects, Hono aborts the response — the helper calls the iterator's `return()` so the
// upstream stitch stream is torn down rather than left running.
//
// The frame types, the `delta`/`error` shorthand folds, and the secure-by-default error framing are
// shared with every other HTTP adapter via `stitchapi/sse-emit`; this file keeps only Hono's driver.
//
// Edge-safe: built entirely on Hono's `streamSSE` (Fetch/Web Streams) — no `node:*`.
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEMessage, SSEStreamingApi } from 'hono/streaming';
import {
    DEFAULT_ERROR_DATA,
    type SseEmitOptions,
    type StitchErrorEvent,
    type StitchEventSource,
    defaultData,
    resolveDelta,
    resolveError,
    toErrorEvent,
    toIterable,
} from 'stitchapi/sse-emit';

export type { StitchEventSource };

/** How each `delta` / terminal `error` becomes an SSE message (see {@link SseEmitOptions}). */
export type StreamStitchSseOptions = SseEmitOptions;

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
 *     delta: (chunk: any) => chunk.data,
 *   });
 * });
 * ```
 *
 * Each `delta` becomes a `data:` message; a terminal `error` event (or a throw) becomes a final
 * `event: error` message and ends the stream — a generic `data: error` by default, the raw message
 * withheld to avoid disclosing internal topology (opt in via `error`); every control event
 * (`start`/`progress`/`result`/`done`/…) is consumed but not forwarded. On client disconnect the
 * upstream iterator is `return()`-ed so the stitch stream is aborted.
 */
export function streamStitchSse<T>(
    c: Context,
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
    const toData = delta.data ?? defaultData;
    const errorEvent = error.event ?? 'error';
    // Core's `StitchEventSource` admits the iterable itself or a `{ stream() }` holder (a
    // `StitchResult`, a stitch stub) — unwrap the holder once, up front.
    const iterable = toIterable(source);
    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const iterator = iterable[Symbol.asyncIterator]();
        let index = 0;
        // Write the terminal `error` message: a generic token by default so a raw message
        // (`getaddrinfo ENOTFOUND …` / `HTTP 401`) is never disclosed; `error.data` opts in.
        const writeErrorFrame = (event: StitchErrorEvent): Promise<void> =>
            stream.writeSSE({
                event: errorEvent,
                data: error.data ? error.data(event) : DEFAULT_ERROR_DATA,
            });
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
                    if (delta.event !== undefined) message.event = delta.event;
                    if (delta.id) message.id = delta.id(event.chunk, index);
                    index += 1;
                    await stream.writeSSE(message);
                } else if (event.type === 'error') {
                    // `error.observe` gets the real failure server-side; the client frame is shaped
                    // by `error.data` (generic by default), never the raw `event.message`.
                    error.observe?.(new Error(event.message));
                    await writeErrorFrame(event);
                    return;
                }
                // start / progress / info / drift / result / done are control signals: not forwarded.
            }
        } catch (err) {
            // A throw (not a surfaced `error` event): still withhold the raw message by default —
            // normalise it to an error event so an `error.data` opt-in sees a consistent shape.
            error.observe?.(err);
            await writeErrorFrame(toErrorEvent(err));
        } finally {
            await iterator.return?.(undefined);
        }
    });
}
