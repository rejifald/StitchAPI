// Browser-safe builders for Web `ReadableStream` bodies and SSE event streams — the live response
// bodies a {@link mockAdapter} hands back for the `stream`/`sse` surfaces, built without a socket.
// Pair with {@link collectStitchEvents} to assert the streaming path deterministically, with full
// control over chunk boundaries. No `node:*` — runs in any test runner, a browser, or a Worker.
import type { Adapter, AdapterRequest, AdapterResponse } from './types';

const enc = new TextEncoder();

/**
 * A `ReadableStream` that emits each of `chunks` as a separate read (strings are UTF-8 encoded),
 * then closes. One chunk per `pull`, so a test can place chunk boundaries anywhere — e.g. split a
 * single SSE line across two chunks to exercise cross-chunk buffering.
 */
export function streamOf(
    chunks: (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            const c = chunks[i++] as string | Uint8Array;
            controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        },
    });
}

/**
 * A `ReadableStream` that emits `first`, then stays OPEN until `gate` resolves, then closes — the
 * long-lived-connection shape a concurrency / long-poll test needs.
 */
export function gatedStream(
    first: string,
    gate: Promise<void>,
): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(enc.encode(first));
                return;
            }
            await gate;
            controller.close();
        },
    });
}

/**
 * A `ReadableStream` that emits each of `chunks`, then ERRORS instead of closing — for asserting a
 * mid-stream transport failure surfaces as an `error` event with the deltas seen so far preserved.
 */
export function streamThenError(
    chunks: (string | Uint8Array)[],
    error: Error = new Error('stream broke mid-flight'),
): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                const c = chunks[i++] as string | Uint8Array;
                controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
                return;
            }
            controller.error(error);
        },
    });
}

/** One Server-Sent Event for {@link sseStream}. A bare string is shorthand for `{ data }`. */
export interface SseEvent {
    /** The `data:` payload — a string is sent verbatim (split across `data:` lines on `\n`); any
     *  other value is `JSON.stringify`'d. */
    data: unknown;
    /** The `event:` name (the SSE event type). */
    event?: string;
    /** The `id:` — replayed as `Last-Event-ID` on a resumable-SSE reconnect. */
    id?: string;
    /** The `retry:` reconnection time in ms. */
    retry?: number;
    /** A `:`-prefixed comment line (e.g. a keep-alive heartbeat). */
    comment?: string;
}

/**
 * A `ReadableStream` framed as a `text/event-stream` body — one well-formed SSE frame per event,
 * each terminated by the blank line the spec requires. Feed it to a {@link mockAdapter} (or
 * {@link streamAdapter}) to drive the `sse` surface, including `id:`/`retry:` for reconnect tests.
 */
export function sseStream(
    events: (SseEvent | string)[],
): ReadableStream<Uint8Array> {
    return streamOf(events.map(frameSse));
}

function frameSse(ev: SseEvent | string): string {
    if (typeof ev === 'string') return `data: ${ev}\n\n`;
    const lines: string[] = [];
    if (ev.comment !== undefined) lines.push(`: ${ev.comment}`);
    if (ev.event !== undefined) lines.push(`event: ${ev.event}`);
    if (ev.id !== undefined) lines.push(`id: ${ev.id}`);
    if (ev.retry !== undefined) lines.push(`retry: ${ev.retry}`);
    const data =
        typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
    for (const dl of data.split('\n')) lines.push(`data: ${dl}`);
    return `${lines.join('\n')}\n\n`;
}

/**
 * An adapter that requires a streaming request (`req.stream`) and returns `body` as the live
 * response body. The minimal transport for a single streaming call; for routing, status sequences,
 * and a request spy, use {@link mockAdapter} (which accepts a stream body too).
 */
export function streamAdapter(
    body: ReadableStream<Uint8Array>,
    init: { status?: number; headers?: Record<string, string> } = {},
): Adapter {
    return (req: AdapterRequest): Promise<AdapterResponse> => {
        if (!req.stream)
            return Promise.reject(new Error('expected req.stream to be set'));
        return Promise.resolve({
            status: init.status ?? 200,
            headers: init.headers ?? {},
            body,
        });
    };
}
