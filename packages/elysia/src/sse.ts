// `streamStitchSse`: stream a stitch's `.stream()` output to the client as Server-Sent Events
// (mirrors @stitchapi/hono's sse.ts, adapted to Elysia's Web-standard return model). A streaming/SSE
// stitch's `.stream()` is an `AsyncIterable<StitchEvent>`; this forwards each `delta` chunk as one
// SSE message, ends the stream cleanly on `done`, and turns an `error` event into a final
// `event: error` message — a generic `data: error` by default, the raw message withheld (opt in via
// `error`). When the client disconnects the `ReadableStream` is cancelled — the helper
// calls the iterator's `return()` so the upstream stitch stream is torn down rather than left running.
//
// The frame types, the `delta`/`error` shorthand folds, the SSE wire serializer, and the
// secure-by-default error framing are shared with every other HTTP adapter via
// `stitchapi/sse-emit`; this file keeps only Elysia's `ReadableStream` driver.
//
// Web-standard: returns a plain `Response` whose body is a `ReadableStream` — no `node:*`, so it runs
// under Bun, Node, Deno and the edge alike. Return it straight from an Elysia handler.
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

export type { StitchEventSource };

/** How each `delta` / terminal `error` becomes an SSE message (see {@link SseEmitOptions}). */
export type StreamStitchSseOptions = SseEmitOptions;

/**
 * Stream a stitch's events to the client as SSE. Returns a Web-standard {@link Response} with a
 * `text/event-stream` body, so an Elysia handler is one line:
 *
 * ```ts
 * import { sseSurface } from 'stitchapi/sse';
 *
 * app.get('/chat', ({ stitch, query }) => {
 *   const completion = stitch.stitch({ kind: sseSurface, path: '/v1/messages' });
 *   return streamStitchSse(completion.stream({ body: { prompt: query.q } }), {
 *     delta: (chunk: any) => chunk.data,
 *   });
 * });
 * ```
 *
 * Each `delta` becomes a `data:` message; a terminal `error` event (or a throw) becomes a final
 * `event: error` message and ends the stream — a generic `data: error` by default, the raw message
 * withheld to avoid disclosing internal topology (opt in via `error`); every control event
 * (`start`/`progress`/`result`/`done`/…) is consumed but not forwarded. On client disconnect the
 * stream is cancelled and the upstream iterator is `return()`-ed so the stitch stream is aborted.
 */
export function streamStitchSse<T>(
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
    const errorEvent = error.event ?? 'error';
    const enc = new TextEncoder();
    const iterator = source[Symbol.asyncIterator]();
    let index = 0;

    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                while (true) {
                    const { value: event, done } = await iterator.next();
                    if (done) {
                        controller.close();
                        return;
                    }
                    if (event.type === 'delta') {
                        controller.enqueue(
                            enc.encode(deltaFrame(event.chunk, index, delta)),
                        );
                        index += 1;
                        return; // one frame per pull → precise back-pressure
                    }
                    if (event.type === 'error') {
                        // `error.observe` gets the real failure server-side; the client frame is a
                        // generic token by default (never the raw `event.message`) — `error.data`
                        // opts in.
                        error.observe?.(new Error(event.message));
                        controller.enqueue(
                            enc.encode(
                                sseFrame(
                                    error.data
                                        ? error.data(event)
                                        : DEFAULT_ERROR_DATA,
                                    errorEvent,
                                ),
                            ),
                        );
                        controller.close();
                        await iterator.return?.(undefined);
                        return;
                    }
                    // start / progress / info / drift / result / done are control signals: skipped,
                    // loop on to the next event without emitting a frame.
                }
            } catch (err) {
                // A throw (not a surfaced `error` event): still withhold the raw message by
                // default — normalise it to an error event so `error.data` sees a consistent shape.
                error.observe?.(err);
                controller.enqueue(
                    enc.encode(
                        sseFrame(
                            error.data
                                ? error.data(toErrorEvent(err))
                                : DEFAULT_ERROR_DATA,
                            errorEvent,
                        ),
                    ),
                );
                controller.close();
                await iterator.return?.(undefined);
            }
        },
        // Client disconnect: tear down the upstream stitch stream.
        async cancel() {
            await iterator.return?.(undefined);
        },
    });

    return new Response(body, {
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
        },
    });
}
