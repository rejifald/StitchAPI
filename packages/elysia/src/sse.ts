// `streamStitchSse`: stream a stitch's `.stream()` output to the client as Server-Sent Events
// (mirrors @stitchapi/hono's sse.ts, adapted to Elysia's Web-standard return model). A streaming/SSE
// stitch's `.stream()` is an `AsyncIterable<StitchEvent>`; this forwards each `delta` chunk as one
// SSE message, ends the stream cleanly on `done`, and turns an `error` event into a final
// `event: error` message — a generic `data: error` by default, the raw message withheld (opt in via
// `errorData`). When the client disconnects the `ReadableStream` is cancelled — the helper calls the
// iterator's `return()` so the upstream stitch stream is torn down rather than left running.
//
// Web-standard: returns a plain `Response` whose body is a `ReadableStream` — no `node:*`, so it runs
// under Bun, Node, Deno and the edge alike. Return it straight from an Elysia handler.
import type { StitchEvent, StitchEventSource } from 'stitchapi';

// The canonical event-source intake, from the core barrel: the event iterable itself (a `.stream()`
// generator), or anything that hands one back (a `StitchResult`, a stitch stub).
export type { StitchEventSource } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

export interface StreamStitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE message `data` string. The default JSON-stringifies the chunk
     * (a string chunk is sent verbatim). Pull text out of a structured chunk with, e.g.,
     * `data: (c) => c.choices[0].delta.content ?? ''`. Receives the zero-based message index
     * alongside the chunk.
     */
    data?: (chunk: unknown, index: number) => string;
    /**
     * The SSE `event:` field for each delta message (default none): a fixed name, or a function
     * of the chunk for per-message names. Set it to label the stream's messages on the client
     * (`event: 'token'`).
     */
    event?: string | ((chunk: unknown) => string);
    /**
     * Provide an `id:` line per delta message (the SSE last-event id), e.g. for resumable streams.
     * Receives the chunk and the zero-based frame index.
     */
    id?: (chunk: unknown, index: number) => string;
    /**
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw mid-stream,
     * normalised to an error event). **Default: a generic token (`data: error`)** — the raw
     * `event.message` is deliberately *not* echoed, because it can disclose internal network
     * topology (a transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or
     * the upstream's status (`HTTP 401`) to an untrusted client. Opt in with `(e) => e.message`
     * when the upstream messages are known safe, or return your own payload
     * (e.g. `() => JSON.stringify({ error: 'stream failed' })`). A multi-line return gets one
     * `data:` line each (SSE spec); the `event: error` name is fixed.
     */
    errorData?: (event: StitchErrorEvent) => string;
    /**
     * Called once, server-side, if the underlying stream errors (a stitch `error` event, or a
     * throw) — use it to observe/log the real failure. It does **not** shape the client-facing
     * frame: the SSE `data` sent to the client is controlled by `errorData` (a generic token by
     * default), so the raw message reaches your logs here but not the client.
     */
    onError?: (err: unknown) => void;
}

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
// never reaches the client. Override with `options.errorData`.
const DEFAULT_ERROR_DATA = 'error';

// Normalise a thrown value into the terminal `error` event shape, so an `errorData` opt-in sees a
// consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — an `errorData` hook keys off `name`/`message`.
function toErrorEvent(err: unknown): StitchErrorEvent {
    const e = err instanceof Error ? err : new Error(String(err));
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
 *     data: (chunk: any) => chunk.data,
 *   });
 * });
 * ```
 *
 * Each `delta` becomes a `data:` message; a terminal `error` event (or a throw) becomes a final
 * `event: error` message and ends the stream — a generic `data: error` by default, the raw message
 * withheld to avoid disclosing internal topology (opt in via `errorData`); every control event
 * (`start`/`progress`/`result`/`done`/…) is consumed but not forwarded. On client disconnect the
 * stream is cancelled and the upstream iterator is `return()`-ed so the stitch stream is aborted.
 */
export function streamStitchSse<T>(
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const toData: (chunk: unknown, index: number) => string =
        options.data ?? defaultData;
    const enc = new TextEncoder();
    const iterator = toIterable(source)[Symbol.asyncIterator]();
    let index = 0;

    // The terminal `error` frame: a generic token by default so a raw message
    // (`getaddrinfo ENOTFOUND …` / `HTTP 401`) is never disclosed; `errorData` opts in.
    const errorFrame = (event: StitchErrorEvent): string =>
        frame(
            options.errorData ? options.errorData(event) : DEFAULT_ERROR_DATA,
            'error',
        );

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
                            enc.encode(
                                frame(
                                    toData(event.chunk, index),
                                    typeof options.event === 'function'
                                        ? options.event(event.chunk)
                                        : options.event,
                                    options.id?.(event.chunk, index),
                                ),
                            ),
                        );
                        index += 1;
                        return; // one frame per pull → precise back-pressure
                    }
                    if (event.type === 'error') {
                        // `onError` gets the real failure server-side; the client frame is shaped
                        // by `errorData` (generic by default), never the raw `event.message`.
                        options.onError?.(new Error(event.message));
                        controller.enqueue(enc.encode(errorFrame(event)));
                        controller.close();
                        await iterator.return?.(undefined);
                        return;
                    }
                    // start / progress / info / drift / result / done are control signals: skipped,
                    // loop on to the next event without emitting a frame.
                }
            } catch (err) {
                // A throw (not a surfaced `error` event): still withhold the raw message by
                // default — normalise it to an error event so `errorData` sees a consistent shape.
                options.onError?.(err);
                controller.enqueue(enc.encode(errorFrame(toErrorEvent(err))));
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
