// The HONEST COMPARISON for C9 — the same five rules, hand-rolled, with no StitchAPI in it. It
// takes the same `Adapter`-shaped transport as the assembled answer so both sides run against the
// identical fake provider and the behaviour comparison is exact.
//
// The SSE frame parser is counted on THIS side only, and that is the fair accounting: StitchAPI
// ships one (`sse.ts` `parseEventStream`) and a hand-rolled client has to bring its own. It is
// deliberately the minimum that is still correct for this wire shape — multi-line `data:`, CRLF,
// comment lines, and frames split across reads — because a version that skips those is not a
// comparison, it is a bug.
import type {
    Adapter,
    AdapterRequest,
} from '../../../../packages/core/src/types';
import { contentOf, errorOf, isDone } from './fake-llm-stream';
import type { Completion } from './llm-stream';

const TRANSIENT = [429, 502, 503, 504];

/** Parse a `text/event-stream` body into the `data:` payloads it dispatches. */
async function* frames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lines: string[] = [];
    for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (line === '') {
                if (lines.length > 0) {
                    const raw = lines.join('\n');
                    try {
                        yield JSON.parse(raw);
                    } catch {
                        yield raw;
                    }
                    lines = [];
                }
            } else if (!line.startsWith(':')) {
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let value = colon === -1 ? '' : line.slice(colon + 1);
                if (value.startsWith(' ')) value = value.slice(1);
                if (field === 'data') lines.push(value);
            }
            nl = buf.indexOf('\n');
        }
    }
}

/** The same five rules, by hand. */
export async function handRolledCompletion(
    transport: Adapter,
    req: AdapterRequest,
    connectAttempts = 4,
): Promise<Completion> {
    let res = await transport({ ...req, stream: true });
    for (let i = 1; i < connectAttempts && TRANSIENT.includes(res.status); i++)
        res = await transport({ ...req, stream: true });

    let text = '';
    let deltas = 0;
    let complete = false;
    if (res.status >= 400)
        return { text, complete, deltas, error: `HTTP ${String(res.status)}` };
    if (!(res.body instanceof ReadableStream))
        return { text, complete, deltas, error: 'no stream body' };

    try {
        for await (const data of frames(res.body)) {
            const err = errorOf(data);
            if (err !== undefined)
                return {
                    text,
                    complete,
                    deltas,
                    error: `provider error frame: ${String(err.message)}`,
                };
            deltas++;
            complete ||= isDone(data);
            text += contentOf(data) ?? '';
        }
    } catch (e) {
        return {
            text,
            complete,
            deltas,
            error: e instanceof Error ? e.message : String(e),
        };
    }
    return complete
        ? { text, complete, deltas }
        : {
              text,
              complete,
              deltas,
              error: 'stream truncated: no `[DONE]` sentinel',
          };
}
