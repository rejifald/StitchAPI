// USER CODE — the assembled answer (C8). One custom {@link Surface}, and it exists for exactly one
// reason: the engine keeps every `delta` it emits.
//
//   engine.ts:1486-1492
//     // MEMORY NOTE: every chunk is accumulated so the awaited/`.stream()` result can mirror the
//     // whole delta spine ...
//     chunks.push(chunk);
//     yield { type: 'delta', chunk, at: now() };
//
// `chunks` is unconditional. It is not gated on the accessor — `.stream()` gets it too — and there
// is no config that turns it off. So `stream: { decode: 'json' }` streams the PARSE (the decoder's
// working set really is one record: C3) and then hands the whole array straight back to the heap.
//
// The seam that fixes it is `Surface.stream`. It is the last place a value exists before the engine
// sees it, so a hook that CONSUMES the rows and yields something small per batch keeps `chunks`
// bounded by the number of batches instead of the number of rows. Everything the engine wraps —
// auth, retry on the connect, throttle, timeout, trace, the `verdict` gate — still applies, because
// this is a surface, not a bypass.
//
// What you give up by doing it here, and it is not nothing:
//   - `output` no longer describes a row. The engine validates the DELTA, and the delta is now a
//     receipt (`engine.ts:1463-1472`), so the per-record contract has to move inside this hook.
//   - the awaited result is the receipts, not the rows. That is the point, but it means the call
//     site's type changes and every `for (const row of await …)` downstream has to change with it.
import { streamSurface } from '../../../../packages/core/src/stream';
import type { Surface } from '../../../../packages/core/src/surface';
import type { StitchEvent } from '../../../../packages/core/src/types';
import type { Validator } from '../../../../packages/core/src/validator';

/** What the consumer learns about a batch it already processed. Small, fixed size, no rows. */
export interface BatchReceipt {
    /** 1-based batch number. */
    batch: number;
    /** Rows in this batch (the last one is short). */
    rows: number;
    /** Rows processed so far, across every batch. */
    total: number;
}

export interface BatchedOptions {
    /** Rows to accumulate before handing them to `onBatch`. The memory ceiling, in records. */
    batch: number;
    /** Do the work — the database insert, the file write. Awaited, so it applies backpressure. */
    onBatch: (rows: unknown[]) => void | Promise<void>;
    /** Per-RECORD contract. Runs here because the engine's `output` now sees receipts, not rows. */
    validate?: Validator['validate'];
}

/**
 * The `stream` surface with a batching consumer folded into its decode hook. Configure the stitch
 * with `stream: { decode: 'json' }` exactly as before — this hook delegates the decoding to
 * `streamSurface.stream`, so `stream.decode` and `stream.buffer.chars` keep working.
 */
export function batchedSurface(opts: BatchedOptions): Surface {
    const decode = streamSurface.stream as NonNullable<Surface['stream']>;
    return {
        id: 'batched-json',
        stream: async function* batchedStream(res, cfg) {
            let buf: unknown[] = [];
            let total = 0;
            let batch = 0;
            for await (const row of decode(res, cfg)) {
                if (opts.validate) {
                    const r = await opts.validate(row);
                    if (!r.ok)
                        throw new Error(
                            `row ${String(total + buf.length)}: ${r.issues[0]?.message ?? 'invalid'}`,
                        );
                }
                buf.push(row);
                if (buf.length < opts.batch) continue;
                await opts.onBatch(buf);
                total += buf.length;
                batch++;
                const receipt: BatchReceipt = {
                    batch,
                    rows: buf.length,
                    total,
                };
                buf = []; // release the batch BEFORE yielding — the engine is about to retain what we yield
                yield receipt;
            }
            if (buf.length === 0) return;
            await opts.onBatch(buf);
            total += buf.length;
            batch++;
            const receipt: BatchReceipt = { batch, rows: buf.length, total };
            buf = [];
            yield receipt;
        },
    };
}

/** What a completed batched export produced. */
export interface BatchedRun {
    receipts: number;
    rows: number;
    /** The terminal `error` message, when the run failed. */
    error?: string;
}

/**
 * Drain a batched stitch's `.stream()`. The receipts are the progress bar — `total` after every
 * batch — and a failed run still reports how far it got, because the error arrives as an EVENT and
 * the rows before it are already committed.
 */
export async function drainBatched(
    events: AsyncIterable<StitchEvent>,
    onReceipt?: (r: BatchReceipt) => void,
): Promise<BatchedRun> {
    let receipts = 0;
    let rows = 0;
    let error: string | undefined;
    for await (const ev of events) {
        if (ev.type === 'delta') {
            const r = ev.chunk as BatchReceipt;
            receipts++;
            rows = r.total;
            onReceipt?.(r);
        } else if (ev.type === 'error') error = ev.message;
    }
    return error === undefined ? { receipts, rows } : { receipts, rows, error };
}
