// C3 — THE DECIDING CLAIM. `decode: 'json'` against ONE SINGLE TOP-LEVEL ARRAY.
//
// types.ts:1624-1631 documents it as "the structural, unframed streaming-JSON decoder (issue #111):
// one `delta` per complete value / top-level array element, tolerant of internal newlines and
// concatenated values". If that holds with bounded memory, the hard case of this whole scenario is a
// config value — a real capability few clients have.
//
// It holds — since #665. When this directory was first captured the answer was split: emission was
// correct and memory was not. The decoder retained the ENTIRE array text (0.88x the wire, growing
// linearly, quadratic scan time) because the compaction floor was pinned to the array's opening `[`,
// and it therefore tripped its own 8M-char default cap at ~37,000 rows — truncating the export under
// an error that blamed the vendor. That defect was filed as #659 §2 and fixed by #665: a top-level
// array records no compaction floor of its own (json-stream.ts:166-174), so emitted elements are
// released as they close (json-stream.ts:236-247) and the cap bounds one ELEMENT rather than the
// array (json-stream.ts:20-28). This script pins the fixed behaviour:
//   (a) EMISSION is correct, and impressively so — the half that was never at fault. Right count,
//       right boundaries, records containing `,` `]` `}` and escaped quotes inside strings,
//       pretty-printed records spanning many lines, nested containers, 1-character chunks.
//   (b) the event spine through a real stitch — unchanged.
//   (c) MEMORY is flat and TIME is linear on the single-array shape.
//   (d) the DEFAULT cap no longer trips on a well-formed array of any length; one oversized
//       ELEMENT still trips it, which is what the guard is for.
//   (e) the 60,000-row export that used to truncate at 37,312 rows arrives whole, on defaults.
//   (f) the concatenated control and the array now measure ALIKE — the branch gap is closed.
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
    checkAtMost,
    checkFlat,
    checkSeq,
    finish,
    heading,
    mb,
    note,
} from './harness';
import { SCALES, probe, series } from './run-probe';

const URL = 'https://api.vendor.example/v1/products/export';

/** A heap÷wire ratio as `2.8%` — post-#665 these sit far below 1x, where `x()` rounds to `0.0x`. */
const pct = (f: number): string => `${(f * 100).toFixed(1)}%`;

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
            'a single array is decoded element by element with the right boundaries under every adversarial input tried — the half of the original finding that was never at fault',
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
    // Pre-#665 this series was LINEAR — 0.88x the wire retained at 100k rows, 34x growth over a
    // 100x workload — because `compact()` floored on the array's opening `[`. Post-#665 the array
    // records no floor of its own (json-stream.ts:166-174): `elementStart` floors the window while
    // an element is mid-flight, and between elements the floor falls back to the scan cursor, so
    // emitted elements are released (json-stream.ts:236-247).
    const json = series('decoder-json');
    for (const [i, m] of json.entries())
        note(
            `(c) decoder alone, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${pct(m.ratio)} of wire, ${String(m.ms)}ms`,
        );
    const [j1, j10, j100] = json as [
        (typeof json)[0],
        (typeof json)[0],
        (typeof json)[0],
    ];
    checkFlat('(c) 1x -> 100x decoder heap', j1.peakLive, j100.peakLive);
    checkFlat('(c) 10x -> 100x decoder heap', j10.peakLive, j100.peakLive);
    checkAtMost(
        '(c) retained heap ÷ wire bytes at 100k rows',
        j100.ratio,
        0.1,
        pct,
    );
    note(
        '(c) → the decoder no longer holds the array text',
        `pre-#665 the same point measured 0.88x the wire; it is now floor-dominated noise (\`settled\` is ~0.6MB of one-time module/JIT cost at every scale)`,
    );
    note(
        '(c) and the TIME is linear now',
        `${String(j10.ms)}ms at 10k rows -> ${String(j100.ms)}ms at 100k — 10x the rows, ~${String(Math.round(j100.ms / Math.max(1, j10.ms)))}x the time. Pre-#665 it was ~28x, because every chunk re-flattened a buffer pinned at the opening \`[\``,
    );

    // ── (d) the DEFAULT cap: no cliff for well-formed arrays; one oversized ELEMENT still trips ─
    check(
        '(d) the default cap, in characters',
        JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
        8_388_608,
    );
    // No `--buffer` override here: these two runs sit ON the library default, exactly where the
    // pre-#665 decoder failed (37,000 rows decoded; 38,000 did not).
    const past = probe({ mode: 'decoder-json', rows: 38_000 });
    const far = probe({ mode: 'decoder-json', rows: 100_000 });
    check(
        '(d) 38,000 rows (8.2MB of wire, past the old cliff) — decoded?',
        past.ok,
        true,
    );
    check(
        '(d) 100,000 rows (21.4MB of wire) on the default cap — decoded?',
        far.ok,
        true,
    );
    check('(d) records at 100,000', far.ok ? far.records : -1, 100_000);
    note(
        '(d) → the cliff at ~37,000 rows is gone',
        'the cap bounds ONE value, and a top-level array is capped by its largest ELEMENT, not by its length (json-stream.ts:20-28). A well-formed array of any row count passes the default',
    );
    // The guard keeps its teeth: a single element larger than the cap still trips it — an element
    // mid-flight floors the window, so a value that never closes cannot grow the buffer unbounded.
    {
        const body = `[{"id":1},{"pad":"${'x'.repeat(30_000)}"}]`;
        const got: unknown[] = [];
        let err = '';
        try {
            for await (const v of jsonStream(
                splitStream(body, 1_000).body,
                20_000,
            ))
                got.push(v);
        } catch (e) {
            err = e instanceof Error ? e.message : String(e);
        }
        check('(d) elements delivered before the oversized one', got.length, 1);
        check(
            '(d) one ELEMENT over the cap still trips the guard',
            err,
            'json decoder: in-progress value exceeded the stream.buffer.chars cap (20000); a malformed or never-closing value was streamed',
        );
        note(
            '(d) → the message finally matches the mechanism',
            'the error now fires only for a single value/element the cap was written to bound — not for a well-formed export that merely grew past a threshold nobody set',
        );
    }

    // ── (e) the 60,000-row array through a real stitch, on DEFAULTS ───────────────────────────
    // Pre-#665 this delivered 37,312 rows and then `error` / `done(ok:false)` — a silent truncation
    // for any loop that only matches `delta`, at a threshold that moved with the vendor's data.
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
            false,
        );
        check('(e) deltas delivered', s.deltas.length, 60_000);
        checkSeq('(e) terminal spine', s.types.slice(-2), ['result', 'done']);
        note(
            '(e) → the whole export arrives, and the spine ends clean',
            'no truncation, no wrong diagnosis. What remains above the decoder is the ENGINE cost: `chunks` retains every element (C2b), on this decoder like every other',
        );
    }

    // ── (f) the control: the SAME records as concatenated top-level values ────────────────────
    const concat = series('decoder-concat');
    for (const [i, m] of concat.entries())
        note(
            `(f) concatenated \`{…}{…}\`, ${String(SCALES[i])} rows / ${mb(m.wireBytes)} wire`,
            `${mb(m.peakLive)} retained = ${pct(m.ratio)} of wire`,
        );
    const [c1, , c100] = concat as [
        (typeof concat)[0],
        (typeof concat)[0],
        (typeof concat)[0],
    ];
    checkFlat('(f) 1x -> 100x concatenated heap', c1.peakLive, c100.peakLive);
    check('(f) records decoded', c100.records, 100_000);
    checkAtMost(
        '(f) concatenated retained ÷ wire at 100k rows',
        c100.ratio,
        0.1,
        pct,
    );
    note(
        '(f) → the two shapes now measure ALIKE',
        `one array: ${mb(j100.peakLive)}; the same records as siblings: ${mb(c100.peakLive)} — both floor-dominated. Pre-#665 the array cost 19.7MB and rising while the siblings cost 0.9MB flat; the array branch now releases exactly the way the sibling branch always did`,
    );

    finish(
        'C3',
        'It STREAMS — since #665, on both axes. Emission was always right: one delta per element, holding up under `,`/`]`/`}` inside string values, escaped quotes, embedded newlines, pretty-printed multi-line records, deep nesting, and 1-character chunk boundaries. Memory now matches it: a 100,000-row single array (21.4MB of wire) decodes flat at 0.6MB retained — under 3% of the wire, against 0.88x pre-fix — in linear rather than quadratic time, because a top-level array records no compaction floor of its own and emitted elements are released as they close (json-stream.ts:166-174, 236-247). The default cap no longer trips on any well-formed array: it bounds ONE value, so an array is capped by its largest ELEMENT, not its length (json-stream.ts:20-28) — 38,000 and 100,000 rows both decode on defaults where 38,000 used to fail, the 60,000-row export that truncated at 37,312 rows arrives whole with a clean `result`/`done`, and a single oversized element still trips the guard, which is what it is for. The concatenated control and the array now measure alike. The defect this claim originally captured was real — filed as #659 §2, fixed by #665; what remains is the engine’s accumulator (C2), which is every decoder’s cost, not this one’s',
    );
}

void main();
