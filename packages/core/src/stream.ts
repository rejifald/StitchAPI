// The `stitchapi/stream` surface subpath (ADR 0005 Decision 5): raw response streaming with a
// configurable decoder. Its `stream` hook reads the response's `ReadableStream` and emits each
// decoded item as a `delta` chunk, per `stream.decode`:
//   - `'bytes'`  (default) — raw `Uint8Array` chunks, lossless, no encoding assumed (Q2).
//   - `'lines'`  — UTF-8 lines (split on `\n`).
//   - `'ndjson'` — `'lines'` + `JSON.parse` per non-blank line.
//   - `'json'`   — STRUCTURAL streaming-JSON (issue #111): one delta per complete value / top-level
//                  array element, tolerant of internal newlines + concatenated values (`json-stream`).
// The `'lines'`/`'ndjson'` decoders share the byte→line plumbing with `sse` (the `lineReader`), but
// `sse` layers its own event-stream frame parser on top — they share plumbing, not a decoder (Q3).
// `'json'` does NOT use the line plumbing at all — it scans JSON structure directly.
//
// Bundle-frugal (Decision 10): reached only through the `stream` subpath; `import { stitch }` pulls
// in none of it.
import type { InputOf, OutputOf } from './infer';
import { jsonStream } from './json-stream';
import { lineReader } from './line-reader';
import { seam as makeSeam } from './seam';
import { makeStitch } from './stitch';
import type { Surface } from './surface';
import {
    type AdapterResponse,
    type ResolvedStitchConfig,
    type Seam,
    type SeamOptions,
    type Stitch,
    type StitchConfig,
    type StitchInput,
    isSeam,
} from './types';

// ---- delta element type inference (#115) — PURELY compile-time ------------------------------------
// The `stream` surface has NO `contractValue` (engine.ts `runStreaming`): the element the caller sees
// is whatever the DECODER produced, so the static element type is decoder-dependent — `output` refines
// only the structured (`'ndjson'`) decoder, never the raw `'bytes'`/`'lines'` ones (which `output`
// can't reshape). Reading `config.stream.decode` literally fixes the branch.

/** The literal `stream.decode` mode a config declares, defaulting to `'bytes'` (the runtime default). */
type StreamDecodeOf<C> = C extends { stream: { decode: infer D } }
    ? D
    : 'bytes';

/**
 * The decoded delta element type for a config `C`:
 *   - `'lines'`  → `string` (UTF-8 lines; `output` is ignored — it can't reshape a raw line).
 *   - `'ndjson'` → `OutputOf<C>` (the structured per-record value; `unknown` when no `output`).
 *   - `'json'`   → `OutputOf<C>` (issue #111) — structural streaming-JSON values are structured,
 *     exactly like `'ndjson'`, so `output` refines each emitted value too.
 *   - `'bytes'` (default) + any unrecognised `decode` → `Uint8Array` (raw chunks; `output` ignored).
 *
 * NOTE: `output` deliberately refines ONLY the structured decoders (`'ndjson'`/`'json'`).
 * `stream({ output: S })` with NO `decode` stays `Uint8Array[]` — `decode` defaults to `'bytes'`,
 * which `output` can't reshape. That is intended, not a bug.
 */
type StreamElement<C> =
    StreamDecodeOf<C> extends 'lines'
        ? string
        : StreamDecodeOf<C> extends 'ndjson' | 'json'
          ? OutputOf<C>
          : Uint8Array; // 'bytes' default + any unknown decode

// Decode the live body into `delta` items per `cfg.stream.decode` (default `'bytes'`).
async function* decodeStream(
    res: AdapterResponse,
    cfg: ResolvedStitchConfig,
): AsyncGenerator<unknown, void> {
    const body = res.body;
    if (!(body instanceof ReadableStream)) return;
    const stream = body as ReadableStream<Uint8Array>;
    const decode = cfg.stream?.decode ?? 'bytes';

    // `stream.buffer.chars` caps a single un-terminated line for the line-based decoders too (an
    // upstream that never sends a `\n` would otherwise grow memory without limit); a throw becomes
    // an `error` event in the engine. Same default (~8 MB) / knob as the `'json'` decoder below.
    const maxBufferChars = cfg.stream?.buffer?.chars;
    if (decode === 'lines') {
        yield* lineReader(stream, maxBufferChars);
        return;
    }
    if (decode === 'ndjson') {
        for await (const line of lineReader(stream, maxBufferChars)) {
            if (line.trim() === '') continue; // tolerate blank lines between records
            const parsed: unknown = JSON.parse(line);
            yield parsed;
        }
        return;
    }
    if (decode === 'json') {
        // Structural, unframed streaming-JSON (issue #111): one delta per complete value / top-level
        // array element. `stream.buffer.chars` (if set) bounds a single in-progress value; a throw
        // on overflow / mid-value EOF becomes an `error` event in the engine.
        yield* jsonStream(stream, cfg.stream?.buffer?.chars);
        return;
    }
    // 'bytes' (default): hand back raw chunks exactly as they arrive on the wire.
    const reader = stream.getReader();
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            yield r.value;
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * The raw streaming surface. Its `stream` hook marks it streaming (Decision 12): the engine opens
 * the live body, feeds it here, and emits each decoded chunk as a `delta`.
 */
export const streamSurface: Surface<StitchInput, unknown[]> = {
    id: 'stream',
    stream: (res, cfg) => decodeStream(res, cfg),
};

/** stream members bound to a seam. `stitch(config)` creates a stream member of `seam`; `seam` is
 *  the underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface StreamSeamApi {
    readonly stitch: <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ) => Stitch<StreamElement<C>[], InputOf<C>>;
    readonly seam: Seam;
}

// Standalone stream stitch: the call argument is inferred from `config.input`, the result fixed to
// the collected chunk array (a streaming await resolves to all of its `delta` chunks — Stage 5). The
// element type is decoder-dependent via `StreamElement<C>` (#115): `Uint8Array`/`string` for the raw
// `'bytes'`/`'lines'` decoders, `OutputOf<C>` for `'ndjson'`. The `as` retypes the loose `makeStitch`
// result to the declared `InputOf<C>`/`StreamElement<C>[]`: now that `InputOf` reads `extends`-fragment
// schemas (#76) it is no longer a clean supertype of `StitchInput` under an unresolved `C`, so this
// loose body needs the same retype `stitch()`/`bind` get from their inferring overloads. Sound — the
// runtime stitch is byte-identical (the type tests cover it).
const streamStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    config: C,
): Stitch<StreamElement<C>[], InputOf<C>> =>
    makeStitch<unknown[]>({
        ...config,
        kind: streamSurface,
    }) as unknown as Stitch<StreamElement<C>[], InputOf<C>>;

// Bind stream members to a seam through the seam's surface-agnostic `stitch({ kind })` (Decision 3).
function bindSeam(s: Seam): StreamSeamApi {
    const stitch = <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<StreamElement<C>[], InputOf<C>> =>
        s.stitch<unknown[]>({
            ...config,
            kind: streamSurface,
        }) as unknown as Stitch<StreamElement<C>[], InputOf<C>>;
    return { stitch, seam: s };
}

/**
 * The stream surface's authoring helper — callable for the terse form (`stream(config)`) plus:
 * - `stream.stitch(config)` — a standalone stream stitch (alias of the callable).
 * - `stream.bind(existingSeam)` — bind stream members to an existing seam.
 * - `stream.bind(options)` — a new seam whose members default to stream.
 * - `stream.surface` — the stream {@link Surface} identity.
 */
export const stream = Object.assign(streamStitch, {
    surface: streamSurface,
    stitch: streamStitch,
    bind: (arg: Seam | SeamOptions): StreamSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});
