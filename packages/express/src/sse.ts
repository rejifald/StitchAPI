// stitch stream → Express SSE response. A stitch's `.stream()` (and a `StitchResult.stream()`) is an
// `AsyncIterable<StitchEvent>`; an SSE endpoint wants `text/event-stream` frames. This adapts the
// Fastify `sendStitchSse` bridge to Express's `res` (which is a Node `http.ServerResponse`): write
// frames straight to the socket. Each `delta` becomes one `data:` frame; an `error` event ends the
// stream with a named `event: error` frame; stream end closes it; and a client disconnect (`res` or
// `req` 'close') aborts the upstream iterator rather than leaving it running.
import type { Request, Response } from 'express';
import type { StitchEvent } from 'stitchapi';

/** Anything `streamStitchSse` can drive: a stitch `.stream()` generator, or any event iterable. */
export type StitchEventSource<T> =
    | AsyncIterable<StitchEvent<T>>
    | AsyncGenerator<StitchEvent<T>, void>;

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

export interface StreamStitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE frame `data`. Default: the chunk itself (a string is sent
     * as-is; anything else is `JSON.stringify`-ed). Use this to pull the text out of a structured
     * chunk, e.g. `data: (c) => c.choices[0].delta.content`.
     */
    data?: (chunk: unknown) => string;
    /**
     * Emit an `event:` line per delta frame (the SSE event name). Default: none (an unnamed
     * `message` event, which `EventSource.onmessage` receives).
     */
    event?: string;
    /**
     * Provide an `id:` line per delta frame (the SSE last-event id), e.g. for resumable streams.
     * Receives the chunk and the zero-based frame index.
     */
    id?: (chunk: unknown, index: number) => string;
    /**
     * Shape the SSE `data` written for a terminal `error` event. **Default: a generic token
     * (`data: error`)** — the raw `event.message` is deliberately *not* echoed, because it can
     * disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to an
     * untrusted client. Opt in with `(e) => e.message` when the upstream messages are known safe,
     * or return your own payload (e.g. `() => JSON.stringify({ error: 'stream failed' })`). A
     * multi-line return gets one `data:` line each (SSE spec); the `event: error` name is fixed.
     */
    errorData?: (event: StitchErrorEvent) => string;
    /**
     * The Express request, when available. Express normally fires `close` on the *response* on
     * disconnect, but passing `req` lets the helper also listen on the request socket for
     * environments/proxies that signal disconnect there — either fires the upstream teardown.
     */
    req?: Request;
}

// One delta chunk → an SSE frame string. A multi-line payload is split so every line gets its own
// `data:` prefix (the SSE spec joins them with `\n`); the frame ends on a blank line.
function frame(
    chunk: unknown,
    index: number,
    options: StreamStitchSseOptions,
): string {
    const raw =
        options.data?.(chunk) ??
        (typeof chunk === 'string' ? chunk : JSON.stringify(chunk));
    const lines: string[] = [];
    if (options.event) lines.push(`event: ${options.event}`);
    if (options.id) lines.push(`id: ${options.id(chunk, index)}`);
    for (const dataLine of raw.split('\n')) lines.push(`data: ${dataLine}`);
    return `${lines.join('\n')}\n\n`;
}

// The generic token written as an `error` frame's `data` by default: the raw upstream message is
// withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`)
// never reaches the client. Override with `options.errorData`.
const DEFAULT_ERROR_DATA = 'error';

// The terminal `error` frame: the fixed `event: error` name plus a (multi-line-safe) data payload —
// every line of `data` gets its own `data:` prefix so a multi-line opt-in payload can't break the
// SSE framing.
function errorFrame(data: string): string {
    const lines = ['event: error'];
    for (const dataLine of data.split('\n')) lines.push(`data: ${dataLine}`);
    return `${lines.join('\n')}\n\n`;
}

/**
 * Stream a stitch's output to an Express {@link Response} as Server-Sent Events. Pass the stitch's
 * `.stream()` generator (or any `AsyncIterable<StitchEvent>`): each `delta` becomes one SSE frame, an
 * `error` event ends the stream with a named `event: error` frame (a generic `data: error` by
 * default — the raw message is withheld to avoid disclosing internal topology; opt in via
 * `errorData`), and stream end closes the response. The non-output events (`start` / `progress` /
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
 *                   { data: (c: any) => c.text, req }),
 * );
 * ```
 */
export async function streamStitchSse<T>(
    res: Response,
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Promise<void> {
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
                res.write(frame(event.chunk, index, options));
                index += 1;
            } else if (event.type === 'error') {
                // Surface the failure to the client as a named `error` SSE frame, then stop — but by
                // default write a generic token, never the raw `event.message`, so an internal
                // hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`) is not
                // disclosed. Opt in to the real message via `options.errorData`.
                res.write(
                    errorFrame(
                        options.errorData
                            ? options.errorData(event)
                            : DEFAULT_ERROR_DATA,
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
