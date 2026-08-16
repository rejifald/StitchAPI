// The same feature set with no library at all — the baseline C8 prices against.
//
// Deliberately scoped to what the assembled StitchAPI answer actually delivers, no more: read an
// NDJSON body off a `ReadableStream`, carry a partial line across chunk boundaries, cap the carry so
// a body with no newline cannot grow memory without limit, validate every record, batch, and report
// progress per batch. No retry, no auth, no throttle, no timeout, no trace — those are the rows the
// library wins and C8 says so rather than pretending the comparison is like for like.
import type { Validator } from '../../../../packages/core/src/validator';
import type { BatchReceipt } from './batched-export';

export interface HandRolledOptions {
    batch: number;
    onBatch: (rows: unknown[]) => void | Promise<void>;
    onReceipt?: (r: BatchReceipt) => void;
    validate?: Validator['validate'];
    /** Cap on one un-terminated line, mirroring `stream.buffer.chars`. */
    maxLineChars?: number;
}

export async function handRolledExport(
    body: ReadableStream<Uint8Array>,
    opts: HandRolledOptions,
): Promise<number> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const cap = opts.maxLineChars ?? 8 * 1024 * 1024;
    let carry = '';
    let buf: unknown[] = [];
    let total = 0;
    let batch = 0;
    const take = async (line: string): Promise<void> => {
        if (line.trim() === '') return;
        const row: unknown = JSON.parse(line);
        if (opts.validate) {
            const r = await opts.validate(row);
            if (!r.ok)
                throw new Error(
                    `row ${String(total + buf.length)}: ${r.issues[0]?.message ?? 'invalid'}`,
                );
        }
        buf.push(row);
        if (buf.length < opts.batch) return;
        await opts.onBatch(buf);
        total += buf.length;
        batch++;
        opts.onReceipt?.({ batch, rows: buf.length, total });
        buf = [];
    };
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            carry += decoder.decode(r.value, { stream: true });
            let nl = carry.indexOf('\n');
            while (nl >= 0) {
                await take(carry.slice(0, nl));
                carry = carry.slice(nl + 1);
                nl = carry.indexOf('\n');
            }
            if (carry.length > cap)
                throw new Error('un-terminated line exceeded the cap');
        }
        carry += decoder.decode();
        for (const line of carry.split('\n')) await take(line);
        if (buf.length > 0) {
            await opts.onBatch(buf);
            total += buf.length;
            batch++;
            opts.onReceipt?.({ batch, rows: buf.length, total });
            buf = [];
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    return total;
}
