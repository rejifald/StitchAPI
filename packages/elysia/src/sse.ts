// `streamStitchSse`: stream a stitch's `.stream()` output to the client as Server-Sent Events
// (mirrors @stitchapi/hono's sse.ts, adapted to Elysia's Web-standard return model). A streaming/SSE
// stitch's `.stream()` is an `AsyncIterable<StitchEvent>`; this forwards each `delta` chunk as one
// SSE message, ends the stream cleanly on `done`, and turns an `error` event into a final
// `event: error` message — a generic `data: error` by default, the raw message withheld (opt in via
// `error`). When the client disconnects the `ReadableStream` is cancelled — the helper
// calls the iterator's `return()` so the upstream stitch stream is torn down rather than left running.
//
// Web-standard: returns a plain `Response` whose body is a `ReadableStream` — no `node:*`, so it runs
// under Bun, Node, Deno and the edge alike. Return it straight from an Elysia handler.
import type { StitchEvent, StitchEventSource } from 'stitchapi';

// The canonical event-source intake, from the core barrel: the event iterable itself (a `.stream()`
// generator), or anything that hands one back (a `StitchResult`, a stitch stub).
export type { StitchEventSource } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

/** Shape a `delta` chunk into the SSE frame `data`. */
type DeltaShaper = (chunk: unknown) => string;
/** Shape a terminal `error` event into the SSE frame `data`. */
type ErrorShaper = (event: StitchErrorEvent) => string;

// How each `delta` becomes a message. The bare {@link DeltaShaper} form (`delta: (c) => …`) is
// shorthand for `{ data: (c) => … }`.
interface DeltaFrameOptions {
    /**
     * Map a `delta` chunk to the SSE message `data` string. The default JSON-stringifies the chunk
     * (a string chunk is sent verbatim). Pull text out of a structured chunk with, e.g.,
     * `(c) => c.choices[0].delta.content ?? ''`.
     */
    data?: DeltaShaper;
    /**
     * The SSE `event:` field for each delta message (default none). Set it to label the stream's
     * messages on the client (`event: 'token'`).
     */
    event?: string;
    /**
     * Provide an `id:` line per delta message (the SSE last-event id), e.g. for resumable streams.
     * Receives the chunk and the zero-based frame index.
     */
    id?: (chunk: unknown, index: number) => string;
}

// How the terminal `error` becomes the final message. The bare {@link ErrorShaper} form
// (`error: (e) => …`) is shorthand for `{ data: (e) => … }`.
interface ErrorFrameOptions {
    /**
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw mid-stream,
     * normalised to an error event). **Default: a generic token (`data: error`)** — the raw
     * `event.message` is deliberately *not* echoed, because it can disclose internal network
     * topology (a transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or
     * the upstream's status (`HTTP 401`) to an untrusted client. Opt in with `(e) => e.message`
     * when the upstream messages are known safe, or return your own payload
     * (e.g. `() => JSON.stringify({ error: 'stream failed' })`). A multi-line return gets one
     * `data:` line each (SSE spec).
     */
    data?: ErrorShaper;
    /** The `event:` name of the terminal error message. Default `'error'`. */
    event?: string;
    /**
     * Observe the real failure, server-side (a stitch `error` event, or a throw) — use it to
     * log/trace. It does **not** shape the client-facing frame: the SSE `data` sent to the client
     * is controlled by {@link ErrorFrameOptions.data} (a generic token by default), so the raw
     * message reaches your logs here but not the client.
     */
    observe?: (err: unknown) => void;
}

export interface StreamStitchSseOptions {
    /**
     * How each `delta` becomes a message. Pass a **function** as shorthand for `{ data }`
     * (`delta: (c) => c.text`), or the full `{ data, event, id }` object to set the SSE
     * `event:` / `id:` lines too.
     */
    delta?: DeltaShaper | DeltaFrameOptions;
    /**
     * How the terminal error becomes the final message. Pass a **function** as shorthand for
     * `{ data }` (`error: (e) => e.message`), or the full `{ data, event, observe }` object. By
     * default the client gets a generic `data: error` token — the raw message is withheld to
     * avoid disclosing internal topology.
     */
    error?: ErrorShaper | ErrorFrameOptions;
}

// Expand the function-shorthand form of each frame option to its full config object.
const asDelta = (o: DeltaShaper | DeltaFrameOptions = {}): DeltaFrameOptions =>
    typeof o === 'function' ? { data: o } : o;
const asError = (o: ErrorShaper | ErrorFrameOptions = {}): ErrorFrameOptions =>
    typeof o === 'function' ? { data: o } : o;

function defaultData(chunk: unknown): string {
    return typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
}

// One SSE frame string. A multi-line payload is split so every line gets its own `data:` prefix
// (the SSE spec joins them with `\n`); the frame ends on a blank line.
function frame(data: string, event?: string, id?: string): string {
    const lines: string[] = [];
    if (event !== undefined) lines.push(`event: ${event}`);
    if (id !== undefined) lines.push(`id: ${id}`);
    for (const line of data.split('\n')) lines.push(`data: ${line}`);
    return `${lines.join('\n')}\n\n`;
}

// The generic token written as an `error` message's `data` by default: the raw upstream message is
// withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`)
// never reaches the client. Override with `error.data`.
const DEFAULT_ERROR_DATA = 'error';

// Normalise a thrown value into the terminal `error` event shape, so an `error.data` opt-in sees a
// consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
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
    return Symbol.asyncIterator in source ? source : source.stream();
}

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
    const delta = asDelta(options.delta);
    const error = asError(options.error);
    const toData = delta.data ?? defaultData;
    const errorEvent = error.event ?? 'error';
    const enc = new TextEncoder();
    const iterator = toIterable(source)[Symbol.asyncIterator]();
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
                        const id = delta.id
                            ? delta.id(event.chunk, index)
                            : undefined;
                        index += 1;
                        controller.enqueue(
                            enc.encode(
                                frame(toData(event.chunk), delta.event, id),
                            ),
                        );
                        return; // one frame per pull → precise back-pressure
                    }
                    if (event.type === 'error') {
                        // `error.observe` gets the real failure server-side; the client frame is a
                        // generic token by default (never the raw `event.message`) — `error.data`
                        // opts in.
                        error.observe?.(new Error(event.message));
                        controller.enqueue(
                            enc.encode(
                                frame(
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
                        frame(
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
