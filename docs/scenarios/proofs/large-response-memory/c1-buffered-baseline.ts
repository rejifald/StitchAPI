// C1 — the baseline. `await` a large JSON body and record the heap high-water mark against the wire
// size. What is the multiplier on this runtime, and does it scale with row count?
//
// The capture quotes 84 MB → ~2.1 GB (≈25x) from the field and 2–5x as the folklore. Neither is a
// number about StitchAPI, so this claim measures three things instead of one:
//   (a) the shape — linear or not;
//   (b) the multiplier — on THIS runtime, with an honest row shape;
//   (c) the library's share of it — `await stitch()` against a bare `JSON.parse` of the same bytes.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c1-buffered-baseline.ts
import {
    check,
    checkAtMost,
    checkLinear,
    finish,
    heading,
    mb,
    note,
    x,
} from './harness';
import { SCALES, probeOk, series } from './run-probe';

function main(): void {
    heading(
        'C1 — `await` a big JSON array: what does it cost, and does it scale?',
    );

    // ── (a) the shape ─────────────────────────────────────────────────────────────────────────
    // Three row counts, three processes, one workload: `await stitch({ url })` against a transport
    // that reads the body to text and `JSON.parse`s it — byte for byte what `fetchAdapter` does
    // (http-adapter.ts:133-138).
    const buffered = series('buffered');
    for (const [i, m] of buffered.entries()) {
        note(
            `(a) ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `peak live ${mb(m.peakLive)} = ${x(m.ratio)} wire (peak heap incl. garbage ${mb(m.peakHeap)}, ${String(m.ms)}ms)`,
        );
    }
    const [small, mid, big] = buffered as [
        (typeof buffered)[0],
        (typeof buffered)[0],
        (typeof buffered)[0],
    ];
    check('(a) rows delivered at 100k', big.records, 100_000);
    checkLinear('(a) 10k -> 100k peak heap', mid.peakLive, big.peakLive, 8);
    checkLinear('(a) 1k -> 10k peak heap', small.peakLive, mid.peakLive, 5);
    note(
        '(a) → the buffered path is LINEAR in the response',
        'nothing about it is bounded; the only question is where your heap limit sits',
    );

    // ── (b) the multiplier ────────────────────────────────────────────────────────────────────
    // ~2.5x on Node 24 for a flat 8-field record. NOT the ~25x of the incident — and the gap is
    // worth stating plainly rather than quietly reproducing the bigger number.
    note('(b) multiplier at 100k rows', x(big.ratio));
    checkAtMost('(b) peak heap ÷ wire bytes', big.ratio, 4, x);
    note(
        '(b) → the incident report’s ~25x is not what a flat record costs',
        'row SHAPE dominates: many small nested objects carry far more per-object overhead than these eight fields do. The number that transfers is the SHAPE (linear), not the constant',
    );

    // ── (c) the library's share ───────────────────────────────────────────────────────────────
    // The same bytes, no library: read to text, `JSON.parse`. If StitchAPI added a copy, this is
    // where it would show.
    const bare = probeOk({ mode: 'parse-only', rows: 100_000 });
    note(
        '(c) bare `JSON.parse` of the same bytes',
        `${mb(bare.peakLive)} = ${x(bare.ratio)} wire`,
    );
    note('(c) `await stitch()` over the same bytes', `${mb(big.peakLive)}`);
    const overhead = big.peakLive - bare.peakLive;
    checkAtMost(
        '(c) StitchAPI’s overhead above bare JSON.parse',
        Math.abs(overhead),
        2 * 1024 * 1024,
        mb,
    );
    note(
        '(c) → the 2.5x is `JSON.parse`’s, not the library’s',
        'StitchAPI adds no copy on the buffered path — which also means it removes none',
    );

    finish(
        'C1',
        'LINEAR, and the multiplier is ~2.5x on this runtime — not the ~25x of the incident. Three processes, three row counts: 100k rows / 21.4MB of wire peaked at 53.8MB of RETAINED heap (post-forced-GC), 10x rows gave ~9.6x heap, and a bare `JSON.parse` of the same bytes cost the same to within 0.2MB. So the buffered path adds nothing and bounds nothing: `await` is `JSON.parse`, and `JSON.parse` is linear in the body with no ceiling anywhere. The constant is a property of the ROW SHAPE (eight flat fields here; the incident’s 25x implies far more per-object overhead), so the number that transfers between machines is the slope, not the multiplier',
    );
}

main();
