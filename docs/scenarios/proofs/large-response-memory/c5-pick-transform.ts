// C5 — `pick` / `transform` on a streaming stitch: per-delta or buffering?
//
// The question the capture asked is the wrong question, and finding that out is the claim. Neither
// runs at all. `runStreaming` never calls them (engine.ts:1244-1247 says so in a comment; the code
// path simply has no call site), so the honest answers are "neither" — and the interesting part is
// what that failure MODE looks like from the call site, because a `pick` that silently does nothing
// is a config that reads correct and returns the wrong shape.
//
//   pnpm exec tsx docs/scenarios/proofs/large-response-memory/c5-pick-transform.ts
import { stitch } from '../../../../packages/core/src/index';
import { stream } from '../../../../packages/core/src/stream';
import type { StitchEvent } from '../../../../packages/core/src/types';
import {
    bufferingAdapter,
    ndjson,
    singleArray,
    streamingAdapter,
} from './fake-export';
import { check, checkSeq, finish, heading, note } from './harness';

const URL = 'https://api.vendor.example/v1/products/export';

async function deltas(events: AsyncIterable<StitchEvent>): Promise<{
    chunks: unknown[];
    types: string[];
}> {
    const chunks: unknown[] = [];
    const types: string[] = [];
    for await (const ev of events) {
        types.push(ev.type === 'progress' ? `progress:${ev.phase}` : ev.type);
        if (ev.type === 'delta') chunks.push(ev.chunk);
    }
    return { chunks, types };
}

async function main(): Promise<void> {
    heading('C5 — `pick` and `transform` on a streaming stitch');

    // ── (a) `transform` on a stream: called at all? ───────────────────────────────────────────
    {
        let calls = 0;
        let sawArrayOfLength = 0;
        const wire = ndjson(200);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            transform: (body: unknown) => {
                calls++;
                if (Array.isArray(body))
                    sawArrayOfLength = Math.max(sawArrayOfLength, body.length);
                return { marked: true };
            },
        });
        const r = await deltas(exportAll.stream());
        check('(a) deltas emitted', r.chunks.length, 200);
        check('(a) times `transform` was called', calls, 0);
        check('(a) largest array it saw', sawArrayOfLength, 0);
        check(
            '(a) did the transform’s value reach the consumer?',
            (r.chunks[0] as { marked?: boolean }).marked,
            undefined,
        );
        check(
            '(a) the raw row arrived instead',
            (r.chunks[0] as { currency?: string }).currency,
            'usd',
        );
        note(
            '(a) → NEITHER per-delta NOR buffering. `transform` is DEAD on a stream',
            'not called once, and no event says so: no `info`, no drift finding, no throw',
        );
    }

    // ── (b) `pick` on a stream: same ──────────────────────────────────────────────────────────
    // The realistic authoring mistake: the vendor wraps the export in `{ data: [ … ] }` and the
    // author reaches for the same `pick: 'data'` that works everywhere else.
    {
        const wire = ndjson(50);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            pick: 'id',
        });
        const r = await deltas(exportAll.stream());
        check('(b) deltas emitted', r.chunks.length, 50);
        check(
            '(b) is the delta the picked `id`, or the whole row?',
            typeof r.chunks[0],
            'object',
        );
        check(
            '(b) `pick: "id"` produced',
            JSON.stringify(
                (r.chunks[0] as Record<string, unknown>)['id'] ?? null,
            ),
            '"prd_0000000"',
        );
        note(
            '(b) → the whole row, `pick` ignored',
            'and the STATIC type follows `output`, not `pick`, so the call site does not catch it either',
        );
    }

    // ── (c) the same two on the BUFFERED path, for contrast ───────────────────────────────────
    // Identical spelling, opposite behaviour. This is the asymmetry a docs page has to name.
    {
        let calls = 0;
        const wire = singleArray(50);
        const exportAll = stitch({
            url: URL,
            adapter: bufferingAdapter(wire),
            transform: (body: unknown) => {
                calls++;
                return { data: body as unknown[] };
            },
            pick: 'data',
        });
        const rows = (await exportAll()) as unknown[];
        check('(c) `transform` called on the buffered path', calls, 1);
        check('(c) it received the WHOLE array', rows.length, 50);
        note(
            '(c) → one call, one aggregate — the exact shape C4 feared for `output`',
            '`transform` really is a whole-body hook. It is just not wired to the streaming path at all',
        );
    }

    // ── (d) is there ANY signal that the config was ignored? ──────────────────────────────────
    {
        const wire = ndjson(10);
        const exportAll = stream({
            url: URL,
            adapter: streamingAdapter(wire),
            stream: { decode: 'ndjson' },
            pick: 'nonexistent.deep.path',
            transform: () => ({ nonsense: true }),
        });
        const r = await deltas(exportAll.stream());
        checkSeq(
            '(d) full event spine with both slots set and both ignored',
            [...new Set(r.types)],
            ['start', 'progress:request', 'delta', 'result', 'done'],
        );
        check(
            '(d) `info` events',
            r.types.filter((t) => t === 'info').length,
            0,
        );
        check(
            '(d) `drift` findings',
            r.types.filter((t) => t === 'drift').length,
            0,
        );
        note(
            '(d) → completely silent',
            'the engine teaches elsewhere (an upload progress bar the transport cannot draw gets an `info` event — engine.ts:1694-1698). Two ignored config slots on a stream get nothing',
        );
    }

    finish(
        'C5',
        'NEITHER — they do not run. `transform` was called ZERO times over 200 deltas and `pick` changed nothing: the consumer got the raw decoded row, `pick: "id"` and all. The same two slots on the same fake vendor over the BUFFERED path behave exactly as documented — one `transform` call carrying the whole 50-row array, `pick` selecting from it — so this is a path asymmetry, not a broken hook. And it is completely silent: no `info`, no drift finding, no throw, and the static delta type is derived from `output`, never from `pick`, so the call site does not catch it either. A stitch that carries `pick`/`transform` and is later switched to `kind: stream` keeps compiling and quietly stops reshaping',
    );
}

void main();
