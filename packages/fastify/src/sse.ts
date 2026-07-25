// stitch stream → Fastify SSE reply. A stitch's `.stream()` (and a `StitchResult.stream()`)
// is an `AsyncGenerator<StitchEvent>`; an SSE endpoint wants `text/event-stream` frames. This
// adapts the Nest `stitchSse` bridge (`packages/nest/src/sse.ts`) to Fastify's `reply`, writing
// frames straight to `reply.raw` (Fastify ships no `reply.sse` of its own). Each `delta`
// becomes one `data:` frame; an `error` event ends the stream; stream end closes it; and a
// client disconnect aborts the upstream generator rather than leaving it running.
//
// The frame types, the `delta`/`error` shorthand folds, the SSE wire serializer, and the
// secure-by-default error framing are shared with every other HTTP adapter via
// `stitchapi/sse-emit`; this file keeps only Fastify's reply driver.
import type { FastifyReply } from 'fastify';
import type { StitchEvent } from 'stitchapi';
import {
    DEFAULT_ERROR_DATA,
    type SseEmitOptions,
    deltaFrame,
    resolveDelta,
    resolveError,
    sseFrame,
} from 'stitchapi/sse-emit';

/** How each `delta` / terminal `error` becomes an SSE frame (see {@link SseEmitOptions}). */
export type SendStitchSseOptions = SseEmitOptions;

/**
 * Stream a stitch's output to a Fastify {@link FastifyReply} as Server-Sent Events. Pass the
 * stitch's `.stream()` generator (or any `AsyncIterable<StitchEvent>`): each `delta` becomes
 * one SSE frame, an `error` event ends the stream with a named `event: error` frame (a generic
 * `data: error` by default — the raw message is withheld to avoid disclosing internal topology;
 * opt in via `error`), and stream end closes the response. The non-output events (`start` /
 * `progress` / `drift` / `result` / `done`) are control signals and are not forwarded to the client.
 *
 * Takes over the reply via `reply.hijack()` and writes raw frames, so do **not** also `send()`
 * from the same handler. Resolves once the response is fully written (or the client
 * disconnects). When the client disconnects, the upstream generator's `return()` is called so
 * the stitch stream is aborted rather than left running.
 *
 * ```ts
 * app.get('/chat', (req, reply) =>
 *   sendStitchSse(reply, chat.stream({ query: { q: req.query.q } }),
 *                 { delta: (c: any) => c.text }),
 * );
 * ```
 */
export async function sendStitchSse<T>(
    reply: FastifyReply,
    stream: AsyncIterable<StitchEvent<T>>,
    options: SendStitchSseOptions = {},
): Promise<void> {
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
    const res = reply.raw;
    // Take control of the reply: we own the socket from here, Fastify won't try to send.
    reply.hijack();
    if (!res.headersSent) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
        });
    }

    const iterator = stream[Symbol.asyncIterator]();
    let active = true;

    // Client disconnect: stop consuming and abort the upstream generator.
    const onClose = (): void => {
        active = false;
        void iterator.return?.(undefined);
    };
    res.on('close', onClose);

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
        }
    } finally {
        res.off('close', onClose);
        if (active) {
            // Normal completion (not a disconnect): close the iterator and end the response.
            void iterator.return?.(undefined);
            res.end();
        }
    }
}
