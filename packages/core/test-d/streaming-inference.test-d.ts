// The streaming surfaces refine their delta ELEMENT type from `config.output` (issue #115). PURELY
// compile-time: the runtime decode/emit path is unchanged. `sse` types each event's `.data` from
// `output` (its `contractValue` validates `.data`); `stream`'s element type is DECODER-dependent —
// `output` refines only the structured `'ndjson'` decoder, never raw `'bytes'`/`'lines'`.
//
// Assertions follow stitch.test-d.ts: assert on the UNWRAPPED (awaited) result via `output(...)` from
// `_util` rather than `expectType<Stitch<…>>` (tsd's recursive-`with` identity quirk). Streaming await
// resolves to the collected `delta` array, so `output(sse(...))` is `SseEvent<…>[]` and
// `output(stream(...))` is `<element>[]`.
import { type SseEvent, sse } from '../src/sse';
import { stream } from '../src/stream';
import { output } from './_util';

import { expectType } from 'tsd';
import { z } from 'zod';

const itemSchema = z.object({ id: z.number() });
type Item = z.infer<typeof itemSchema>;

// ---- sse: `output` refines each event's `.data` payload --------------------------------------------

// 1) `sse({ output })` → awaited result `SseEvent<Item>[]`, and `.data` is the inferred type.
const events = sse({ baseUrl: 'x', path: '/stream', output: itemSchema });
expectType<SseEvent<Item>[]>(output(events));
expectType<Item>(output(events)[0]!.data);

// 2) `sse({})` with NO `output` → `SseEvent<unknown>[]` (the unchanged baseline; `.data` is `unknown`).
const bare = sse({ path: '/stream' });
expectType<SseEvent<unknown>[]>(output(bare));
expectType<unknown>(output(bare)[0]!.data);

// 3) a seam-bound sse member infers `.data` identically (covers `bindSeam`). Pass `SeamConfig` (not a
//    pre-built `Seam`) so the seam is minted inside the same module family as `sse` — a `Seam` imported
//    from the root entry is a nominally distinct (built-`lib`) type from `src`'s here.
const member = sse
    .bind({ baseUrl: 'https://x' })
    .stitch({ path: '/s', output: itemSchema });
expectType<SseEvent<Item>[]>(output(member));

// ---- stream: the element type is DECODER-dependent ------------------------------------------------

// 4) `decode: 'ndjson'` + `output` → the inferred record array (the structured decoder takes `output`).
const ndjson = stream({
    path: '/s',
    stream: { decode: 'ndjson' },
    output: itemSchema,
});
expectType<Item[]>(output(ndjson));

// 5) `decode: 'ndjson'` with NO `output` → `unknown[]` (OutputOf<C> falls back to `unknown`).
const ndjsonBare = stream({ path: '/s', stream: { decode: 'ndjson' } });
expectType<unknown[]>(output(ndjsonBare));

// 5b) `decode: 'json'` + `output` → the inferred value array (the structural JSON decoder takes
//     `output`, exactly like `'ndjson'` — issue #111).
const json = stream({
    path: '/s',
    stream: { decode: 'json' },
    output: itemSchema,
});
expectType<Item[]>(output(json));

// 5c) `decode: 'json'` with NO `output` → `unknown[]`.
const jsonBare = stream({ path: '/s', stream: { decode: 'json' } });
expectType<unknown[]>(output(jsonBare));

// 6) `decode: 'lines'` → `string[]` (raw lines; `output`, if any, is IGNORED).
const lines = stream({ path: '/s', stream: { decode: 'lines' } });
expectType<string[]>(output(lines));

// 7) `decode: 'bytes'` → `Uint8Array[]` (raw chunks; `output` ignored).
const bytes = stream({ path: '/s', stream: { decode: 'bytes' } });
expectType<Uint8Array[]>(output(bytes));

// 8) no `decode` at all → `Uint8Array[]` (default `'bytes'`).
const defaulted = stream({ path: '/s' });
expectType<Uint8Array[]>(output(defaulted));

// 9) `stream({ output })` with NO `decode` stays `Uint8Array[]` — `output` does NOT apply to the
//    default `'bytes'` decoder. This is intended (see StreamElement's NOTE), NOT a bug.
const outputNoDecode = stream({ path: '/s', output: itemSchema });
expectType<Uint8Array[]>(output(outputNoDecode));

// 10) a seam-bound `stream` member is decoder-dependent too (covers `bindSeam`).
const streamMember = stream
    .bind({ baseUrl: 'https://x' })
    .stitch({ path: '/s', stream: { decode: 'ndjson' }, output: itemSchema });
expectType<Item[]>(output(streamMember));
