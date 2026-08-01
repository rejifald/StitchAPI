// The `'json'` decoder for the `stream` surface (issue #111): a zero-dependency, hand-rolled
// incremental JSON tokenizer over a `ReadableStream<Uint8Array>`. Unlike `'ndjson'` (newline-FRAMED
// records), this decoder is STRUCTURAL and UNFRAMED — it follows JSON's grammar to find value
// boundaries, so it handles cases `'ndjson'` cannot:
//   - a single large JSON array streamed element-by-element: `[ {…}, {…}, … ]` → one delta PER
//     element (the useful case), not the whole array.
//   - a concatenated sequence of top-level values with no separator: `{…}{…}` → one delta each.
//   - pretty-printed records whose internal newlines would break a `\n` split.
//
// Boundary detection, NOT a full parser: we scan characters to locate each structurally-complete
// top-level value (or top-level-array element), then hand the exact slice to `JSON.parse`. The scan
// tracks just enough state — nesting depth over `{}`/`[]`, in-string state, escape (`\`) state, and
// the 4 hex digits of a `\uXXXX` escape — so a `}`/`]`/`"` INSIDE a string is never mistaken for
// structure. Only COMPLETE values are ever emitted; partial/"UI fill-in" emission of a growing
// object is deliberately OUT OF SCOPE (so per-`delta` `output` validation stays meaningful).
//
// Browser-first / bundle-frugal: `TextDecoder` + `ReadableStream` only — no `Buffer`, no `node:*`.
// Reached solely through the `stream` subpath; `import { stitch }` pulls in none of it.

/**
 * Default cap on the chars the `'json'` decoder will buffer for a single in-progress value before
 * it throws — characters of the DECODED text (UTF-16 code units), not bytes off the socket. ~8M:
 * generous for real records, but bounded so a malformed / never-closing value (e.g. an unterminated
 * `[`) can't grow the buffer without limit. Overridable per-stream via `stream.buffer.chars`. The
 * engine (`runStreaming`) turns the throw into an `error` event.
 */
export const JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS = 8 * 1024 * 1024;

// Whitespace JSON permits between values (RFC 8259): space, tab, LF, CR.
function isJsonWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Structural streaming-JSON decoder. Reads `stream`, UTF-8-decodes incrementally (so a multi-byte
 * char split across chunks is handled), and yields each structurally-complete value as it closes.
 *
 * Emission rules:
 *   - a top-level OBJECT → ONE delta (the whole object).
 *   - a top-level ARRAY → one delta per direct ELEMENT (the useful case), NOT the array itself.
 *   - concatenated top-level values (objects/arrays/scalars, separated by optional whitespace or
 *     nothing) → one delta each.
 *   - bare top-level SCALARS (number/string/true/false/null): supported. A number/keyword has no
 *     closing delimiter, so its boundary is whitespace, the start of a following value, or EOF.
 *
 * Each emitted slice is `JSON.parse`d; the parsed value is the delta. Throws if a single in-progress
 * value's buffer exceeds `maxBufferChars`, or if the stream ends mid-value, or if a slice fails to
 * parse (a thrown error becomes an `error` event in the engine).
 */
export async function* jsonStream(
    stream: ReadableStream<Uint8Array>,
    maxBufferChars: number = JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
): AsyncGenerator<unknown, void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // All indices below are absolute positions into the logical character stream. `buf` is a sliding
    // window of it: `buf[k]` is the char at absolute index `base + k`. We periodically drop an
    // already-emitted prefix and bump `base`, so the window stays bounded by the current in-progress
    // value, not the whole stream.
    let buf = '';
    let base = 0;
    let scan = 0; // next absolute index to scan

    // Structural scan state, carried across chunk boundaries.
    let depth = 0; // nesting depth over {} / []
    let inString = false; // inside a "..." string literal
    let escaped = false; // previous in-string char was a backslash
    let unicodeLeft = 0; // remaining hex digits to consume in a \uXXXX escape
    let topIsArray = false; // the open top-level container (depth>=1) is an array

    // Absolute start of the value/element currently being accumulated, or -1 when between values.
    // At top level (depth 0, not in an array) this tracks a bare scalar/object/array start; inside a
    // top-level array it tracks the current element's start. Exactly one is active at a time.
    let valueStart = -1;
    let elementStart = -1;

    const at = (abs: number): number => buf.charCodeAt(abs - base);
    const slice = (from: number, to: number): unknown =>
        JSON.parse(buf.slice(from - base, to - base)) as unknown;

    // Drop the window prefix before absolute index `upto` (must not be inside an in-progress value).
    const compact = (upto: number): void => {
        if (upto <= base) return;
        buf = buf.slice(upto - base);
        base = upto;
    };

    const guard = (): void => {
        if (buf.length > maxBufferChars) {
            throw new Error(
                `json decoder: in-progress value exceeded the stream.buffer.chars cap (${String(
                    maxBufferChars,
                )}); a malformed or never-closing value was streamed`,
            );
        }
    };

    // Values emitted during the current scan pass, drained after each chunk so the generator yields
    // in order without re-entering the scanner mid-iteration.
    const pending: unknown[] = [];

    try {
        for (;;) {
            const r = await reader.read();
            const done = r.done;
            const text = done
                ? decoder.decode() // flush any held-back multi-byte tail
                : decoder.decode(r.value, { stream: true });
            if (text.length > 0) buf += text;

            const end = base + buf.length;
            for (; scan < end; scan++) {
                const c = at(scan);

                if (inString) {
                    if (unicodeLeft > 0) {
                        unicodeLeft--;
                        continue;
                    }
                    if (escaped) {
                        escaped = false;
                        if (c === 0x75 /* u */) unicodeLeft = 4;
                        continue;
                    }
                    if (c === 0x5c /* \ */) {
                        escaped = true;
                        continue;
                    }
                    if (c === 0x22 /* " */) {
                        inString = false;
                        // A bare top-level STRING closes at its closing quote.
                        if (depth === 0 && valueStart >= 0) {
                            pending.push(slice(valueStart, scan + 1));
                            valueStart = -1;
                        }
                    }
                    continue;
                }

                // --- not in a string ---

                if (c === 0x22 /* " */) {
                    // At top level a `"` opening a new value first CLOSES any bare scalar in
                    // progress (a number/keyword with no delimiter, e.g. `42"x"`).
                    if (depth === 0 && valueStart >= 0) {
                        pending.push(slice(valueStart, scan));
                        valueStart = -1;
                    }
                    inString = true;
                    if (depth === 0 && valueStart < 0) valueStart = scan;
                    else if (depth === 1 && topIsArray && elementStart < 0)
                        elementStart = scan;
                    continue;
                }

                if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
                    if (depth === 0) {
                        // A new container at top level closes any bare scalar in progress
                        // (e.g. `42{...}` — the number ends where the object begins).
                        if (valueStart >= 0) {
                            pending.push(slice(valueStart, scan));
                        }
                        topIsArray = c === 0x5b;
                        valueStart = scan;
                    } else if (depth === 1 && topIsArray && elementStart < 0) {
                        elementStart = scan;
                    }
                    depth++;
                    continue;
                }

                if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
                    depth--;
                    if (depth === 0) {
                        if (topIsArray) {
                            // A trailing scalar element with no comma after it still closes here.
                            if (elementStart >= 0) {
                                pending.push(slice(elementStart, scan));
                                elementStart = -1;
                            }
                            // Drop the whole (now-consumed) array including this ']'.
                            valueStart = -1;
                        } else {
                            // Top-level object closes → emit the whole object.
                            pending.push(slice(valueStart, scan + 1));
                            valueStart = -1;
                        }
                    } else if (depth === 1 && topIsArray && elementStart >= 0) {
                        // A direct CONTAINER child of a top-level array just closed → emit it.
                        pending.push(slice(elementStart, scan + 1));
                        elementStart = -1;
                    }
                    continue;
                }

                if (c === 0x2c /* , */) {
                    // A comma at depth 1 in a top-level array ends a scalar element in progress.
                    if (depth === 1 && topIsArray && elementStart >= 0) {
                        pending.push(slice(elementStart, scan));
                        elementStart = -1;
                    }
                    continue;
                }

                if (isJsonWhitespace(c)) {
                    // Whitespace terminates a bare top-level SCALAR (number/keyword) with no delimiter.
                    if (depth === 0 && valueStart >= 0) {
                        pending.push(slice(valueStart, scan));
                        valueStart = -1;
                    }
                    continue;
                }

                // Any other non-whitespace char (digits, -, t/f/n keyword chars).
                if (depth === 0) {
                    if (valueStart < 0) valueStart = scan; // start of a bare top-level scalar
                } else if (depth === 1 && topIsArray && elementStart < 0) {
                    elementStart = scan; // start of a scalar element inside a top-level array
                }
            }

            // Emit everything found this pass, in order.
            for (const v of pending) yield v;
            pending.length = 0;

            // Compact: drop everything before the earliest live position. When nothing is in
            // progress, that's the scan cursor (we've consumed up to it); otherwise it's the start
            // of the in-progress value/element.
            const live =
                valueStart >= 0
                    ? valueStart
                    : elementStart >= 0
                      ? elementStart
                      : scan;
            compact(live);

            guard();
            if (done) break;
        }

        // End of stream. An unterminated string or an unclosed container is an INCOMPLETE value —
        // surface it rather than silently dropping data (complete-value semantics). Otherwise a bare
        // top-level scalar with no trailing delimiter (e.g. a final `42`) closes at EOF.
        if (depth !== 0 || inString) {
            throw new Error(
                'json decoder: stream ended with an incomplete JSON value',
            );
        }
        if (valueStart >= 0) {
            yield slice(valueStart, scan);
        }
    } finally {
        reader.releaseLock();
    }
}
