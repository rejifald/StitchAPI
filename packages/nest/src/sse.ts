// stitch.stream() → Nest @Sse() (ADR 0006 Decision 10 follow-up). A stitch's `stream()`
// is an AsyncGenerator<StitchEvent>; Nest's @Sse() wants an Observable<MessageEvent>.
// This bridges the two so a streaming endpoint is one line, and aborts the upstream
// generator when the client disconnects (the subscription tears down).
import { Observable } from 'rxjs';
import type { StitchEventSource } from 'stitchapi';
import {
    DEFAULT_ERROR_DATA,
    type ErrorFrameOptions,
    type SseEmitOptions,
    type StitchErrorEvent,
    defaultData,
    deltaEvent,
    resolveDelta,
    resolveError,
    toErrorEvent,
    toIterable,
} from 'stitchapi/sse-emit';

// The canonical intake for event-stream consumers, re-exported from the core barrel: the
// event iterable itself (a `.stream()` generator) or anything that hands one back (a
// `StitchResult`, a stitch stub).
export type { StitchEventSource } from 'stitchapi';

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

/**
 * Options for {@link streamStitchSse} — core's shared {@link SseEmitOptions}, identical to every
 * other host (CONTRACT.md P16). The `delta` / `error` envelopes replace the flat `data` / `event` /
 * `id` / `errorData` / `onError` spellings this package used to declare on its own; P16's *Settled*
 * clause names those verbatim as the thing not to reintroduce.
 *
 * Nest's two genuine extras were not dropped to get here — they were lifted INTO the shared
 * envelope, so all six hosts gained them: `delta.data` now receives the frame `index`, and
 * `delta.event` accepts a function for per-message names.
 */
export type StreamStitchSseOptions = SseEmitOptions;

// The Error the observable is errored with. By default it carries the generic `error` token — the
// raw `event.message` is withheld, since Nest writes an errored observable's `message` straight to
// the client (an internal hostname / `HTTP 401` would leak). `errorData` opts in; the original
// failure is always attached as `cause` for server-side logging.
function clientError(
    event: StitchErrorEvent,
    error: ErrorFrameOptions,
    cause: unknown,
): Error {
    const text = error.data ? error.data(event) : DEFAULT_ERROR_DATA;
    return new Error(text, { cause });
}

/**
 * Adapt a stitch's `stream()` (or any {@link StitchEventSource}) into an
 * `Observable<MessageEventLike>` for an `@Sse()` endpoint: each `delta` becomes a
 * message, an `error` event errors the observable (Nest renders that to the client as a
 * final `event: error` frame — a generic `data: error` by default, the raw message withheld to
 * avoid disclosing internal topology; opt in via `error.data`, observe the real failure
 * server-side via `error.observe`), and stream end completes it. The non-output events
 * (`start` / `progress` / `drift` / `result` / `done`) are control signals and are not
 * forwarded to the client.
 *
 * ```ts
 * @Sse('chat')
 * chat(@Query('q') q: string) {
 *   return streamStitchSse(this.complete.stream({ body: { prompt: q } }),
 *                          { delta: (c: any) => c.text });
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
    // Fold each slot's shorthand once (`delta: (c) => …` ≡ `{ data: (c) => … }`), exactly as the
    // other five hosts do — this bridge builds Nest `MessageEvent`s rather than raw frames, so it
    // uses the resolved options directly instead of `deltaFrame`.
    const delta = resolveDelta(options.delta);
    const error = resolveError(options.error);
    const toData = delta.data ?? defaultData;
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
                        const name = deltaEvent(event.chunk, index, delta);
                        if (name !== undefined) message.type = name;
                        if (delta.id) message.id = delta.id(event.chunk, index);
                        subscriber.next(message);
                        index += 1;
                    } else if (event.type === 'error') {
                        // Error the observable — but by default with the generic token, never the
                        // raw `event.message`: Nest writes an errored `@Sse()` observable's
                        // `message` straight to the client, so echoing it would disclose an
                        // internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
                        // (`HTTP 401`). `error.observe` gets the real failure server-side; the
                        // event is also attached as `cause`; `error.data` shapes the client frame.
                        error.observe?.(new Error(event.message));
                        subscriber.error(clientError(event, error, event));
                        return;
                    }
                }
                subscriber.complete();
            } catch (err) {
                // A throw (not a surfaced `error` event): withhold the raw message the same way —
                // normalise it to an error event so an `error.data` opt-in sees a consistent shape,
                // and attach the original as `cause`.
                error.observe?.(err);
                subscriber.error(clientError(toErrorEvent(err), error, err));
            }
        })();
        // Teardown on unsubscribe (client disconnect): stop consuming and abort upstream.
        return () => {
            active = false;
            void iterator.return?.(undefined);
        };
    });
}
