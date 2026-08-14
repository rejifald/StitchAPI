// Three behaviours of the `'json'` streaming tokenizer (src/json-stream.ts) that json-stream.spec.ts
// leaves open. That suite proves chunk-split correctness exhaustively and that a *single*
// never-closing value trips the buffer.chars guard — but not:
//   1. that the cap is PER-VALUE, not cumulative: the sliding-window compaction drops each emitted
//      value, so a long run of small complete values whose TOTAL dwarfs the cap streams fine. This
//      is the whole reason compact()/base exist; without them this stream would false-trip the guard.
//   2. that this holds for a top-level ARRAY's elements too, not only for concatenated top-level
//      values — the two shapes this decoder accepts must release memory alike (issue #659 §2).
//   3. that a structurally-complete-but-INVALID slice surfaces its JSON.parse error (the documented
//      "or if a slice fails to parse" contract — the engine turns the throw into an error event).
import { jsonStream } from '../src/json-stream';

const enc = new TextEncoder();

/** A ReadableStream that emits each pre-encoded chunk as its own read, then closes. */
function streamOfBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            // The bounds check above guarantees an element; TS6 narrows indexed access to
            // `T | undefined` here where 5.9 did not.
            controller.enqueue(chunks[i++]!);
        },
    });
}

async function decode(
    chunks: Uint8Array[],
    maxBufferChars?: number,
): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const v of jsonStream(streamOfBytes(chunks), maxBufferChars))
        out.push(v);
    return out;
}

/** Cut `text` into `size`-char pieces, each encoded as its own chunk (its own `read()`). */
function chunksOf(text: string, size: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < text.length; i += size)
        out.push(enc.encode(text.slice(i, i + size)));
    return out;
}

describe('json-stream: the buffer cap bounds a VALUE, not the whole stream', () => {
    test('many small complete values whose total dwarfs the buffer cap all stream (compaction works)', async () => {
        const COUNT = 500;
        const cap = 1024; // each value is ~12 bytes; the total (~6 KB) is far over the cap.
        // One object per chunk forces cross-read compaction (each read appends, emits, compacts).
        const chunks = Array.from({ length: COUNT }, (_, i) =>
            enc.encode(`{"i":${i}}`),
        );
        const out = await decode(chunks, cap);
        expect(out).toHaveLength(COUNT);
        expect(out[0]).toEqual({ i: 0 });
        expect(out[COUNT - 1]).toEqual({ i: COUNT - 1 });
    });

    test('a long top-level array element-by-element stays bounded element-wise', async () => {
        // A 300-element array fed one element per chunk; each element is tiny. The cap is a
        // QUARTER of the array text, so passing means the window held an element at a time —
        // an array-sized window would trip the guard around element 60.
        const parts = ['['];
        for (let i = 0; i < 300; i++) parts.push(i === 0 ? `${i}` : `,${i}`);
        parts.push(']');
        expect(parts.join('').length).toBeGreaterThan(4 * 256);
        const out = await decode(
            parts.map((p) => enc.encode(p)),
            256,
        );
        expect(out).toHaveLength(300);
        expect(out[299]).toBe(299);
    });
});

// A top-level ARRAY must release the elements it has already emitted, exactly as the
// concatenated-value form does. It did not (issue #659 §2): `compact()` floors on `valueStart`, and
// an array's `valueStart` was pinned to the opening `[` until the closing `]`, so the sliding window
// grew to hold the WHOLE array — quadratic time, heap tracking the wire, and a long array tripping
// its own cap mid-stream with a message blaming the vendor for "a malformed or never-closing value".
//
// The cap is the instrument here, not a side quest. `guard()` runs AFTER `compact()` on every read,
// so a run that completes under a cap far smaller than the body IS a per-read assertion that the
// retained window never exceeded that cap — a deterministic memory proof, no heap sampling, no flake.
describe('json-stream: a top-level array releases each emitted element (#659)', () => {
    const CAP = 2_048;
    const PAD = 'x'.repeat(24);
    const RECORDS = Array.from({ length: 2_000 }, (_, i) => ({ i, pad: PAD }));
    const AS_ARRAY = JSON.stringify(RECORDS);
    const AS_CONCAT = RECORDS.map((r) => JSON.stringify(r)).join('');

    test('every element streams under a cap a fraction of the array text', async () => {
        // ~86 KB of array text through a 2 KB window: the window cannot be holding the array.
        expect(AS_ARRAY.length).toBeGreaterThan(20 * CAP);
        const out = await decode(chunksOf(AS_ARRAY, 64), CAP);
        expect(out).toHaveLength(RECORDS.length);
        expect(out[0]).toEqual(RECORDS[0]);
        expect(out.at(-1)).toEqual(RECORDS.at(-1));
    });

    test('the array form now matches the concatenated form — the issue’s control', async () => {
        // The same records, the same cap, the other shape this decoder accepts. Concatenated
        // top-level values always released; the array form is what regressed.
        expect(await decode(chunksOf(AS_CONCAT, 64), CAP)).toEqual(RECORDS);
        expect(await decode(chunksOf(AS_ARRAY, 64), CAP)).toEqual(RECORDS);
    });

    test('no silent truncation: a 60k-row array delivers all 60k rows', async () => {
        // The reported shape — every ELEMENT is tiny, the ARRAY text is not. The consumer used to
        // get a prefix of the rows and then a throw (`error` / `done(ok:false)` at the engine),
        // which a loop matching only `delta` never sees.
        const rows = Array.from({ length: 60_000 }, (_, i) => ({ i }));
        const out = await decode(chunksOf(JSON.stringify(rows), 4_096), CAP);
        expect(out).toHaveLength(60_000);
        expect(out[0]).toEqual({ i: 0 });
        expect(out.at(-1)).toEqual({ i: 59_999 });
    });

    test('compaction mid-array corrupts no slice — hard records, ONE BYTE per chunk', async () => {
        // Releasing a prefix is only safe if it is never needed again. Maximum compaction pressure
        // (a compact() per byte) over everything the boundary scanner has to survive: `,` `]` `}`
        // `"` inside string values, backslash escapes, embedded newlines/tabs, multibyte and astral
        // characters, deep nesting, and pretty-printed multi-line records.
        const hard = Array.from({ length: 60 }, (_, i) => ({
            id: i,
            s: 'a}b]c,d"e\nf\tg\\hé\u{1f600}',
            deep: { a: { b: [1, { k: ['x,y]z', i] }] } },
        }));
        const pretty = `[\n${hard.map((r) => JSON.stringify(r, null, 2)).join(',\n')}\n]`;
        const perByte = Array.from(enc.encode(pretty), (b) => Uint8Array.of(b));
        expect(await decode(perByte, CAP)).toEqual(hard);
    });

    test('the cap still bounds a single oversized ELEMENT inside an array', async () => {
        // Releasing FINISHED elements must not release an unfinished one. An element still in
        // progress across reads keeps flooring the window, so the guard keeps its teeth: this is
        // the "one value is too large" case the cap exists for.
        const oneBig = `{"s":"${'x'.repeat(8_000)}"}`;
        await expect(
            decode(
                [enc.encode('['), ...chunksOf(oneBig, 100), enc.encode(']')],
                CAP,
            ),
        ).rejects.toThrow(/stream\.buffer\.chars/);
    });
});

describe('json-stream: invalid-but-closed slices surface their parse error', () => {
    test('a malformed top-level scalar throws (becomes an engine error event)', async () => {
        // `1.2.3` is structurally a single bare scalar that closes at EOF, but JSON.parse rejects it.
        await expect(decode([enc.encode('1.2.3')])).rejects.toThrow();
    });

    test('a malformed scalar before a valid value still throws', async () => {
        // `01` (leading zero) closes when the following `{` begins, then JSON.parse('01') rejects.
        await expect(decode([enc.encode('01 {"ok":1}')])).rejects.toThrow();
    });
});
