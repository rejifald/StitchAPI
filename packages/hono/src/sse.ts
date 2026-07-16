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

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

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
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw mid-stream,
     * normalised to an error event). **Default: a generic token (`data: error`)** — the raw
     * `event.message` is deliberately *not* echoed, because it can disclose internal network
     * topology (a transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or
     * the upstream's status (`HTTP 401`) to an untrusted client. Opt in with `(e) => e.message`
     * when the upstream messages are known safe, or return your own payload
     * (e.g. `() => JSON.stringify({ error: 'stream failed' })`).
     */
    payload?: (event: StitchErrorEvent) => string;
    /**
     * Called once, server-side, if the underlying stream errors (a stitch `error` event, or a
     * throw) — use it to observe/log the real failure. It does **not** shape the client-facing
     * frame: the SSE `data` sent to the client is controlled by `payload` (a generic token by
     * default), so the raw message reaches your logs here but not the client.
     */
    onError?: (err: unknown) => void;
}

function defaultData(chunk: unknown): string {
    return typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
}

// The generic token written as an `error` message's `data` by default: the raw upstream message is
// withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`)
// never reaches the client. Override with `options.payload`.
const DEFAULT_PAYLOAD = 'error';

// Normalise a thrown value into the terminal `error` event shape, so a `payload` opt-in sees a
// consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — a `payload` hook keys off `name`/`message`.
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
 * `event: error` message and ends the stream — a generic `data: error` by default, the raw message
 * withheld to avoid disclosing internal topology (opt in via `payload`); every control event
 * (`start`/`progress`/`result`/`done`/…) is consumed but not forwarded. On client disconnect the
 * upstream iterator is `return()`-ed so the stitch stream is aborted.
 */
export function streamStitchSse<T>(
    c: Context,
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Response {
    const toData = options.data ?? defaultData;
    return streamSSE(c, async (stream: SSEStreamingApi) => {
        const iterator = source[Symbol.asyncIterator]();
        // Write the terminal `error` message: a generic token by default so a raw message
        // (`getaddrinfo ENOTFOUND …` / `HTTP 401`) is never disclosed; `payload` opts in.
        const writeErrorFrame = (event: StitchErrorEvent): Promise<void> =>
            stream.writeSSE({
                event: 'error',
                data: options.payload
                    ? options.payload(event)
                    : DEFAULT_PAYLOAD,
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
                    if (options.event !== undefined)
                        message.event = options.event;
                    await stream.writeSSE(message);
                } else if (event.type === 'error') {
                    // `onError` gets the real failure server-side; the client frame is shaped by
                    // `payload` (generic by default), never the raw `event.message`.
                    options.onError?.(new Error(event.message));
                    await writeErrorFrame(event);
                    return;
                }
                // start / progress / info / drift / result / done are control signals: not forwarded.
            }
        } catch (err) {
            // A throw (not a surfaced `error` event): still withhold the raw message by default —
            // normalise it to an error event so a `payload` opt-in sees a consistent shape.
            options.onError?.(err);
            await writeErrorFrame(toErrorEvent(err));
        } finally {
            await iterator.return?.(undefined);
        }
    });
}
