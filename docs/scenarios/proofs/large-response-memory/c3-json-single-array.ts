// C3 — THE DECIDING CLAIM. `decode: 'json'` against ONE SINGLE TOP-LEVEL ARRAY.
//
// types.ts:1441-1450 documents it as "the structural, unframed streaming-JSON decoder (issue #111):
// one `delta` per complete value / top-level array element, tolerant of internal newlines and
// concatenated values". If that holds with bounded memory, the hard case of this whole scenario is a
// config value — a real capability few clients have.
//
// The answer is split, and the split is the finding:
//   (a) EMISSION is correct, and impressively so. Right count, right boundaries, records containing
//       `,` `]` `}` and escaped quotes inside strings, pretty-printed records spanning many lines,
//       nested arrays and objects, chunk boundaries placed one character apart.
//   (b) MEMORY is not bounded. The decoder retains the ENTIRE array text — 0.88x the wire, growing
//       linearly — because the compaction floor is pinned to the array's opening `[`.
//   (c) It therefore HITS ITS OWN CAP. On defaults, a single array larger than 8,388,608 characters
//       fails the stream, and the error blames the vendor for something the vendor did not do.
//   (d) The same records as CONCATENATED top-level values are flat. The defect is one branch, not
//       the decoder.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c3-json-single-array.ts
import { jsonStream } from '../../../../packages/core/src/json-stream';
import { JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS } from '../../../../packages/core/src/json-stream';
import { stream } from '../../../../packages/core/src/stream';
import type { StitchEvent } from '../../../../packages/core/src/types';
import {
    HOSTILE_ARRAY,
    PRETTY_ARRAY,
    singleArray,
    splitStream,
    streamingAdapter,
} from './fake-export';
import {
    check,
    checkFlat,
    checkLinear,
    checkSeq,
    finish,
    heading,
    mb,
    note,
    x,
} from './harness';
import { SCALES, probe, probeOk, series } from './run-probe';

const URL = 'https://api.vendor.example/v1/products/export';

/** Decode a text body with `decode: 'json'` and return the emitted values. */
async function decode(
    text: string,
    splitEvery = 1_000_000,
): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const v of jsonStream(splitStream(text, splitEvery).body))
        out.push(v);
    return out;
}

/** Drain a `.stream()` spine into its event type names plus the deltas and any error. */
async function spine(
    events: AsyncIterable<StitchEvent>,
): Promise<{ types: string[]; deltas: unknown[]; error?: string }> {
    const types: string[] = [];
    const deltas: unknown[] = [];
    let error: string | undefined;
    for await (const ev of events) {
        types.push(ev.type === 'progress' ? `progress:${ev.phase}` : ev.type);
        if (ev.type === 'delta') deltas.push(ev.chunk);
        else if (ev.type === 'error') error = ev.message;
    }
    return error === undefined ? { types, deltas } : { types, deltas, error };
}

async function main(): Promise<void> {
    heading(
        'C3 — `decode: "json"` over one top-level array: streams, or buffers?',
    );

    // ── (a) correctness: does it find the right boundaries? ───────────────────────────────────
    {
        const rows = await decode('[{"id":1},{"id":2},{"id":3}]');
        checkSeq(
            '(a) plain array -> one delta per ELEMENT (not the array)',
            rows,
            [{ id: 1 }, { id: 2 }, { id: 3 }],
        );

        // Pretty-printed: every record spans several LINES. This is the case `'ndjson'` cannot do
        // at all, and it is the decoder's headline capability.
        const pretty = await decode(PRETTY_ARRAY);
        check('(a) pretty-printed array -> elements', pretty.length, 2);
        checkSeq(
            '(a) pretty element 2 (nested, with a `}` inside a string)',
            [pretty[1]],
            [{ id: 'b', nested: { deep: [1, 2, { x: '}' }] } }],
        );

        // Structural characters inside STRING VALUES, escapes, embedded newlines, deep nesting.
        const hostile = (await decode(HOSTILE_ARRAY)) as { id: number }[];
        check('(a) hostile array -> element count', hostile.length, 4);
        checkSeq(
            '(a) hostile element ids in order',
            hostile.map((r) => r.id),
            [1, 2, 3, 4],
        );
        check(
            '(a) a `,` and a `]` inside a string value did not split the record',
            JSON.stringify(hostile[0]),
            '{"id":1,"s":"has , comma and ] bracket and } brace"}',
        );

        // Chunk boundaries every SINGLE character: every token is split across reads.
        const shredded = await decode(HOSTILE_ARRAY, 1);
        checkSeq(
            '(a) same body shredded to 1-char chunks -> identical',
            shredded,
            hostile,
        );
        note(
            '(a) → emission is CORRECT, and it is the capability the scenario asked for',
            'a single array is decoded element by element with the right boundaries under every adversarial input tried',
        );
    }

    // ── (b) the same, through a real stitch, with the event spine ─────────────────────────────
    {
        const wire = singleArray(3);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'json' },
        });
        const s = await spine(exportAll.stream());
        checkSeq('(b) event spine for a 3-element array', s.types, [
            'start',
            'progress:request',
            'delta',
            'delta',
            'delta',
            'result',
            'done',
        ]);
        check('(b) deltas', s.deltas.length, 3);
        check(
            '(b) delta 1 is the ROW',
            JSON.stringify((s.deltas[0] as { id: string }).id),
            '"prd_0000000"',
        );
    }

    // ── (c) memory: does it stream, or hold the array? ────────────────────────────────────────
    const json = series('decoder-json');
    for (const [i, m] of json.entries())
        note(
            `(c) decoder alone, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${x(m.ratio)} wire, ${String(m.ms)}ms`,
        );
    const [j1, j10, j100] = json as [
        (typeof json)[0],
        (typeof json)[0],
        (typeof json)[0],
    ];
    checkLinear('(c) 10x -> 100x decoder heap', j10.peakLive, j100.peakLive, 6);
    checkLinear('(c) 1x -> 100x decoder heap', j1.peakLive, j100.peakLive, 15);
    note(
        '(c) retained heap ÷ wire bytes at 100k rows',
        `${x(j100.ratio)} — the decoder is holding the WHOLE ARRAY TEXT`,
    );
    note(
        '(c) json-stream.ts:230-236',
        'the compaction floor is `valueStart`, and for a top-level ARRAY `valueStart` is the opening `[` (line 163) and stays there until the closing `]` (line 183). `compact(live)` is therefore a no-op for the entire array',
    );
    note(
        '(c) and it is quadratic in TIME as well',
        `${String(j10.ms)}ms at 10k rows -> ${String(j100.ms)}ms at 100k — 10x the rows, ~${String(Math.round(j100.ms / Math.max(1, j10.ms)))}x the time, because every chunk re-flattens the growing buffer (peak heap incl. garbage: ${mb(j100.peakHeap)})`,
    );

    // ── (d) the CAP: on defaults, a big array fails outright ──────────────────────────────────
    check(
        '(d) the default cap, in characters',
        JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
        8_388_608,
    );
    const under = probe({ mode: 'decoder-json', rows: 37_000 });
    const over = probe({ mode: 'decoder-json', rows: 38_000 });
    check('(d) 37,000 rows (7.9MB of wire) — decoded?', under.ok, true);
    check('(d) 38,000 rows (8.2MB of wire) — decoded?', over.ok, false);
    check(
        '(d) the message the caller gets',
        over.ok ? '' : over.error,
        'json decoder: in-progress value exceeded the stream.buffer.chars cap (8388608); a malformed or never-closing value was streamed',
    );
    note(
        '(d) → the message is WRONG about the cause',
        'nothing was malformed and nothing failed to close. A perfectly well-formed 8.2MB array trips a guard written for an unterminated one, and the error tells you to go and look at the vendor',
    );
    // What the same body does through a real stitch: an `error` event, and the deltas already
    // emitted are kept.
    {
        const wire = singleArray(60_000);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'json' },
        });
        const s = await spine(exportAll.stream());
        check(
            '(e) 60,000 rows on defaults -> error event?',
            s.error !== undefined,
            true,
        );
        // The hypothesis here was "zero deltas — the guard runs on the buffer, so it trips before
        // anything is emitted". WRONG, in the library's favour: `pending` is drained and yielded
        // BEFORE `guard()` runs (json-stream.ts:224-238), so every element that closed under the cap
        // is delivered first. The failure is a TRUNCATION, not a total loss.
        check('(e) deltas delivered before it failed', s.deltas.length, 37_312);
        check(
            '(e) …of how many rows',
            `${String(s.deltas.length)}/60000`,
            '37312/60000',
        );
        checkSeq('(e) terminal spine', s.types.slice(-2), ['error', 'done']);
        note(
            '(e) → a PARTIAL result, then a wrong diagnosis',
            'the consumer gets 62% of the catalog and an error blaming the vendor’s framing. A `.stream()` loop that only matches `delta` sees a silent truncation at a threshold that moves with the vendor’s data',
        );
    }

    // ── (f) the control: the SAME records as concatenated top-level values ────────────────────
    const concat = series('decoder-concat');
    for (const [i, m] of concat.entries())
        note(
            `(f) concatenated \`{…}{…}\`, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${x(m.ratio)} wire`,
        );
    const [c1, , c100] = concat as [
        (typeof concat)[0],
        (typeof concat)[0],
        (typeof concat)[0],
    ];
    checkFlat('(f) 1x -> 100x concatenated heap', c1.peakLive, c100.peakLive);
    check('(f) records decoded', c100.records, 100_000);
    note(
        '(f) → the defect is one BRANCH, not the decoder',
        'identical records, identical bytes: as siblings they cost 0.9MB flat, wrapped in one array they cost 19.7MB and rising. The compaction is right for a top-level value and pinned for a top-level array',
    );

    // ── (g) what the raised cap buys you ──────────────────────────────────────────────────────
    const raised = probeOk({
        mode: 'decoder-json',
        rows: 100_000,
        buffer: 1_000_000_000,
    });
    note(
        '(g) `stream: { decode: "json", buffer: { chars: 1e9 } }` at 100k rows',
        `succeeds, at ${mb(raised.peakLive)} retained and ${mb(raised.peakHeap)} peak including garbage`,
    );
    note(
        '(g) → raising the cap converts a hard failure into the memory profile you were trying to avoid',
        'it is the `--max-old-space-size` move from the capture’s own table: it moves the cliff, it does not remove it',
    );

    finish(
        'C3',
        'It STREAMS THE PARSE and BUFFERS THE TEXT — correct emission, unbounded memory, and on defaults it does not finish. Emission is genuinely right: one delta per element, holding up under `,`/`]`/`}` inside string values, escaped quotes, embedded newlines, pretty-printed multi-line records, deep nesting, and 1-character chunk boundaries. Memory is not: retained heap tracks the WHOLE ARRAY TEXT at 0.88x the wire and 34x growth over a 100x workload, because `compact()` floors on `valueStart` and for a top-level array `valueStart` is the opening `[` (json-stream.ts:163, 183, 230-236) — and the time is quadratic too, 28x for 10x the rows. So the decoder trips its OWN default guard: 37,000 rows decode, 38,000 fail, and the message — "a malformed or never-closing value was streamed" — accuses the vendor of something it did not do. On a 60,000-row array the consumer gets 37,312 rows and then `error`/`done(ok:false)`: a SILENT TRUNCATION for any loop that only matches `delta`, at a threshold that moves with the vendor’s data. The control settles where the defect is: the same 100,000 records as CONCATENATED top-level values run flat at 0.9MB. One branch of one function, not a design limit',
    );
}

void main();
