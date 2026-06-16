// stitch.stream() → Nest @Sse() (ADR 0006 Decision 10 follow-up). A stitch's `stream()`
// is an AsyncGenerator<StitchEvent>; Nest's @Sse() wants an Observable<MessageEvent>.
// This bridges the two so a streaming endpoint is one line, and aborts the upstream
// generator when the client disconnects (the subscription tears down).
import { Observable } from 'rxjs';
import type { StitchEvent } from 'stitchapi';

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
}

/**
 * Adapt a stitch's `stream()` (or any `AsyncIterable<StitchEvent>`) into an
 * `Observable<MessageEventLike>` for an `@Sse()` endpoint: each `delta` becomes a
 * message, an `error` event errors the observable, and stream end completes it. The
 * non-output events (`start` / `progress` / `drift` / `result` / `done`) are control
 * signals and are not forwarded to the client.
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
                        subscriber.error(new Error(event.message));
                        return;
                    }
                }
                subscriber.complete();
            } catch (err) {
                subscriber.error(err);
            }
        })();
        // Teardown on unsubscribe (client disconnect): stop consuming and abort upstream.
        return () => {
            active = false;
            void iterator.return?.(undefined);
        };
    });
}
