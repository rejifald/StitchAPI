// The shared byte→line plumbing for streaming surfaces (ADR 0005 Decision 5, Q3). Turns a
// `ReadableStream<Uint8Array>` into UTF-8 text lines, correctly carrying state across chunk
// boundaries: a multi-byte character split between two chunks (the streaming `TextDecoder`) and a
// line split between two chunks (the `buf` carry). Lines are split on `\n` only and yielded WITHOUT
// the terminator; a trailing line with no final newline is yielded at end-of-stream.
//
// `stream`'s `'lines'` / `'ndjson'` decoders consume these lines directly; `sse`'s frame parser
// layers the event-stream grammar on top (stripping a trailing `\r`, grouping by blank lines). They
// share this plumbing, not a decoder — `text/event-stream` is a protocol, "lines" is not.
import { JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS } from './json-stream';

/**
 * Read UTF-8 lines off `stream`, splitting on `\n` and yielding each line WITHOUT its terminator.
 *
 * `maxBufferChars` caps the length — in characters of the DECODED text, not bytes off the socket —
 * of a single UN-TERMINATED line held in `buf`: an upstream that streams bytes with no `\n` would
 * otherwise grow client memory without limit (an OOM DoS), so once the carry exceeds the cap we throw
 * a descriptive Error instead. This mirrors the `'json'` decoder's per-value cap (`json-stream.ts`)
 * — same default (~8M chars), same "the engine turns the throw into an
 * `error` event" contract (`runStreaming`), so an abusive body fails the stream cleanly rather than
 * OOM-ing. Overridable per-stream via `stream.maxBufferChars`.
 *
 * On any completion — normal end OR an early generator `.return()` (a consumer `break`s without
 * aborting a signal) — the `finally` proactively `cancel()`s the underlying stream before releasing
 * the reader lock, so an abandoned SSE/line consumer closes the HTTP connection instead of leaking it
 * until GC. Aborting via the request signal already tears the body down; this covers break-without-abort.
 * `cancel()` on an already-closed stream is a spec no-op, so cancelling unconditionally is safe.
 */
export async function* lineReader(
    stream: ReadableStream<Uint8Array>,
    maxBufferChars: number = JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
): AsyncGenerator<string, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Guard the un-terminated carry: `buf` here holds only the decoded text AFTER the last `\n`, so a
    // legitimate long-but-terminated line stream never trips it — only a run with no line break does.
    const guard = (): void => {
        if (buf.length > maxBufferChars) {
            throw new Error(
                `line reader: un-terminated line exceeded maxBufferChars (${String(
                    maxBufferChars,
                )}); a stream with no newline was sent`,
            );
        }
    };
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
            guard(); // whatever is left after this chunk is an un-terminated carry — cap it
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
        // Cancel the body on any exit path (early `break` / error / normal end) so an abandoned
        // consumer proactively closes the connection; then release the lock. `.catch` swallows a
        // reject from a body already torn down by an abort.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
