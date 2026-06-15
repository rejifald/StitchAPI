// The shared byte→line plumbing for streaming surfaces (ADR 0005 Decision 5, Q3). `lineReader`
// turns a ReadableStream<Uint8Array> into UTF-8 lines, carrying state across chunk boundaries: a
// line split between two chunks (the `buf` carry) and a multi-byte character split between two
// chunks (the streaming TextDecoder). Lines split on `\n` only, yielded without the terminator; a
// trailing unterminated line is yielded at end-of-stream. Driven over `streamOf` so chunk
// boundaries are placed exactly (no socket). `sse`/`stream` exercise it indirectly; these pin the
// boundary behaviour directly.
import { lineReader } from '../src/line-reader';
import { streamOf } from './support/streams';

const enc = new TextEncoder();

async function lines(chunks: (string | Uint8Array)[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of lineReader(streamOf(chunks))) out.push(line);
    return out;
}

describe('lineReader (ADR 0005 Q3)', () => {
    test('splits on \\n and drops the terminator', async () => {
        expect(await lines(['a\nb\nc\n'])).toEqual(['a', 'b', 'c']);
    });

    test('a line split across chunk boundaries is rejoined', async () => {
        expect(await lines(['he', 'llo\nwor', 'ld\n'])).toEqual([
            'hello',
            'world',
        ]);
    });

    test('a trailing line with no final newline is yielded at end-of-stream', async () => {
        expect(await lines(['one\ntwo'])).toEqual(['one', 'two']);
    });

    test('an empty stream yields no lines', async () => {
        expect(await lines([])).toEqual([]);
    });

    test('consecutive newlines yield empty lines', async () => {
        expect(await lines(['a\n\nb\n'])).toEqual(['a', '', 'b']);
    });

    test('a multi-byte UTF-8 char split across chunks is decoded whole', async () => {
        // "😀" is F0 9F 98 80 (4 bytes). Split the line so the emoji straddles the chunk boundary
        // (2 bytes + 2 bytes): a non-streaming decode would emit two replacement chars; the
        // streaming TextDecoder must hold the partial bytes and emit the character intact.
        const bytes = enc.encode('hi 😀\n'); // 3 ("hi ") + 4 (emoji) + 1 ("\n") = 8 bytes
        const cut = 5; // after "hi " + the first 2 emoji bytes
        expect(await lines([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([
            'hi 😀',
        ]);
    });

    test('a \\r is NOT stripped — lines split on \\n only (sse strips its own \\r)', async () => {
        // lineReader is the lower-level plumbing; the SSE frame parser is what strips a trailing
        // \r off a CRLF stream (Q3). Keeping \r here is the contract the two share.
        expect(await lines(['a\r\nb\r\n'])).toEqual(['a\r', 'b\r']);
    });
});
