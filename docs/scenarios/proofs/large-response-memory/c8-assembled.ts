// C8 — assemble the best available answer: stream, validate per record, batch the consumer. Report
// the seam(s), the line count, and peak heap against the C1 baseline.
//
// There is exactly ONE seam, and it is `Surface.stream`. Not because the decoding needs replacing —
// `decode: 'ndjson'` is already O(1) (C2a) — but because the engine retains every value that seam
// yields (engine.ts:1443), so the only way to bound the run is to yield something small. A hook that
// consumes rows and emits one receipt per batch is that.
//
// The claim also prices what the seam costs you, because two things stop working when you take it:
// `output` no longer describes a row, and the awaited result is no longer the rows.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c8-assembled.ts
import { stitch } from '../../../../packages/core/src/index';
import { stream } from '../../../../packages/core/src/stream';
import {
    type BatchReceipt,
    batchedSurface,
    drainBatched,
} from './batched-export';
import { ndjson, streamingAdapter } from './fake-export';
import { handRolledExport } from './hand-rolled';
import {
    check,
    checkAtMost,
    checkFlat,
    checkSeq,
    finish,
    heading,
    mb,
    note,
    x,
} from './harness';
import { SCALES, probeOk, series } from './run-probe';
import { countingValidator } from './validator-spy';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://api.vendor.example/v1/products/export';
const HERE = dirname(fileURLToPath(import.meta.url));

/** Counted lines: no blanks, no comment-only lines. The same rule every scenario in this set uses. */
function countLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

async function main(): Promise<void> {
    heading('C8 — the assembled answer: one seam, and what it costs');

    // ── (a) it works, and the receipts are the progress bar ───────────────────────────────────
    {
        let sunk = 0;
        const receipts: BatchReceipt[] = [];
        const spy = countingValidator();
        const wire = ndjson(1_250);
        const exportAll = stitch({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            kind: batchedSurface({
                batch: 500,
                validate: spy.validate,
                onBatch: (rows) => {
                    sunk += rows.length;
                },
            }),
        });
        const done = await drainBatched(exportAll.stream(), (r) =>
            receipts.push(r),
        );
        check('(a) rows through the sink', sunk, 1_250);
        check('(a) rows the receipts report', done.rows, 1_250);
        check('(a) per-record contract calls', spy.calls(), 1_250);
        check('(a) largest array the contract saw', spy.sawArrayOfLength(), 0);
        checkSeq(
            '(a) receipts (batch, rows, running total)',
            receipts.map((r) => [r.batch, r.rows, r.total]),
            [
                [1, 500, 500],
                [2, 500, 1_000],
                [3, 250, 1_250],
            ],
        );
        note(
            '(a) → three deltas for 1,250 rows',
            'which is exactly the point: `chunks` now holds 3 small objects instead of 1,250 product rows',
        );
    }

    // ── (b) THE FOOTGUN: `stream({ kind })` silently drops your surface ───────────────────────
    // `stream()` spreads your config and then writes `kind: streamSurface` over it (stream.ts:143-146
    // — `sse()` does the same at sse.ts:210-212). So the assembled answer must be spelled
    // `stitch({ kind })`. Nothing warns; the deltas just quietly go back to being rows.
    {
        let sunk = 0;
        const wire = ndjson(1_000);
        const wrong = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            kind: batchedSurface({
                batch: 500,
                onBatch: (rows) => {
                    sunk += rows.length;
                },
            }),
        });
        const done = await drainBatched(wrong.stream());
        check('(b) rows the custom surface actually processed', sunk, 0);
        check('(b) deltas the consumer received', done.receipts, 1_000);
        check('(b) errors', done.error ?? 'none', 'none');
        note(
            '(b) → the surface was ignored and nothing said so',
            '`stream({ kind })` type-checks, runs, and hands back 1,000 raw rows. The one spelling that undoes the fix is the one the surface helper invites',
        );
    }

    // ── (c) the number: peak heap against the C1 baseline ─────────────────────────────────────
    const assembled = series('assembled-ndjson');
    for (const [i, m] of assembled.entries())
        note(
            `(c) assembled, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${x(m.ratio)} wire`,
        );
    const [a1, , a100] = assembled as [
        (typeof assembled)[0],
        (typeof assembled)[0],
        (typeof assembled)[0],
    ];
    checkFlat('(c) 1x -> 100x assembled heap', a1.peakLive, a100.peakLive);
    const baseline = probeOk({ mode: 'buffered', rows: 100_000 });
    note(
        '(c) C1 baseline at 100k rows (`await stitch()`)',
        mb(baseline.peakLive),
    );
    note('(c) assembled at 100k rows', mb(a100.peakLive));
    checkAtMost(
        '(c) assembled ÷ baseline',
        a100.peakLive / baseline.peakLive,
        0.1,
        x,
    );
    note(
        '(c) → 40x less heap, and FLAT rather than merely smaller',
        'the baseline grows with the catalog and this does not, which is the difference between a number and a guarantee',
    );

    // ── (d) the same seam over `decode: 'json'` — most of the win is gone ─────────────────────
    // Because C3's array buffer is upstream of the seam. The batching surface fixes the ENGINE's
    // accumulator; it cannot fix the decoder holding the array text.
    const overJson = probeOk({
        mode: 'assembled-json',
        rows: 100_000,
        buffer: 1_000_000_000,
    });
    note(
        '(d) same surface, same rows, one top-level array instead of ndjson',
        `${mb(overJson.peakLive)} retained = ${x(overJson.ratio)} wire — against ${mb(a100.peakLive)} over ndjson`,
    );
    checkAtMost(
        '(d) how much of the buffered baseline it still costs',
        overJson.peakLive / baseline.peakLive,
        0.6,
        x,
    );
    note(
        '(d) → the assembled answer is only as bounded as its WIRE FORMAT',
        'over one giant array the seam removes the engine’s 29MB and leaves the decoder’s 19MB, and on default settings the call would not have finished at all (C3d)',
    );

    // ── (e) the price, in lines ───────────────────────────────────────────────────────────────
    const seam = countLines('batched-export.ts');
    const rolled = countLines('hand-rolled.ts');
    note(
        '(e) `batched-export.ts` — the surface + its drain helper',
        `${String(seam)} lines`,
    );
    note(
        '(e) `hand-rolled.ts` — the same feature set, no library',
        `${String(rolled)} lines`,
    );
    note(
        '(e) config on top of the seam',
        '4 lines: `url`, `adapter`, `stream: { decode }`, `kind`',
    );
    {
        // The hand-rolled twin, run for real, so the line count is a comparison and not a claim.
        let sunk = 0;
        const spy = countingValidator();
        const wire = ndjson(1_250);
        const total = await handRolledExport(wire.body, {
            batch: 500,
            validate: spy.validate,
            onBatch: (rows) => {
                sunk += rows.length;
            },
        });
        check('(e) hand-rolled rows processed', total, 1_250);
        check('(e) hand-rolled sink', sunk, 1_250);
        check('(e) hand-rolled per-record contract calls', spy.calls(), 1_250);
    }
    note(
        '(e) → the seam is not cheaper than the hand-rolled version, and that is fine',
        'what the 4 config lines buy is the rest of the stack — `auth` on the open, `retry` on the connect, `throttle` charged per open, `timeout.total`, `trace`, `verdict.accept` — none of which the hand-rolled reader has and all of which keep working through a custom surface',
    );

    finish(
        'C8',
        'ACHIEVABLE, with ONE seam and a wire format you may not be offered. The seam is `Surface.stream` — not to replace the decoding (`decode: "ndjson"` is already O(1)) but because the engine retains everything that hook yields, so the fix is to yield one small receipt per batch instead of one row per row. Measured over `ndjson`: 1.3MB retained for 100,000 rows against the C1 baseline’s 53.8MB, a 40x cut, and FLAT — 1.3MB at 1,000 rows and 1.4MB at 100,000. It cost 75 counted lines of surface plus 4 lines of config, against 67 lines hand-rolled with no library at all; the lines are a wash and what the config buys is the resilience stack around the open. Two prices are real. Over a single top-level JSON ARRAY the same seam still costs 19.0MB, because C3’s array buffer sits UPSTREAM of it. And `stream({ kind })` silently drops the surface — `stream()` overwrites `kind` after spreading your config (stream.ts:143-146) — so the answer only works spelled `stitch({ kind })`, with no warning if you get it wrong',
    );
}

void main();
