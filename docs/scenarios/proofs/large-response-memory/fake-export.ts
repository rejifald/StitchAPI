// The fake vendor: a product-catalog export endpoint, offline and in-memory.
//
// Everything here is LAZY. The rows are generated inside the stream's `pull()`, one ~16 KB chunk at
// a time, so the fixture itself never exists as a whole — otherwise the fixture would dominate every
// heap measurement and the numbers would be about this file rather than about the library. A
// `pull`-driven `ReadableStream` also models a real socket: its internal queue holds about one chunk,
// so a slow reader really does slow the producer. `eagerArray` is the deliberate opposite (C6).
//
// Two wire formats, same rows:
//   - `singleArray`  — ONE top-level JSON array: `[{…},{…},…]`. The hard case. No newlines between
//     records, so nothing can split it on `\n`.
//   - `ndjson`       — one record per line. The easy case, and the control for the measurement.
//
// `wire()` reports the exact byte count the producer emitted, so every ratio in this directory is
// measured against real bytes rather than an estimate.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

const enc = new TextEncoder();

/** One product row — the shape the incident was about (a catalog export). ~200 bytes of JSON. */
export interface ProductRow {
    id: string;
    sku: string;
    title: string;
    price_cents: number;
    currency: string;
    in_stock: boolean;
    tags: string[];
    updated_at: string;
}

const pad = (n: number): string => String(n).padStart(7, '0');

export function productRow(i: number): ProductRow {
    return {
        id: `prd_${pad(i)}`,
        sku: `SKU-${pad(i)}-A`,
        title: `Refurbished Widget Assembly, Model ${pad(i)}`,
        price_cents: 1999 + (i % 5000),
        currency: 'usd',
        in_stock: i % 7 !== 0,
        tags: ['catalog', 'widget', `bin-${String(i % 40)}`],
        updated_at: `2026-0${String((i % 9) + 1)}-1${String(i % 10)}T04:00:00.000Z`,
    };
}

/** Rows per emitted chunk, sized so a chunk lands near a real socket read (~16 KB). */
const ROWS_PER_CHUNK = 64;

/** A live response body plus the exact byte count it wrote. */
export interface Wire {
    body: ReadableStream<Uint8Array>;
    /** Bytes emitted so far (final once the stream has closed). */
    wire: () => number;
    /** Chunks the producer has enqueued so far — the backpressure observable (C6). */
    enqueued: () => number;
    /**
     * Sample from the PRODUCER, once per emitted chunk. This is the one seam every mode shares —
     * buffered, streamed, awaited, batched — so installing the sampler here (rather than in each
     * consumer) is what makes the modes comparable. A consumer-side sampler would give `.stream()`
     * hundreds of chances to catch a peak and `await` exactly none, and the resulting "await uses
     * less heap" would be an artefact of the instrument.
     */
    watch: (s: WireSampler, marks: number) => void;
}

/** The two sampling operations a {@link Wire} drives. Structurally the `Sampler` from `mem.ts`. */
export interface WireSampler {
    tick: () => void;
    mark: () => number;
}

function lazyWire(
    chunkFor: (start: number, end: number) => string,
    open: string,
    close: string,
    rows: number,
): Wire {
    let bytes = 0;
    let chunks = 0;
    let next = 0;
    let opened = false;
    let watcher: { s: WireSampler; every: number } | undefined;
    const emit = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        s: string,
    ): void => {
        const u = enc.encode(s);
        bytes += u.byteLength;
        chunks++;
        controller.enqueue(u);
        if (watcher) {
            watcher.s.tick();
            if (chunks % watcher.every === 0) watcher.s.mark();
        }
    };
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!opened) {
                opened = true;
                if (open !== '') {
                    emit(controller, open);
                    return;
                }
            }
            if (next >= rows) {
                if (close !== '') emit(controller, close);
                controller.close();
                return;
            }
            const end = Math.min(next + ROWS_PER_CHUNK, rows);
            emit(controller, chunkFor(next, end));
            next = end;
        },
    });
    return {
        body,
        wire: () => bytes,
        enqueued: () => chunks,
        watch: (s, marks) => {
            watcher = {
                s,
                every: Math.max(1, Math.ceil(rows / ROWS_PER_CHUNK / marks)),
            };
        },
    };
}

/**
 * ONE top-level JSON array, streamed element by element: `[{…},{…},…]`. The shape the scenario is
 * about — a `\n` split cannot recover the records, only a structural parser can.
 */
export function singleArray(
    rows: number,
    row: (i: number) => unknown = productRow,
): Wire {
    return lazyWire(
        (start, end) => {
            const parts: string[] = [];
            for (let i = start; i < end; i++)
                parts.push((i === 0 ? '' : ',') + JSON.stringify(row(i)));
            return parts.join('');
        },
        '[',
        ']',
        rows,
    );
}

/**
 * CONCATENATED top-level values with no separator and no newline: `{…}{…}{…}`. The `'json'` decoder
 * advertises this shape alongside the single array, and it is the control that localises C3's
 * finding: same decoder, same records, same bytes — the only difference is whether they sit inside
 * one top-level array or stand as siblings.
 */
export function concatObjects(rows: number): Wire {
    return lazyWire(
        (start, end) => {
            const parts: string[] = [];
            for (let i = start; i < end; i++)
                parts.push(JSON.stringify(productRow(i)));
            return parts.join('');
        },
        '',
        '',
        rows,
    );
}

/** Newline-delimited JSON — one record per line. The easy case, and the measurement's control. */
export function ndjson(
    rows: number,
    row: (i: number) => unknown = productRow,
): Wire {
    return lazyWire(
        (start, end) => {
            const parts: string[] = [];
            for (let i = start; i < end; i++)
                parts.push(`${JSON.stringify(row(i))}\n`);
            return parts.join('');
        },
        '',
        '',
        rows,
    );
}

/**
 * The same single array, but every byte is enqueued at once instead of on demand — a producer that
 * ignores the reader's backpressure signal entirely. The whole body sits in the stream's internal
 * queue before the consumer reads its second chunk (C6).
 */
export function eagerArray(rows: number): Wire {
    let bytes = 0;
    let chunks = 0;
    let dumped = false;
    let watcher: { s: WireSampler; every: number } | undefined;
    const body = new ReadableStream<Uint8Array>({
        // On the FIRST pull, dump the entire body into the stream's internal queue without ever
        // consulting `desiredSize`. That is what "ignores backpressure" means for a `ReadableStream`
        // source, and doing it on first pull rather than in `start()` keeps the allocation inside the
        // measured window instead of before the baseline was taken.
        pull(controller) {
            if (dumped) {
                controller.close();
                return;
            }
            dumped = true;
            const emit = (s: string): void => {
                const u = enc.encode(s);
                bytes += u.byteLength;
                chunks++;
                controller.enqueue(u);
                if (watcher) {
                    watcher.s.tick();
                    if (chunks % watcher.every === 0) watcher.s.mark();
                }
            };
            emit('[');
            for (let start = 0; start < rows; start += ROWS_PER_CHUNK) {
                const end = Math.min(start + ROWS_PER_CHUNK, rows);
                const parts: string[] = [];
                for (let i = start; i < end; i++)
                    parts.push(
                        (i === 0 ? '' : ',') + JSON.stringify(productRow(i)),
                    );
                emit(parts.join(''));
            }
            emit(']');
            controller.close();
        },
    });
    return {
        body,
        wire: () => bytes,
        enqueued: () => chunks,
        watch: (s, marks) => {
            watcher = {
                s,
                every: Math.max(1, Math.ceil(rows / ROWS_PER_CHUNK / marks)),
            };
        },
    };
}

/** A body that never closes its first element — the `stream.buffer.chars` cap's target case (C6). */
export function neverClosingArray(rows: number): Wire {
    // A nested array opened as element 0 and never closed: every subsequent record lands inside one
    // un-terminated value, which is precisely what the cap exists to stop.
    return lazyWire(
        (start, end) => {
            const parts: string[] = [];
            for (let i = start; i < end; i++)
                parts.push(`${JSON.stringify(productRow(i))},`);
            return parts.join('');
        },
        '[[',
        '',
        rows,
    );
}

/** A body with no `\n` at all — the `'lines'`/`'ndjson'` cap's target case (C6). */
export function noNewlines(rows: number): Wire {
    return lazyWire(
        (start, end) => {
            const parts: string[] = [];
            for (let i = start; i < end; i++)
                parts.push(JSON.stringify(productRow(i)));
            return parts.join(' ');
        },
        '',
        '',
        rows,
    );
}

/** An adapter that hands back the live body. Mirrors `fetchAdapter` when `req.stream` is set. */
export function streamingAdapter(wire: Wire, status = 200): Adapter {
    return (req: AdapterRequest): Promise<AdapterResponse> => {
        if (!req.stream)
            return Promise.reject(new Error('expected req.stream to be set'));
        return Promise.resolve({ status, headers: {}, body: wire.body });
    };
}

/** Sampling hooks a buffering transport offers, so the peak can be measured where it happens. */
export interface BufferHooks {
    /** After every socket read — a cheap sample. */
    onChunk?: () => void;
    /** At the two instants that matter: whole text live, then text AND parsed tree live. */
    onPeak?: () => void;
}

/**
 * An adapter that BUFFERS, byte for byte the way `fetchAdapter` does on the non-streaming path
 * (`http-adapter.ts:133-138`): read the body to one string, then `JSON.parse` it.
 *
 * The chunks are collected and `join`ed once rather than `+=`'d, which is the cheaper of the two and
 * the closer match to what `response.text()` does — the honest choice, since the point here is to
 * measure the library's floor rather than to inflate it.
 *
 * `onPeak` fires at the two instants the caller cannot otherwise see: with the whole wire text live
 * and nothing parsed, and with the text AND the object tree both live. The second is the buffered
 * path's true high-water mark, and by the time `await stitch()` resolves it has already passed.
 */
export function bufferingAdapter(wire: Wire, hooks: BufferHooks = {}): Adapter {
    return async (req: AdapterRequest): Promise<AdapterResponse> => {
        if (req.stream)
            return Promise.reject(new Error('did not expect req.stream'));
        const reader = wire.body.getReader();
        const decoder = new TextDecoder();
        let parts: string[] = [];
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            parts.push(decoder.decode(r.value, { stream: true }));
            hooks.onChunk?.();
        }
        parts.push(decoder.decode());
        const text = parts.join('');
        parts = []; // release the pieces; only the flat string survives
        hooks.onPeak?.(); // the whole wire text is live and nothing is parsed yet
        const parsed: unknown = JSON.parse(text);
        hooks.onPeak?.(); // text AND tree are both live — the buffered path's true peak
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: parsed,
        };
    };
}

// ---- correctness fixtures (C3) -------------------------------------------------------------
// The structural decoder's claim is not only "flat heap" but "right boundaries". These are the
// adversarial bodies: things a `\n` split or a naive `},{` split gets wrong.

/** A pretty-printed array — every record spans multiple LINES. `'ndjson'` cannot read this. */
export const PRETTY_ARRAY = `[
  {
    "id": "a",
    "note": "line one"
  },
  {
    "id": "b",
    "nested": { "deep": [1, 2, { "x": "}" }] }
  }
]`;

/** Records whose STRING VALUES contain the structural characters and escaped quotes. */
export const HOSTILE_ARRAY =
    '[' +
    JSON.stringify({ id: 1, s: 'has , comma and ] bracket and } brace' }) +
    ',' +
    JSON.stringify({ id: 2, s: 'embedded \n newline and "quotes"' }) +
    ',' +
    JSON.stringify({ id: 3, s: 'unicode   and escape \\" tail' }) +
    ',' +
    JSON.stringify({
        id: 4,
        nested: [
            [1, 2],
            [3, [4, 5]],
        ],
        obj: { a: { b: { c: [] } } },
    }) +
    ']';

/** A stream that emits `text` split at EVERY `at` boundary, to place chunk splits mid-token. */
export function splitStream(text: string, at: number): Wire {
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += at)
        pieces.push(text.slice(i, i + at));
    let i = 0;
    let bytes = 0;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= pieces.length) {
                controller.close();
                return;
            }
            const u = enc.encode(pieces[i++] as string);
            bytes += u.byteLength;
            chunks++;
            controller.enqueue(u);
        },
    });
    return {
        body,
        wire: () => bytes,
        enqueued: () => chunks,
        watch: () => undefined, // correctness fixture — nothing to sample
    };
}
