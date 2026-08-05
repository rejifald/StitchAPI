// C6 — backpressure. A slow consumer against a fast producer. Does the stream buffer unboundedly?
// And what does `stream.buffer.chars` do AT the cap — throw, truncate, or block?
//
// Three separate mechanisms wear the word "buffer" here and they behave differently, so this claim
// keeps them apart:
//   (a) the SOCKET QUEUE — the `ReadableStream`'s internal queue. Bounded by the reader pulling,
//       and invisible to `heapUsed` because a `Uint8Array`'s backing store is external memory.
//   (b) the DECODER's working buffer — what `stream.buffer.chars` caps. Per un-terminated UNIT.
//   (c) the ENGINE's `chunks` array — capped by nothing at all.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c6-backpressure.ts
import { stream } from '../../../../packages/core/src/stream';
import type { StitchEvent } from '../../../../packages/core/src/types';
import {
    ndjson,
    neverClosingArray,
    noNewlines,
    singleArray,
    streamingAdapter,
} from './fake-export';
import {
    check,
    checkAtLeast,
    checkAtMost,
    checkSeq,
    finish,
    heading,
    mb,
    note,
} from './harness';
import { probeOk } from './run-probe';

/** A fraction as `1.4%` — `x()`'s one decimal place rounds these to `0.0x` and hides the point. */
const pct = (f: number): string => `${(f * 100).toFixed(1)}%`;

const URL = 'https://api.vendor.example/v1/products/export';

interface Drained {
    deltas: number;
    error?: string;
    types: string[];
}

async function drain(
    events: AsyncIterable<StitchEvent>,
    onDelta?: (n: number) => Promise<void> | void,
): Promise<Drained> {
    let deltas = 0;
    const types: string[] = [];
    let error: string | undefined;
    for await (const ev of events) {
        types.push(ev.type === 'progress' ? `progress:${ev.phase}` : ev.type);
        if (ev.type === 'delta') {
            deltas++;
            await onDelta?.(deltas);
        } else if (ev.type === 'error') error = ev.message;
    }
    return error === undefined ? { deltas, types } : { deltas, types, error };
}

async function main(): Promise<void> {
    heading(
        'C6 — a slow consumer, a fast producer, and three different buffers',
    );

    // ── (a) does a slow consumer slow the producer? ───────────────────────────────────────────
    // The consumer awaits a macrotask per delta — as slow as a real database insert. If backpressure
    // did not propagate, the producer would race to the end of the body while the consumer crawled.
    {
        const wire = ndjson(2_000);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
        });
        let chunksAt100 = 0;
        await drain(exportAll.stream(), async (n) => {
            if (n === 100) chunksAt100 = wire.enqueued();
            await new Promise<void>((r) => setTimeout(r, 0));
        });
        const total = wire.enqueued();
        note(
            '(a) wire chunks the producer had emitted when the consumer had seen 100 of 2000 rows',
            `${String(chunksAt100)} of ${String(total)}`,
        );
        checkAtMost('(a) producer chunks ahead at row 100', chunksAt100, 8);
        check('(a) producer chunks in total', total, 32);
        note(
            '(a) → backpressure PROPAGATES, end to end',
            'the chain is pull-based the whole way — `reader.read()` -> the decoder generator -> `runStreaming`’s `yield` -> your `for await`. A slow consumer really does stop the socket',
        );
    }

    // ── (b) a producer that ignores it — and why `heapUsed` will not show you ─────────────────
    // Same body, same consumer, but the source enqueues everything without consulting `desiredSize`.
    // The whole response then sits in the stream's internal queue as `Uint8Array`s — which live in
    // EXTERNAL memory, so `heapUsed` reports nothing at all. `arrayBuffers` is where it shows.
    {
        const lazy = probeOk({
            mode: 'stream-json',
            rows: 100_000,
            buffer: 1_000_000_000,
        });
        const eager = probeOk({
            mode: 'eager-json',
            rows: 100_000,
            buffer: 1_000_000_000,
        });
        note(
            '(b) lazy producer, 100k rows',
            `queue high-water ${mb(lazy.peakBuffers)} of ${mb(lazy.wireBytes)} wire = ${pct(lazy.peakBuffers / lazy.wireBytes)}`,
        );
        note(
            '(b) producer that ignores backpressure, same 100k rows',
            `queue high-water ${mb(eager.peakBuffers)} of ${mb(eager.wireBytes)} wire = ${pct(eager.peakBuffers / eager.wireBytes)}`,
        );
        checkAtMost(
            '(b) lazy producer’s queue as a fraction of the body',
            lazy.peakBuffers / lazy.wireBytes,
            0.05,
            pct,
        );
        checkAtLeast(
            '(b) eager producer’s queue as a fraction of the body',
            eager.peakBuffers / eager.wireBytes,
            0.99,
            pct,
        );
        note(
            '(b) → the queue is not capped by anything StitchAPI owns',
            '`stream.buffer.chars` counts DECODED CHARACTERS in the decoder; the bytes queued ahead of the decoder are the transport’s business. And they are invisible to `process.memoryUsage().heapUsed` — measure `arrayBuffers` or you will conclude a 21MB backlog is free',
        );
    }

    // ── (c) AT the cap: throw, truncate, or block? ────────────────────────────────────────────
    // Three decoders, three un-terminated shapes, one cap. THROW in every case — surfaced as an
    // `error` event, never a truncation and never a pause.
    {
        const cases: {
            label: string;
            decode: 'json' | 'ndjson' | 'lines';
            body: () => ReturnType<typeof singleArray>;
        }[] = [
            {
                label: 'json / a value that never closes',
                decode: 'json',
                body: () => neverClosingArray(5_000),
            },
            {
                label: 'ndjson / a body with no newline',
                decode: 'ndjson',
                body: () => noNewlines(5_000),
            },
            {
                label: 'lines / a body with no newline',
                decode: 'lines',
                body: () => noNewlines(5_000),
            },
        ];
        for (const c of cases) {
            const wire = c.body();
            const exportAll = stream({
                url: URL,
                adapter: streamingAdapter(wire),
                stream: { decode: c.decode, buffer: { chars: 50_000 } },
            });
            const r = await drain(exportAll.stream());
            check(`(c) ${c.label} — deltas delivered`, r.deltas, 0);
            checkSeq(`(c) ${c.label} — terminal spine`, r.types.slice(-2), [
                'error',
                'done',
            ]);
            note(`(c) ${c.label} — message`, r.error ?? '(none)');
        }
        note(
            '(c) → THROW. Not truncate, not block',
            'the decoder raises, `runStreaming` turns it into an `error` event plus `done(ok:false)` (engine.ts:1446-1448, 1466-1472). The connection is torn down; no partial unit is delivered',
        );
    }

    // ── (d) the cap does NOT bound the run ────────────────────────────────────────────────────
    // The obvious misreading of `stream.buffer.chars` is "the memory ceiling for this stream". It is
    // not. It bounds ONE un-terminated unit. A million perfectly-terminated 200-byte lines pass a
    // 1,000-char cap one at a time — and the engine keeps every one of them.
    {
        const wire = ndjson(20_000);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson', buffer: { chars: 1_000 } },
        });
        const r = await drain(exportAll.stream());
        check(
            '(d) 20,000 rows through a 1,000-character cap',
            r.deltas,
            20_000,
        );
        check('(d) errors', r.error ?? 'none', 'none');
        const big = probeOk({ mode: 'stream-ndjson', rows: 100_000 });
        note(
            '(d) and the engine’s own accumulator at 100k rows',
            `${mb(big.peakLive)} retained, under any cap you like — \`chunks\` is not a decoder buffer`,
        );
        note(
            '(d) → `stream.buffer.chars` is a MALFORMED-INPUT guard, not a memory budget',
            'it answers "how long may one line / one un-closed value get", never "how much may this call use". The only stream it bounds in total is one whose records are pathological',
        );
    }

    finish(
        'C6',
        'Backpressure PROPAGATES and the cap THROWS — and neither fact bounds the call. A consumer awaiting a macrotask per row kept the producer within 8 chunks of 32: the chain is pull-based end to end, so a slow reader really does stop the socket, and a lazy producer’s queue stayed at 1.3% of the body. A producer that ignores `desiredSize` puts 100% of the body in the stream’s internal queue instead — and that backlog is INVISIBLE to `heapUsed`, because a `Uint8Array`’s store is external memory; it only shows in `arrayBuffers`. At the cap, all three decoders (`json`, `ndjson`, `lines`) THROW: an `error` event, `done(ok:false)`, zero deltas from the offending unit, no truncation and no pause. And the cap is a malformed-input guard, not a budget: 20,000 well-formed rows streamed cleanly through a 1,000-CHARACTER cap while the engine quietly accumulated all 20,000 of them',
    );
}

void main();
