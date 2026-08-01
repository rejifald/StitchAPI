// Two behaviours of the `'json'` streaming tokenizer (src/json-stream.ts) that json-stream.spec.ts
// leaves open. That suite proves chunk-split correctness exhaustively and that a *single*
// never-closing value trips the buffer.chars guard — but not:
//   1. that the cap is PER-VALUE, not cumulative: the sliding-window compaction drops each emitted
//      value, so a long run of small complete values whose TOTAL dwarfs the cap streams fine. This
//      is the whole reason compact()/base exist; without them this stream would false-trip the guard.
//   2. that a structurally-complete-but-INVALID slice surfaces its JSON.parse error (the documented
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
            controller.enqueue(chunks[i++]);
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
        // A 300-element array fed one element per chunk; each element is tiny. Under a cap large
        // enough for the array-so-far this streams every element without tripping the guard.
        const parts = ['['];
        for (let i = 0; i < 300; i++) parts.push(i === 0 ? `${i}` : `,${i}`);
        parts.push(']');
        const out = await decode(
            parts.map((p) => enc.encode(p)),
            64 * 1024,
        );
        expect(out).toHaveLength(300);
        expect(out[299]).toBe(299);
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
