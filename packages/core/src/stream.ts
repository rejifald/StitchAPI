// The `stitchapi/stream` surface subpath (ADR 0005 Decision 5): raw response streaming with a
// configurable decoder. Its `stream` hook reads the response's `ReadableStream` and emits each
// decoded item as a `delta` chunk, per `stream.decode`:
//   - `'bytes'`  (default) — raw `Uint8Array` chunks, lossless, no encoding assumed (Q2).
//   - `'lines'`  — UTF-8 lines (split on `\n`).
//   - `'ndjson'` — `'lines'` + `JSON.parse` per non-blank line.
// The `'lines'`/`'ndjson'` decoders share the byte→line plumbing with `sse` (the `lineReader`), but
// `sse` layers its own event-stream frame parser on top — they share plumbing, not a decoder (Q3).
//
// Bundle-frugal (Decision 10): reached only through the `stream` subpath; `import { stitch }` pulls
// in none of it.
import type { InputOf } from './infer';
import { lineReader } from './line-reader';
import { seam as makeSeam } from './seam';
import { makeStitch } from './stitch';
import type { Surface } from './surface';
import {
    type AdapterResponse,
    type Seam,
    type SeamOptions,
    type Stitch,
    type StitchConfig,
    type StitchInput,
    isSeam,
} from './types';

// Decode the live body into `delta` items per `cfg.stream.decode` (default `'bytes'`).
async function* decodeStream(
    res: AdapterResponse,
    cfg: StitchConfig,
): AsyncGenerator<unknown, void> {
    const body = res.body;
    if (!(body instanceof ReadableStream)) return;
    const stream = body as ReadableStream<Uint8Array>;
    const decode = cfg.stream?.decode ?? 'bytes';

    if (decode === 'lines') {
        yield* lineReader(stream);
        return;
    }
    if (decode === 'ndjson') {
        for await (const line of lineReader(stream)) {
            if (line.trim() === '') continue; // tolerate blank lines between records
            const parsed: unknown = JSON.parse(line);
            yield parsed;
        }
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
    ) => Stitch<unknown[], InputOf<C>>;
    readonly seam: Seam;
}

// Standalone stream stitch: the call argument is inferred from `config.input`, the result fixed to
// the collected chunk array (a streaming await resolves to all of its `delta` chunks — Stage 5).
const streamStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    config: C,
): Stitch<unknown[], InputOf<C>> =>
    makeStitch<unknown[]>({ ...config, kind: streamSurface });

// Bind stream members to a seam through the seam's surface-agnostic `stitch({ kind })` (Decision 3).
function bindSeam(s: Seam): StreamSeamApi {
    const stitch = <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<unknown[], InputOf<C>> =>
        s.stitch<unknown[]>({ ...config, kind: streamSurface });
    return { stitch, seam: s };
}

/**
 * The stream surface's authoring helper — callable for the terse form (`stream(config)`) plus:
 * - `stream.stitch(config)` — a standalone stream stitch (alias of the callable).
 * - `stream.seam(existingSeam)` — bind stream members to an existing seam.
 * - `stream.seam(options)` — a new seam whose members default to stream.
 * - `stream.surface` — the stream {@link Surface} identity.
 */
export const stream = Object.assign(streamStitch, {
    surface: streamSurface,
    stitch: streamStitch,
    seam: (arg: Seam | SeamOptions): StreamSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});
