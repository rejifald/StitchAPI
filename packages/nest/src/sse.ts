// stitch.stream() → Nest @Sse() (ADR 0006 Decision 10 follow-up). A stitch's `stream()`
// is an AsyncGenerator<StitchEvent>; Nest's @Sse() wants an Observable<MessageEvent>.
// This bridges the two so a streaming endpoint is one line, and aborts the upstream
// generator when the client disconnects (the subscription tears down).
import { Observable } from 'rxjs';
import type { StitchEvent, StitchEventSource } from 'stitchapi';

// The canonical intake for event-stream consumers, re-exported from the core barrel: the
// event iterable itself (a `.stream()` generator) or anything that hands one back (a
// `StitchResult`, a stitch stub).
export type { StitchEventSource } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

// The generic token an `error` frame carries by default: the raw upstream message is withheld so an
// internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`) never reaches
// the client. Override with `options.errorData`.
const DEFAULT_ERROR_DATA = 'error';

/**
 * The SSE message shape Nest's `@Sse()` consumes — declared structurally so this
 * package does not import Nest's `MessageEvent` type (one less coupling); Nest's
 * `MessageEvent` satisfies it. The bridge sets `data` (always), plus `type`/`id`
 * when the `event`/`id` options are given.
 */
export interface MessageEventLike {
    data: string | object;
    id?: string;
    type?: string;
    retry?: number;
}

export interface StreamStitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE message `data` string. The default sends a string chunk
     * as-is and `JSON.stringify`-s anything else. Use this to pull the text out of a structured
     * chunk, e.g. `data: (c) => c.choices[0].delta.content`. Receives the zero-based message
     * index alongside the chunk.
     */
    data?: (chunk: unknown, index: number) => string;
    /**
     * Emit an `event:` line per delta message (the SSE event name — Nest's `MessageEvent.type`):
     * a fixed name, or a function of the chunk for per-message names. Default: none (an unnamed
     * `message` event, which `EventSource.onmessage` receives).
     */
    event?: string | ((chunk: unknown) => string);
    /**
     * Provide an `id:` line per delta message (the SSE last-event id), e.g. for resumable
     * streams. Receives the chunk and the zero-based message index.
     */
    id?: (chunk: unknown, index: number) => string;
    /**
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw
     * mid-stream, normalised to an error event). Nest renders an errored `@Sse()` observable's
     * `message` to the client as the final `event: error` frame's data, so this controls what
     * the browser's `EventSource` receives. **Default: a generic token (`data: error`)** — the
     * raw `event.message` is deliberately *not* echoed, because it can disclose internal network
     * topology (a transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`)
     * or the upstream's status (`HTTP 401`) to an untrusted client. Opt in with
     * `(e) => e.message` when the upstream messages are known safe, or return your own payload
     * (e.g. `() => JSON.stringify({ error: 'stream failed' })`).
     */
    errorData?: (event: StitchErrorEvent) => string;
    /**
     * Called once, server-side, if the underlying stream errors (a stitch `error` event, or a
     * throw) — use it to observe/log the real failure. It does **not** shape the client-facing
     * frame: the SSE `data` sent to the client is controlled by `errorData` (a generic token by
     * default), so the raw message reaches your logs here but not the client. Host-specific
     * extra: the original failure is *also* attached as the errored observable's `cause`.
     */
    onError?: (err: unknown) => void;
}

// One delta chunk → the message `data` string: a string chunk as-is, anything else JSON.
function defaultData(chunk: unknown): string {
    return typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
}

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

// The Error the observable is errored with. By default it carries the generic `error` token — the
// raw `event.message` is withheld, since Nest writes an errored observable's `message` straight to
// the client (an internal hostname / `HTTP 401` would leak). `errorData` opts in; the original
// failure is always attached as `cause` for server-side logging.
function clientError(
    event: StitchErrorEvent,
    options: StreamStitchSseOptions,
    cause: unknown,
): Error {
    const text = options.errorData
        ? options.errorData(event)
        : DEFAULT_ERROR_DATA;
    return new Error(text, { cause });
}

// Accept the canonical `StitchEventSource` intake: the iterable itself, or anything that hands one
// back (a `StitchResult`, a stitch stub).
function toIterable<T>(
    source: StitchEventSource<T>,
): AsyncIterable<StitchEvent<T>> {
    return Symbol.asyncIterator in source ? source : source.stream();
}

/**
 * Adapt a stitch's `stream()` (or any {@link StitchEventSource}) into an
 * `Observable<MessageEventLike>` for an `@Sse()` endpoint: each `delta` becomes a
 * message, an `error` event errors the observable (Nest renders that to the client as a
 * final `event: error` frame — a generic `data: error` by default, the raw message withheld to
 * avoid disclosing internal topology; opt in via `errorData`, observe the real failure
 * server-side via `onError`), and stream end completes it. The non-output events
 * (`start` / `progress` / `drift` / `result` / `done`) are control signals and are not
 * forwarded to the client.
 *
 * ```ts
 * @Sse('chat')
 * chat(@Query('q') q: string) {
 *   return streamStitchSse(this.complete.stream({ body: { prompt: q } }),
 *                          { data: (c: any) => c.text });
 * }
 * ```
 *
 * When the client disconnects, Nest unsubscribes; the teardown calls the iterator's
 * `return()` so the underlying stitch stream is aborted rather than left running.
 */
export function streamStitchSse<T>(
    source: StitchEventSource<T>,
    options: StreamStitchSseOptions = {},
): Observable<MessageEventLike> {
    const toData: (chunk: unknown, index: number) => string =
        options.data ?? defaultData;
    return new Observable<MessageEventLike>((subscriber) => {
        const iterator = toIterable(source)[Symbol.asyncIterator]();
        let active = true;
        void (async () => {
            let index = 0;
            try {
                while (active) {
                    const { value: event, done } = await iterator.next();
                    if (done) break;
                    if (event.type === 'delta') {
                        const message: MessageEventLike = {
                            data: toData(event.chunk, index),
                        };
                        if (options.event !== undefined)
                            message.type =
                                typeof options.event === 'function'
                                    ? options.event(event.chunk)
                                    : options.event;
                        if (options.id)
                            message.id = options.id(event.chunk, index);
                        subscriber.next(message);
                        index += 1;
                    } else if (event.type === 'error') {
                        // Error the observable — but by default with the generic token, never the
                        // raw `event.message`: Nest writes an errored `@Sse()` observable's
                        // `message` straight to the client, so echoing it would disclose an
                        // internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
                        // (`HTTP 401`). `onError` gets the real failure server-side; the event is
                        // also attached as `cause`; `errorData` shapes the client frame.
                        options.onError?.(new Error(event.message));
                        subscriber.error(clientError(event, options, event));
                        return;
                    }
                }
                subscriber.complete();
            } catch (err) {
                // A throw (not a surfaced `error` event): withhold the raw message the same way —
                // normalise it to an error event so an `errorData` opt-in sees a consistent shape,
                // and attach the original as `cause`.
                options.onError?.(err);
                subscriber.error(clientError(toErrorEvent(err), options, err));
            }
        })();
        // Teardown on unsubscribe (client disconnect): stop consuming and abort upstream.
        return () => {
            active = false;
            void iterator.return?.(undefined);
        };
    });
}
