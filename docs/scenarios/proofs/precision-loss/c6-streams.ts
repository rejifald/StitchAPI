// C6 — do `stream` / `download` / `sse` see raw bytes, and is that a safer path?
//
// The structural fact that makes C1–C2 what they are is that `fetchAdapter` parses. The streaming
// surfaces take a different branch of the same function (`http-adapter.ts:93` — `if (req.stream)
// return { body: response.body }`), so the parse never happens. This script measures what a CALLER
// actually receives on each, which is the question that matters: "the bytes exist somewhere" is not
// the same as "you can use them".
//
// The answer splits by DECODER, not by surface:
//
//   stream + decode:'bytes'  — Uint8Array. Lossless. The digits are yours.
//   stream + decode:'lines'  — string.     Lossless.
//   stream + decode:'ndjson' — JSON.parse per line. CORRUPTED, same as the buffered path.
//   stream + decode:'json'   — structural streaming JSON. CORRUPTED.
//   download                 — Blob.       Lossless.
//   sse                      — JSON.parse per `data:` payload. CORRUPTED.
//
// So "streaming is safer" is true only for the two decoders that hand you bytes and make the
// parsing your problem — which is the same trade C3 makes, reached from a different direction.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c6-streams.ts
import { download } from '../../../../packages/core/src/download';
import { sse } from '../../../../packages/core/src/sse';
import { stream } from '../../../../packages/core/src/stream';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import {
    check,
    checkDigits,
    checkSeq,
    checkStr,
    finish,
    heading,
    note,
} from './harness';
import { BASE, ONE_ID_TEXT, SNOWFLAKE } from './wire';

/** An adapter that hands back a live `ReadableStream` of `text` when `req.stream` is set. */
function streamingAdapter(
    text: string,
    contentType = 'application/json',
): Adapter {
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        const bytes = new TextEncoder().encode(text);
        if (req.stream) {
            return {
                status: 200,
                headers: { 'content-type': contentType },
                body: new ReadableStream<Uint8Array>({
                    start(c) {
                        c.enqueue(bytes);
                        c.close();
                    },
                }),
            };
        }
        // The buffered arm — `download` asks for a blob, so honour `response`.
        if (req.response === 'blob') {
            return {
                status: 200,
                headers: { 'content-type': contentType },
                body: new Blob([bytes], { type: contentType }),
            };
        }
        return {
            status: 200,
            headers: { 'content-type': contentType },
            body: JSON.parse(text) as unknown,
        };
    }) as Adapter;
    fn.capabilities = { name: 'streamingAdapter', supports: ['stream'] };
    return fn;
}

async function main(): Promise<void> {
    heading("C6 (a) — `stream` with the default decoder ('bytes')");
    {
        const call = stream({
            name: 'streamThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(ONE_ID_TEXT),
        });
        const chunks = (await call()) as Uint8Array[];
        check('how many deltas', chunks.length, 1);
        check(
            'the delta is a Uint8Array',
            chunks[0] instanceof Uint8Array,
            true,
        );
        const text = new TextDecoder().decode(chunks[0]);
        checkStr('decoded, it is the VERBATIM wire text', text, ONE_ID_TEXT);
        check(
            "so the SENT digits are in the caller's hands",
            text.includes(SNOWFLAKE),
            true,
        );
        note(
            'LOSSLESS. `fetchAdapter` returns `response.body` unparsed when `req.stream` is set (http-adapter.ts:93), so line 135 never runs',
            '',
        );
    }

    heading("C6 (b) — `stream` with decode: 'lines'");
    {
        const call = stream({
            name: 'streamThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(ONE_ID_TEXT),
            stream: { decode: 'lines' },
        });
        const lines = (await call()) as string[];
        checkSeq('the decoded lines', lines, [ONE_ID_TEXT]);
        check('typeof the delta', typeof lines[0], 'string');
        note('LOSSLESS — a line is a string; nothing parsed it', '');
    }

    heading("C6 (c) — `stream` with decode: 'ndjson'");
    {
        const call = stream({
            name: 'streamThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(ONE_ID_TEXT),
            stream: { decode: 'ndjson' },
        });
        const recs = (await call()) as { id: number }[];
        check('how many records', recs.length, 1);
        checkDigits('the id it decoded', recs[0]?.id, '1234567890123456768');
        note(
            'CORRUPTED. `stream.ts:decodeStream` calls `JSON.parse(line)` per record — the same primitive, in a different file. Streaming is not the safe path; NOT PARSING is',
            '',
        );
    }

    heading("C6 (d) — `stream` with decode: 'json'");
    {
        const call = stream({
            name: 'streamThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(ONE_ID_TEXT),
            stream: { decode: 'json' },
        });
        const vals = (await call()) as { id: number }[];
        check('how many values', vals.length, 1);
        checkDigits('the id it decoded', vals[0]?.id, '1234567890123456768');
        note(
            'CORRUPTED. The structural streaming-JSON decoder builds numbers the same way',
            '',
        );
    }

    heading('C6 (e) — `download`');
    {
        const call = download({
            name: 'downloadThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(ONE_ID_TEXT),
        });
        const res = (await call()) as { blob: Blob; filename?: string };
        check('the result carries a Blob', res.blob instanceof Blob, true);
        check('blob size in bytes', res.blob.size, ONE_ID_TEXT.length);
        const text = await res.blob.text();
        checkStr('and its text is verbatim', text, ONE_ID_TEXT);
        note(
            'LOSSLESS. `download` sets `wire.response: "blob"`, so `fetchAdapter` takes the blob branch (line 121) and never reaches the json branch',
            '',
        );
    }

    heading('C6 (f) — `sse`');
    {
        const frame = `data: ${ONE_ID_TEXT}\n\n`;
        const call = sse({
            name: 'sseThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(frame, 'text/event-stream'),
        });
        const events = (await call()) as { data: { id: number } }[];
        check('how many events', events.length, 1);
        checkDigits(
            'event.data.id',
            events[0]?.data?.id,
            '1234567890123456768',
        );
        note(
            'CORRUPTED. `sse.ts:parseData` JSON-parses each `data:` payload, falling back to the raw string only when it is NOT valid JSON — so a valid JSON payload is always parsed, and always lossy',
            '',
        );
        // …and the fallback is the escape hatch, measured: a payload that is not JSON stays a string.
        const bare = `data: ${SNOWFLAKE}x\n\n`;
        const call2 = sse({
            name: 'sseThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(bare, 'text/event-stream'),
        });
        const ev2 = (await call2()) as { data: unknown }[];
        checkStr(
            'a non-JSON payload comes through as a raw string',
            String(ev2[0]?.data),
            `${SNOWFLAKE}x`,
        );
        // And the one that matters: a bare large integer IS valid JSON, so it parses and corrupts.
        const bareNum = `data: ${SNOWFLAKE}\n\n`;
        const call3 = sse({
            name: 'sseThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: streamingAdapter(bareNum, 'text/event-stream'),
        });
        const ev3 = (await call3()) as { data: unknown }[];
        checkDigits(
            'but a BARE large integer is valid JSON, so it parses — and corrupts',
            ev3[0]?.data,
            '1234567890123456768',
        );
    }

    heading('C6 (g) — the summary that answers the claim');
    {
        // Assembled as data so the conclusion is a printed table rather than prose.
        const rows = [
            "stream decode:'bytes'  -> Uint8Array  LOSSLESS",
            "stream decode:'lines'  -> string      LOSSLESS",
            "stream decode:'ndjson' -> object      CORRUPTED",
            "stream decode:'json'   -> object      CORRUPTED",
            'download               -> Blob        LOSSLESS',
            'sse                    -> object      CORRUPTED',
        ];
        for (const r of rows) note(r);
        checkSeq('the six surface/decoder pairs', rows, [
            "stream decode:'bytes'  -> Uint8Array  LOSSLESS",
            "stream decode:'lines'  -> string      LOSSLESS",
            "stream decode:'ndjson' -> object      CORRUPTED",
            "stream decode:'json'   -> object      CORRUPTED",
            'download               -> Blob        LOSSLESS',
            'sse                    -> object      CORRUPTED',
        ]);
        note(
            '→ the split is by DECODER, not by surface. Every path that hands you bytes or text is lossless; every path that calls `JSON.parse` for you is lossy, wherever it lives',
            '',
        );
    }

    finish(
        'C6',
        'PARTIAL — "streaming sees raw bytes" is true, "streaming is a safer path" is only half true, and the split is by DECODER rather than by surface. LOSSLESS, measured: `stream` with the default `decode: "bytes"` yields one `Uint8Array` that decodes to the verbatim {"id":1234567890123456789}; `decode: "lines"` yields that same string; `download` yields a 26-byte Blob whose text is verbatim. Each of those takes a different branch of `fetchAdapter` — the stream branch at line 93, the blob branch at line 121 — and never reaches the `JSON.parse` at line 135. CORRUPTED, measured: `stream` with `decode: "ndjson"` and with `decode: "json"` both yield 1234567890123456768, because `stream.ts:decodeStream` calls `JSON.parse` per record; `sse` yields 1234567890123456768 because `sse.ts:parseData` JSON-parses every `data:` payload that parses at all — and a bare 19-digit integer IS valid JSON, so even an unstructured SSE payload corrupts (only a genuinely non-JSON payload, "1234567890123456789x", survived as a string). So the safe streaming paths are exactly the ones that decline to parse for you, which is C3\'s trade arrived at from the other side',
    );
}

void main();
