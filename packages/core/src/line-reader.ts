// The shared byte→line plumbing for streaming surfaces (ADR 0005 Decision 5, Q3). Turns a
// `ReadableStream<Uint8Array>` into UTF-8 text lines, correctly carrying state across chunk
// boundaries: a multi-byte character split between two chunks (the streaming `TextDecoder`) and a
// line split between two chunks (the `buf` carry). Lines are split on `\n` only and yielded WITHOUT
// the terminator; a trailing line with no final newline is yielded at end-of-stream.
//
// `stream`'s `'lines'` / `'ndjson'` decoders consume these lines directly; `sse`'s frame parser
// layers the event-stream grammar on top (stripping a trailing `\r`, grouping by blank lines). They
// share this plumbing, not a decoder — `text/event-stream` is a protocol, "lines" is not.
export async function* lineReader(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            buf += decoder.decode(r.value, { stream: true });
            let nl = buf.indexOf('\n');
            while (nl >= 0) {
                yield buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                nl = buf.indexOf('\n');
            }
        }
        // Flush any bytes the streaming decoder held back (a split multi-byte char), then drain
        // any remaining complete lines and finally the unterminated trailing line, if any.
        buf += decoder.decode();
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
            yield buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
        }
        if (buf.length > 0) yield buf;
    } finally {
        reader.releaseLock();
    }
}
