// Two spec-mandated SSE field rules in the parser (src/sse.ts) that sse.spec.ts leaves open. That
// suite is exhaustive on data/event/retry/comments/CRLF/chunk-splitting, but not:
//   - an `id:` value containing a NUL is IGNORED (the event still dispatches, just without an id);
//   - an unknown field name is dropped (the event still dispatches from its data).
import { sseSurface } from '../src/sse';
import type { SseEvent } from '../src/sse';
import { streamOf } from './support/streams';

// Run the SSE frame parser over the given chunks and collect the parsed events (mirrors sse.spec).
async function parse(chunks: string[]): Promise<SseEvent[]> {
    const res = { status: 200, headers: {}, body: streamOf(chunks) };
    const out: SseEvent[] = [];
    for await (const ev of sseSurface.stream!(res, {}))
        out.push(ev as SseEvent);
    return out;
}

describe('sse parser field rules', () => {
    test('an id containing a NUL is ignored; the event still dispatches', async () => {
        expect(await parse(['id: a\0b\ndata: x\n\n'])).toEqual([{ data: 'x' }]);
        // contrast: a clean id IS kept.
        expect(await parse(['id: clean\ndata: x\n\n'])).toEqual([
            { id: 'clean', data: 'x' },
        ]);
    });

    test('an unknown field name is dropped; the event still dispatches', async () => {
        expect(await parse(['weird: zzz\ndata: x\n\n'])).toEqual([
            { data: 'x' },
        ]);
    });
});
