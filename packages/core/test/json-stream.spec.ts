// The `'json'` structural streaming-JSON tokenizer (issue #111), driven DIRECTLY so chunk
// boundaries are fully controlled. The headline guarantee — a streaming tokenizer lives or dies on
// chunk-split correctness — is asserted by an exhaustive matrix: each input is fed split at EVERY
// byte offset (incl. mid-string, mid-escape, mid-multibyte-UTF8, mid-number, between values) and
// byte-by-byte, and must yield identical deltas every time.
import {
    JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
    jsonStream,
} from '../src/json-stream';

const enc = new TextEncoder();

/** A `ReadableStream` that emits each pre-encoded byte chunk as its own read, then closes. */
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

/** Drain the tokenizer over `chunks` into the array of emitted deltas. */
async function decode(
    chunks: Uint8Array[],
    maxBufferChars?: number,
): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const v of jsonStream(streamOfBytes(chunks), maxBufferChars))
        out.push(v);
    return out;
}

/** Feed a single string as one UTF-8 chunk. */
function decodeText(s: string, maxBufferChars?: number): Promise<unknown[]> {
    return decode([enc.encode(s)], maxBufferChars);
}

describe('json-stream tokenizer: value boundaries', () => {
    test('a top-level array emits each ELEMENT as its own delta (not the whole array)', async () => {
        expect(await decodeText('[{"a":1},{"a":2}]')).toEqual([
            { a: 1 },
            { a: 2 },
        ]);
    });

    test('concatenated objects with NO separator → one delta each', async () => {
        expect(await decodeText('{"a":1}{"a":2}')).toEqual([
            { a: 1 },
            { a: 2 },
        ]);
    });

    test('concatenated objects with whitespace/newlines between → one delta each', async () => {
        expect(await decodeText('{"a":1}\n  \t{"a":2}\n')).toEqual([
            { a: 1 },
            { a: 2 },
        ]);
    });

    test('pretty-printed records with internal newlines (ndjson would break) → correct deltas', async () => {
        const pretty = '{\n  "a": 1,\n  "b": [1, 2]\n}\n{\n  "c": 3\n}\n';
        expect(await decodeText(pretty)).toEqual([
            { a: 1, b: [1, 2] },
            { c: 3 },
        ]);
    });

    test('a }/]/" INSIDE a string value is not treated as structure → one correct delta', async () => {
        expect(await decodeText('{"s":"a}b]c\\"d"}')).toEqual([
            { s: 'a}b]c"d' },
        ]);
    });

    test('escapes and a \\uXXXX sequence inside strings parse correctly', async () => {
        expect(
            await decodeText('{"s":"tab\\tnl\\nq\\"\\u0041\\u00e9"}'),
        ).toEqual([{ s: 'tab\tnl\nq"Aé' }]);
    });

    test('nested structures (objects in arrays in objects) emit the right top-level boundaries', async () => {
        expect(
            await decodeText('{"x":{"y":[{"z":1},{"z":2}]}}{"w":3}'),
        ).toEqual([{ x: { y: [{ z: 1 }, { z: 2 }] } }, { w: 3 }]);
    });

    test('a top-level array of nested arrays emits each element', async () => {
        expect(await decodeText('[[1,2],[3,4],{"k":[5]}]')).toEqual([
            [1, 2],
            [3, 4],
            { k: [5] },
        ]);
    });

    test('empty array → no deltas; empty object → one delta', async () => {
        expect(await decodeText('[]')).toEqual([]);
        expect(await decodeText('{}')).toEqual([{}]);
    });

    test('a top-level array of mixed scalars + containers emits each element', async () => {
        expect(await decodeText('[1, "a", true, null, {"k":2}, [9]]')).toEqual([
            1,
            'a',
            true,
            null,
            { k: 2 },
            [9],
        ]);
    });
});

describe('json-stream tokenizer: bare top-level scalars', () => {
    test('a single number at EOF (no trailing delimiter)', async () => {
        expect(await decodeText('42')).toEqual([42]);
    });

    test('whitespace-separated bare scalars → one delta each', async () => {
        expect(await decodeText('1 2 -3.5e2\n4\t5')).toEqual([
            1, 2, -350, 4, 5,
        ]);
    });

    test('bare top-level strings (the closing quote is the boundary)', async () => {
        expect(await decodeText('"hello""world"')).toEqual(['hello', 'world']);
    });

    test('bare top-level keywords true/false/null', async () => {
        expect(await decodeText('true false null')).toEqual([
            true,
            false,
            null,
        ]);
    });

    test('a bare scalar followed by an object with no separator', async () => {
        expect(await decodeText('42{"a":1}')).toEqual([42, { a: 1 }]);
    });
});

describe('json-stream tokenizer: chunk-split robustness (the load-bearing matrix)', () => {
    // Each input carries the hard cases: a brace/bracket/quote INSIDE a string, backslash escapes,
    // a \uXXXX, a multibyte UTF-8 char (é = 2 bytes, 😀 = 4 bytes), signed/exponent numbers, and
    // nesting — so splitting at every byte offset exercises mid-string / mid-escape / mid-multibyte
    // / mid-number / between-value splits.
    const INPUTS: { name: string; text: string; want: unknown[] }[] = [
        {
            name: 'array of objects',
            text: '[{"a":1},{"a":2},{"a":3}]',
            want: [{ a: 1 }, { a: 2 }, { a: 3 }],
        },
        {
            name: 'concatenated objects',
            text: '{"a":1}{"b":2}{"c":3}',
            want: [{ a: 1 }, { b: 2 }, { c: 3 }],
        },
        {
            name: 'strings with structure + escapes + multibyte',
            text: '{"s":"a}b]c\\"d\\n\\u00e9é😀"}{"x":[1,2,{"y":3}]}',
            want: [{ s: 'a}b]c"d\néé😀' }, { x: [1, 2, { y: 3 }] }],
        },
        {
            name: 'array of mixed scalars (signed/exponent/unicode)',
            text: '[1, 2.5, -3e10, true, false, null, "x😀y"]',
            want: [1, 2.5, -3e10, true, false, null, 'x😀y'],
        },
        {
            name: 'whitespace-separated bare scalars',
            text: '  1\n  2\n  -42\n',
            want: [1, 2, -42],
        },
        {
            name: 'deeply nested top-level array elements',
            text: '[{"n":{"m":[1,2]}},{"k":"v"}]',
            want: [{ n: { m: [1, 2] } }, { k: 'v' }],
        },
    ];

    test.each(INPUTS)(
        '$name: identical deltas at every two-way byte split',
        async ({ text, want }) => {
            const full = enc.encode(text);
            for (let off = 0; off <= full.length; off++) {
                const got = await decode([full.slice(0, off), full.slice(off)]);
                expect(got).toEqual(want);
            }
        },
    );

    test.each(INPUTS)(
        '$name: identical deltas fed byte-by-byte (one byte per chunk)',
        async ({ text, want }) => {
            const full = enc.encode(text);
            const perByte = Array.from(full, (b) => Uint8Array.of(b));
            expect(await decode(perByte)).toEqual(want);
        },
    );

    test('a multibyte char split exactly across a chunk boundary decodes once, intact', async () => {
        // 😀 is 4 UTF-8 bytes; split it 2/2 between chunks.
        const full = enc.encode('{"e":"😀"}');
        const emoji = enc.encode('😀'); // 4 bytes
        const head = full.subarray(0, full.length - 1 - emoji.length + 2); // up to mid-emoji
        const tail = full.subarray(head.length);
        expect(await decode([head, tail])).toEqual([{ e: '😀' }]);
    });
});

describe('json-stream tokenizer: max-buffer guard + incomplete streams', () => {
    test('the default cap is a few MB (exported)', () => {
        expect(JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS).toBeGreaterThan(
            1024 * 1024,
        );
    });

    test('a never-closing value throws once the buffer exceeds maxBufferChars', async () => {
        // An open `[` whose content never closes; cap at 64 bytes so it trips quickly.
        const chunks = [
            enc.encode('['),
            ...Array.from({ length: 50 }, () => enc.encode('1234567890')),
        ];
        await expect(decode(chunks, 64)).rejects.toThrow(/maxBufferChars/);
    });

    test('a stream that ends mid-value throws (complete-value semantics)', async () => {
        await expect(decodeText('{"a":')).rejects.toThrow(/incomplete/);
        await expect(decodeText('[1, 2')).rejects.toThrow(/incomplete/);
        await expect(decodeText('"unterminated')).rejects.toThrow(/incomplete/);
    });

    test('a value just UNDER the cap still emits (the cap bounds, does not corrupt)', async () => {
        // A ~1KB object well under an 8KB cap parses fine.
        const big = { s: 'x'.repeat(900) };
        expect(await decodeText(JSON.stringify(big), 8 * 1024)).toEqual([big]);
    });

    test('an empty stream yields nothing', async () => {
        expect(await decode([])).toEqual([]);
    });
});
