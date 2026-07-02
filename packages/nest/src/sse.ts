// stitch.stream() → Nest @Sse() (ADR 0006 Decision 10 follow-up). A stitch's `stream()`
// is an AsyncGenerator<StitchEvent>; Nest's @Sse() wants an Observable<MessageEvent>.
// This bridges the two so a streaming endpoint is one line, and aborts the upstream
// generator when the client disconnects (the subscription tears down).
import { Observable } from 'rxjs';
import type { StitchEvent } from 'stitchapi';

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

/** The safe, fixed message the errored observable carries by default (mirrors the exception filter). */
const SAFE_MESSAGE = 'Upstream request failed';

/**
 * The SSE message shape Nest's `@Sse()` consumes — declared structurally so this
 * package does not import Nest's `MessageEvent` type (one less coupling); Nest's
 * `MessageEvent` satisfies it. `data` is the only field the bridge sets.
 */
export interface MessageEventLike {
    data: string | object;
    id?: string;
    type?: string;
    retry?: number;
}

export interface StitchSseOptions {
    /**
     * Map a `delta` chunk to the SSE message `data`. Default: the chunk itself (a
     * string is sent as-is; an object is JSON-serialised by Nest). Use this to pull
     * the text out of a structured chunk, e.g. `data: (c) => c.choices[0].delta`.
     */
    data?: (chunk: unknown) => string | object;
    /**
     * Set the client-facing message for a terminal `error` event. Nest renders an errored
     * `@Sse()` observable's `message` to the client as the final `event: error` frame's data,
     * so this controls what the browser's `EventSource` receives. **Default: a fixed
     * `'Upstream request failed'`** — the raw `event.message` is deliberately *not* forwarded,
     * because it can disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to
     * an untrusted client. The original error is always attached as the errored observable's
     * `cause` for server-side logging. Provide a fixed string, or a function for a per-error
     * message. Prefer this over {@link exposeMessage} when you want a specific, curated message.
     */
    message?: string | ((event: StitchErrorEvent) => string);
    /**
     * Opt in to forwarding the raw `event.message` as the client-facing message. **Default
     * `false`** — see {@link message} for why the raw message is withheld by default. Ignored
     * when {@link message} is set. Only enable this when the upstream messages are known to be
     * safe to expose to your clients.
     */
    exposeMessage?: boolean;
}

// Normalise a thrown value into the terminal `error` event shape, so a `message` opt-in sees a
// consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
// throw. `attempts`/`at` are best-effort placeholders — a `message` hook keys off `name`/`message`.
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

// The Error the observable is errored with. By default it carries the safe, fixed message — the
// raw `event.message` is withheld, since Nest writes an errored observable's `message` straight to
// the client (an internal hostname / `HTTP 401` would leak). `exposeMessage`/`message` opt in; the
// original failure is always attached as `cause` for server-side logging.
function clientError(
    event: StitchErrorEvent,
    options: StitchSseOptions,
    cause: unknown,
): Error {
    const { message, exposeMessage } = options;
    const text =
        typeof message === 'function'
            ? message(event)
            : (message ??
              (exposeMessage ? event.message || SAFE_MESSAGE : SAFE_MESSAGE));
    return new Error(text, { cause });
}

/**
 * Adapt a stitch's `stream()` (or any `AsyncIterable<StitchEvent>`) into an
 * `Observable<MessageEventLike>` for an `@Sse()` endpoint: each `delta` becomes a
 * message, an `error` event errors the observable (Nest renders that to the client as a
 * final `event: error` frame — a fixed, safe message by default, the raw message withheld to
 * avoid disclosing internal topology; opt in via `exposeMessage`/`message`), and stream end
 * completes it. The non-output events (`start` / `progress` / `drift` / `result` / `done`) are
 * control signals and are not forwarded to the client.
 *
 * ```ts
 * @Sse('chat')
 * chat(@Query('q') q: string) {
 *   return stitchSse(this.complete.stream({ body: { prompt: q } }),
 *                    { data: (c: any) => c.text });
 * }
 * ```
 *
 * When the client disconnects, Nest unsubscribes; the teardown calls the iterator's
 * `return()` so the underlying stitch stream is aborted rather than left running.
 */
export function stitchSse<T>(
    stream: AsyncIterable<StitchEvent<T>>,
    options: StitchSseOptions = {},
): Observable<MessageEventLike> {
    const toData =
        options.data ?? ((chunk: unknown) => chunk as string | object);
    return new Observable<MessageEventLike>((subscriber) => {
        const iterator = stream[Symbol.asyncIterator]();
        let active = true;
        void (async () => {
            try {
                while (active) {
                    const { value: event, done } = await iterator.next();
                    if (done) break;
                    if (event.type === 'delta') {
                        subscriber.next({ data: toData(event.chunk) });
                    } else if (event.type === 'error') {
                        // Error the observable — but by default with a safe, fixed message, never
                        // the raw `event.message`: Nest writes an errored `@Sse()` observable's
                        // `message` straight to the client, so echoing it would disclose an internal
                        // hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status (`HTTP 401`).
                        // The event is attached as `cause`; opt in via `exposeMessage`/`message`.
                        subscriber.error(clientError(event, options, event));
                        return;
                    }
                }
                subscriber.complete();
            } catch (err) {
                // A throw (not a surfaced `error` event): withhold the raw message the same way —
                // normalise it to an error event so a `message` opt-in sees a consistent shape, and
                // attach the original as `cause`.
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
