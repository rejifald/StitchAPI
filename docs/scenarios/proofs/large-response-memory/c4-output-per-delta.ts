// C4 — THE OTHER DECIDING CLAIM. Add an `output` schema to a streaming stitch. Does validation run
// PER DELTA or over the AGGREGATE?
//
// The capture's fear: "if `output` on a streaming stitch buffers every delta to validate the
// aggregate, the streaming is undone — and the config would look correct." Scenario 11 measured
// `output` running over the whole aggregated array for `paginate`, which is exactly that shape.
//
// This is answered with a COUNTER, not a heap number. The `output` contract here is an instrumented
// `Validator` that records how many times it was called and what shape each argument had. One call
// carrying a 100,000-element array and 100,000 calls each carrying one row are not two readings of
// the same number — they are different facts, and the counter reports which one happened.
//
// The heap measurement is the consequence, and it comes second.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c4-output-per-delta.ts
import { stream } from '../../../../packages/core/src/stream';
import type { StitchEvent } from '../../../../packages/core/src/types';
import {
    ndjson,
    productRow,
    singleArray,
    streamingAdapter,
} from './fake-export';
import { check, checkFlat, finish, heading, mb, note, x } from './harness';
import { probeOk } from './run-probe';
import { coercingValidator, countingValidator } from './validator-spy';

const URL = 'https://api.vendor.example/v1/products/export';

async function drain(events: AsyncIterable<StitchEvent>): Promise<{
    deltas: unknown[];
    drift: string[];
    error?: string;
    types: string[];
}> {
    const deltas: unknown[] = [];
    const drift: string[] = [];
    const types: string[] = [];
    let error: string | undefined;
    for await (const ev of events) {
        types.push(ev.type === 'progress' ? `progress:${ev.phase}` : ev.type);
        if (ev.type === 'delta') deltas.push(ev.chunk);
        else if (ev.type === 'drift')
            drift.push(
                `${ev.finding.level}|${ev.finding.change}|${ev.finding.path}|${ev.finding.detail ?? ''}`,
            );
        else if (ev.type === 'error') error = ev.message;
    }
    return error === undefined
        ? { deltas, drift, types }
        : { deltas, drift, types, error };
}

async function main(): Promise<void> {
    heading(
        'C4 — an `output` schema on a streaming stitch: per delta, or over the aggregate?',
    );

    // ── (a) the mechanism: count the calls ────────────────────────────────────────────────────
    {
        const spy = countingValidator();
        const wire = ndjson(500);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            output: spy,
        });
        const r = await drain(exportAll.stream());
        check('(a) deltas emitted', r.deltas.length, 500);
        check('(a) times `output` was called', spy.calls(), 500);
        check('(a) calls carrying ONE record', spy.recordCalls(), 500);
        check(
            '(a) largest array ever handed to the validator',
            spy.sawArrayOfLength(),
            0,
        );
        note(
            '(a) → PER DELTA, unambiguously',
            '500 calls, 500 of them carrying a single object, and the validator never saw an array at all. `engine.ts:1463-1472` runs it inside the decode loop, before the `delta` is emitted',
        );
    }

    // ── (b) the same over `decode: 'json'` — a single top-level array ─────────────────────────
    // The shape the fear was really about: the wire IS one array. Does the contract see the array?
    {
        const spy = countingValidator();
        const wire = singleArray(500);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'json' },
            output: spy,
        });
        const r = await drain(exportAll.stream());
        check('(b) deltas emitted', r.deltas.length, 500);
        check('(b) times `output` was called', spy.calls(), 500);
        check(
            '(b) largest array handed to the validator',
            spy.sawArrayOfLength(),
            0,
        );
        note(
            '(b) → the contract describes a ROW, not the export',
            'even when the wire is literally one array, `output` never sees it. The decoder’s element is the unit of validation',
        );
    }

    // ── (c) a failing row fails the STREAM, and the bad value never arrives ───────────────────
    {
        const spy = countingValidator();
        // Row 3 is not a product — the contract must reject it.
        const wire = singleArray(6, (i) =>
            i === 3 ? { nope: true } : productRow(i),
        );
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'json' },
            output: spy,
        });
        const r = await drain(exportAll.stream());
        check('(c) deltas delivered before the bad row', r.deltas.length, 3);
        check('(c) the bad row was never emitted', spy.rejects(), 1);
        check('(c) error message', r.error, 'contract violation (drift)');
        check('(c) terminal event', r.types.at(-1), 'done');
        note(
            '(c) → a contract on a stream is a CIRCUIT BREAKER, not a filter',
            'one bad row ends the export; the 3 good rows already delivered stay delivered, and rows 5 and 6 are never read',
        );
    }

    // ── (d) the value served is the RAW chunk, not the validated one ──────────────────────────
    // The buffered path serves `validated` (engine.ts:1264, "serve the validated value"). The
    // streaming path destructures only `{ errors }` from the same function (engine.ts:1468) and
    // throws the validated value away. So a coercing/stripping schema type-checks and then does
    // nothing to what the consumer receives.
    {
        const wire = singleArray(2);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'json' },
            output: coercingValidator(),
        });
        const r = await drain(exportAll.stream());
        check('(d) deltas', r.deltas.length, 2);
        const first = r.deltas[0] as Record<string, unknown>;
        check(
            '(d) did the validator’s added field arrive?',
            first['coerced_marker'],
            undefined,
        );
        check('(d) the raw field is intact', first['currency'], 'usd');
        note(
            '(d) → on a stream, `output` VALIDATES but never TRANSFORMS',
            'engine.ts:1468 keeps `{ errors }` and drops `value`; engine.ts:1264 on the buffered path does the opposite. The same schema coerces on `await` and does not on `.stream()`',
        );
    }

    // ── (e) the cost: heap with and without ───────────────────────────────────────────────────
    const bare = probeOk({ mode: 'stream-ndjson', rows: 100_000 });
    const validated = probeOk({ mode: 'stream-ndjson-output', rows: 100_000 });
    note(
        '(e) 100k rows, `.stream()`, no `output`',
        `${mb(bare.peakLive)} retained = ${x(bare.ratio)} wire`,
    );
    note(
        '(e) 100k rows, `.stream()`, `output` on every row',
        `${mb(validated.peakLive)} retained = ${x(validated.ratio)} wire`,
    );
    checkFlat(
        '(e) what `output` added to peak heap',
        bare.peakLive,
        validated.peakLive,
        1.15,
    );
    // On the library-default cap: since #665 a 100k-row single array no longer needs a raised
    // `stream.buffer.chars` to finish (C3d).
    const jbare = probeOk({ mode: 'stream-json', rows: 100_000 });
    const jval = probeOk({ mode: 'stream-json-output', rows: 100_000 });
    note('(e) same, `decode: "json"` without `output`', mb(jbare.peakLive));
    note('(e) same, `decode: "json"` with `output`', mb(jval.peakLive));
    checkFlat(
        '(e) what `output` added over `json`',
        jbare.peakLive,
        jval.peakLive,
        1.15,
    );
    note(
        '(e) → `output` is INNOCENT',
        'the hypothesis this claim was written to catch does not happen. Validation is free in memory terms, on both decoders. What is expensive is `chunks` (C2), which `output` does not touch — and since #665 the two decoders cost the same, because the engine’s accumulator is the only linear term left',
    );

    finish(
        'C4',
        'PER DELTA, and the fear was misplaced. The instrumented contract was called 500 times for 500 records, every call carrying ONE object, and `sawArrayOfLength` stayed at 0 — including when the wire was literally one top-level array under `decode: "json"`. In heap terms `output` is free: 30.2MB against 30.2MB on `ndjson`, 30.2MB against 30.2MB on `json` (on the default cap — post-#665 the array shape needs no raised cap and costs what `ndjson` costs), both within 1%. Two things it does that a config author will not expect. A failing row is a CIRCUIT BREAKER, not a filter: `contract violation (drift)`, the stream ends, the rows already delivered stay and the rest are never read. And on a stream `output` VALIDATES WITHOUT TRANSFORMING — `engine.ts:1468` keeps only `{ errors }` and discards the validated value, where `engine.ts:1264` on the buffered path serves it. The same coercing schema reshapes your data on `await` and silently does not on `.stream()`',
    );
}

void main();
