// stitch stream → Express SSE response. A stitch's `.stream()` (and a `StitchResult.stream()`) is an
// `AsyncIterable<StitchEvent>`; an SSE endpoint wants `text/event-stream` frames. This adapts the
// Fastify `sendStitchSse` bridge to Express's `res` (which is a Node `http.ServerResponse`): write
// frames straight to the socket. Each `delta` becomes one `data:` frame; an `error` event ends the
// stream with a named `event: error` frame; stream end closes it; and a client disconnect (`res` or
// `req` 'close') aborts the upstream iterator rather than leaving it running.
//
// The frame types, the `delta`/`error` shorthand folds, the SSE wire serializer, and the
// secure-by-default error framing are shared with every other HTTP adapter via
// `stitchapi/sse-emit`; this file keeps only Express's response driver.
import type { Request, Response } from 'express';
import {
    DEFAULT_ERROR_DATA,
    type SseEmitOptions,
    type StitchEventSource,
    deltaFrame,
    resolveDelta,
    resolveError,
    sseFrame,
} from 'stitchapi/sse-emit';

export type { StitchEventSource };

export interface StreamStitchSseOptions extends SseEmitOptions {
    /**
     * The Express request, when available. Express normally fires `close` on the *response* on
     * disconnect, but passing `req` lets the helper also listen on the request socket for
     * environments/proxies that signal disconnect there — either fires the upstream teardown.
     */
    req?: Request;
}

/**
 * Stream a stitch's output to an Express {@link Response} as Server-Sent Events. Pass the stitch's
 * `.stream()` generator (or any `AsyncIterable<StitchEvent>`): each `delta` becomes one SSE frame, an
 * `error` event ends the stream with a named `event: error` frame (a generic `data: error` by
 * default — the raw message is withheld to avoid disclosing internal topology; opt in via
 * `error`), and stream end closes the response. The non-output events (`start` / `progress` /
 * `drift` / `result` / `done`) are control signals and are not forwarded to the client.
 *
 * Writes raw frames straight to the socket, so do **not** also `res.send()`/`res.json()` from the
 * same handler. Resolves once the response is fully written (or the client disconnects). On
 * disconnect (`res` — or `req`, when passed — emits `close`) the upstream iterator's `return()` is
 * called so the stitch stream is aborted rather than left running.
 *
 * ```ts
 * app.get('/chat', (req, res) =>
 *   streamStitchSse(res, chat.stream({ query: { q: req.query.q } }),
 *                   { delta: (c: any) => c.text, req }),
 * );
 * ```
 */
export async function streamStitchSse<T>(
    res: Response,
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Promise<void> {
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
    if (!res.headersSent) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
        });
        // Push headers (and any buffered body) immediately so the client opens the stream without
        // waiting for the first delta. `flushHeaders` is on Node's ServerResponse.
        res.flushHeaders();
    }

    const iterator = source[Symbol.asyncIterator]();
    let active = true;

    // Client disconnect: stop consuming and abort the upstream iterator. Listen on the response and,
    // when given, the request — either signalling a closed connection tears the stitch stream down.
    const onClose = (): void => {
        active = false;
        void iterator.return?.(undefined);
    };
    res.on('close', onClose);
    options.req?.on('close', onClose);

    let index = 0;
    try {
        while (active) {
            const { value: event, done } = await iterator.next();
            if (done) break;
            if (event.type === 'delta') {
                res.write(deltaFrame(event.chunk, index, delta));
                index += 1;
            } else if (event.type === 'error') {
                // Surface the failure to the client as a named `error` SSE frame, then stop — but by
                // default write a generic token, never the raw `event.message`, so an internal
                // hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`) is not
                // disclosed. Opt in to the real message via `error.data`; `error.observe` sees the
                // real failure server-side.
                error.observe?.(new Error(event.message));
                res.write(
                    sseFrame(
                        error.data ? error.data(event) : DEFAULT_ERROR_DATA,
                        error.event ?? 'error',
                    ),
                );
                break;
            }
            // start / progress / info / drift / result / done are control signals: not forwarded.
        }
    } finally {
        res.off('close', onClose);
        options.req?.off('close', onClose);
        if (active) {
            // Normal completion (not a disconnect): close the iterator and end the response.
            void iterator.return?.(undefined);
            res.end();
        }
    }
}
