// C2 — `stream` with `decode: 'ndjson'`. Does peak heap stay FLAT as the body grows 1x / 10x / 100x?
//
// This was supposed to be the control that proves the measurement works. It is — and it also
// contains the finding the rest of this directory turns on, because the flat half and the linear
// half are in the same call:
//
//   (a) the DECODER, called exactly as the engine calls it, is O(1). 1M rows / 214MB of wire ran in
//       0.8MB of retained heap.
//   (b) the same decoder THROUGH the engine is O(N), because `runStreaming` keeps every delta it
//       emits (engine.ts:1492) so the terminal `result` can mirror the whole spine.
//   (c) `.stream()` does not opt out of (b). It costs what `await` costs.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c2-ndjson-flat.ts
import {
    check,
    checkFlat,
    checkLinear,
    finish,
    heading,
    mb,
    note,
    x,
} from './harness';
import { SCALES, probeOk, series } from './run-probe';

function main(): void {
    heading('C2 — `decode: "ndjson"`: is the streaming path flat?');

    // ── (a) the decoder alone — the control ───────────────────────────────────────────────────
    // `streamSurface.stream(res, cfg)` is the exact call the engine makes (engine.ts:1452). Driving
    // it directly measures the decoder with nothing accumulating around it.
    const decoder = series('decoder-ndjson');
    for (const [i, m] of decoder.entries())
        note(
            `(a) decoder alone, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${x(m.ratio)} wire`,
        );
    const [d1, d10, d100] = decoder as [
        (typeof decoder)[0],
        (typeof decoder)[0],
        (typeof decoder)[0],
    ];
    checkFlat('(a) 1x -> 100x decoder heap', d1.peakLive, d100.peakLive);
    checkFlat('(a) 10x -> 100x decoder heap', d10.peakLive, d100.peakLive);
    // 100x again on top, to put the claim beyond any argument about constants.
    const huge = probeOk({ mode: 'decoder-ndjson', rows: 1_000_000 });
    note(
        '(a) decoder alone, 1,000,000 rows',
        `${mb(huge.wireBytes)} wire -> ${mb(huge.peakLive)} retained = ${x(huge.ratio)}`,
    );
    check('(a) records decoded at 1M', huge.records, 1_000_000);
    checkFlat('(a) 1k -> 1M decoder heap', d1.peakLive, huge.peakLive);
    note(
        '(a) → the measurement instrument is sound',
        'a 1000x change in the workload moved retained heap by less than 15%',
    );

    // ── (b) the same decoder through the engine ───────────────────────────────────────────────
    const engine = series('stream-ndjson');
    for (const [i, m] of engine.entries())
        note(
            `(b) via .stream(), ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${x(m.ratio)} wire`,
        );
    const [, e10, e100] = engine as [
        (typeof engine)[0],
        (typeof engine)[0],
        (typeof engine)[0],
    ];
    checkLinear('(b) 10x -> 100x engine heap', e10.peakLive, e100.peakLive, 6);
    note(
        '(b) 1x is reported but NOT asserted on',
        'at 1000 rows the run’s one-time cost (module init, JIT, IC feedback — ~1.3MB, visible as `settled`) is six times the data, so the 1x point cannot carry a growth claim. 10x -> 100x is where the signal is clean',
    );
    const cost = e100.peakLive - d100.peakLive;
    note(
        '(b) what the engine added at 100k rows',
        `${mb(d100.peakLive)} (decoder) -> ${mb(e100.peakLive)} (engine) = +${mb(cost)}`,
    );
    note(
        '(b) → engine.ts:1492 `chunks.push(chunk)`',
        'unconditional, ungated by accessor, with no config that turns it off. The decoder streams; the engine collects',
    );

    // ── (c) `.stream()` vs `await` — the accessor changes nothing ─────────────────────────────
    const awaited = probeOk({ mode: 'stream-ndjson-await', rows: 100_000 });
    note('(c) `.stream()` at 100k', mb(e100.peakLive));
    note('(c) `await` at 100k', mb(awaited.peakLive));
    checkFlat(
        '(c) `.stream()` vs `await`',
        Math.min(e100.peakLive, awaited.peakLive),
        Math.max(e100.peakLive, awaited.peakLive),
        1.3,
    );
    note(
        '(c) → “iterate instead of awaiting” is not a memory fix here',
        'both accessors drain the same generator, and the accumulator is inside it',
    );

    finish(
        'C2',
        'NO — and the two halves of the answer are in the same call. The DECODER is flat: driven directly, `decode: "ndjson"` held 0.8MB of retained heap for 1,000,000 rows and 214MB of wire, and moved less than 15% across a 1000x change in workload. Through the ENGINE the same decoder is linear — 3.5MB -> 30.2MB from 10k to 100k rows — because `runStreaming` pushes every delta onto a `chunks` array (engine.ts:1492) so the terminal `result` can mirror the whole spine. `.stream()` does not escape it: 30.2MB iterating against 33.5MB awaiting, the same number twice. The library owns a genuinely O(1) NDJSON decoder and then spends the win one line later',
    );
}

main();
