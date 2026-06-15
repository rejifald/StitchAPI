// Test helpers for driving Web Streams without a socket: build a `ReadableStream` from
// string/byte chunks, an adapter that hands one back as a live (`req.stream`) body, and a
// collector that drains a stitch event generator into its parts. Lets sse/stream specs assert
// the streaming execution path deterministically, with full control over chunk boundaries.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    StitchEvent,
} from '../../src/types';

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
 * A `ReadableStream` that emits `first`, then stays OPEN until `gate` resolves, then closes —
 * the long-lived-connection shape the concurrency-exemption test (Decision 12) needs.
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

/** An adapter that requires a streaming request and returns `body` as the live response body. */
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

export interface CollectedEvents<T> {
    types: string[];
    deltas: unknown[];
    result: T | undefined;
    error: { message: string; status: number | undefined } | undefined;
    done: { ok: boolean } | undefined;
}

/** Drain a stitch event generator into its parts: every delta chunk, the terminal result/error/done. */
export async function collectEvents<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<CollectedEvents<T>> {
    const types: string[] = [];
    const deltas: unknown[] = [];
    let result: T | undefined;
    let error: { message: string; status: number | undefined } | undefined;
    let done: { ok: boolean } | undefined;
    for await (const ev of gen) {
        types.push(ev.type);
        if (ev.type === 'delta') deltas.push(ev.chunk);
        else if (ev.type === 'result') result = ev.value;
        else if (ev.type === 'error')
            error = { message: ev.message, status: ev.status };
        else if (ev.type === 'done') done = { ok: ev.ok };
    }
    return { types, deltas, result, error, done };
}
