// stitch stream → Express SSE response. A stitch's `.stream()` (and a `StitchResult.stream()`) is an
// `AsyncIterable<StitchEvent>`; an SSE endpoint wants `text/event-stream` frames. This adapts the
// Fastify `sendStitchSse` bridge to Express's `res` (which is a Node `http.ServerResponse`): write
// frames straight to the socket. Each `delta` becomes one `data:` frame; an `error` event — or a
// throw mid-stream — ends the stream with a named `event: error` frame; stream end closes it; and a
// client disconnect (`res` or `req` 'close') aborts the upstream iterator rather than leaving it
// running.
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
    toErrorEvent,
    toIterable,
} from 'stitchapi/sse-emit';

export type { StitchEventSource };

/**
 * How each `delta` / terminal `error` becomes an SSE frame (see {@link SseEmitOptions}) — the
 * host-parity shape, identical in `@stitchapi/{elysia,fastify,hono,nest}` because all of them
 * alias core's one `SseEmitOptions`.
 *
 * Express's extra `req` fallback is NOT on this type: it lives on
 * {@link ExpressStreamStitchSseOptions}, which is what {@link streamStitchSse} accepts. One
 * exported identifier denotes one structural contract (P9), so the name that is shared across
 * hosts keeps the shared shape and the divergent side is framework-qualified.
 */
export type StreamStitchSseOptions = SseEmitOptions;

/**
 * What {@link streamStitchSse} accepts: the shared {@link StreamStitchSseOptions} plus Express's
 * one framework-specific field. Framework-qualified (ADR 0012 rule 6 — the
 * `SolidStitchStore`/`SvelteStitchStore` precedent) precisely because it diverges from the shape
 * the other hosts ship under the shared name.
 */
export type ExpressStreamStitchSseOptions = SseEmitOptions & {
    /**
     * The Express request, when available. Express normally fires `close` on the *response* on
     * disconnect, but passing `req` lets the helper also listen on the request socket for
     * environments/proxies that signal disconnect there — either fires the upstream teardown.
     */
    req?: Request;
};

/**
 * Stream a stitch's output to an Express {@link Response} as Server-Sent Events. Pass the stitch's
 * `.stream()` generator (or any `StitchEventSource`): each `delta` becomes one SSE frame, an
 * `error` event — or a throw mid-stream — ends the stream with a named `event: error` frame (a
 * generic `data: error` by default — the raw message is withheld to avoid disclosing internal
 * topology; opt in via `error`), and stream end closes the response. The non-output events
 * (`start` / `progress` / `drift` / `result` / `done`) are control signals and are not forwarded to
 * the client.
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
    options: ExpressStreamStitchSseOptions = {},
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

    // Accept both arms of the canonical `StitchEventSource` — the iterable itself, or a handle that
    // hands one back (a `StitchResult`, a stitch stub) — by resolving to the event iterable up front.
    const iterable = toIterable(source);
    const iterator = iterable[Symbol.asyncIterator]();
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
    } catch (err) {
        // A throw (not a surfaced `error` event): still withhold the raw message by default —
        // normalise it to an error event so an `error.data` opt-in sees a consistent shape. The
        // client frame is written only while the connection is live; `error.observe` fires either
        // way, so a failure that races a disconnect is still logged server-side.
        error.observe?.(err);
        if (active) {
            res.write(
                sseFrame(
                    error.data
                        ? error.data(toErrorEvent(err))
                        : DEFAULT_ERROR_DATA,
                    error.event ?? 'error',
                ),
            );
        }
    } finally {
        res.off('close', onClose);
        options.req?.off('close', onClose);
        if (active) {
            // Normal completion (or a caught throw — not a disconnect): close the iterator and end
            // the response.
            void iterator.return?.(undefined);
            res.end();
        }
    }
}
