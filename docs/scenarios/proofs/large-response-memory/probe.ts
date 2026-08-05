// One measurement, one process. `probe.ts --mode=<m> --rows=<n> [--buffer=<chars>]` runs exactly one
// workload against the fake export endpoint and prints ONE line of JSON to stdout: the
// {@link Measurement}.
//
// Why a separate process per measurement: V8's heap is a shared, stateful thing. Running the
// buffered baseline and the streaming control in the same process means the second one inherits the
// first one's fragmented old space, its grown heap limit, and whatever the collector had not yet
// released. Forking gives every number a clean start, and it is the difference between a result you
// can quote and a result you have to apologise for. The claim scripts (`c1`…`c8`) spawn this file.
//
// Why the sampler lives on the PRODUCER: see `Wire.watch`. Every mode here is sampled the same way,
// once per emitted wire chunk, so `.stream()` and `await` get exactly the same number of chances to
// observe a peak. The buffered modes take two EXTRA marks — with the whole response text live, and
// with the text and the parsed tree both live — because that path's high-water mark happens after
// the last byte arrives and would otherwise be invisible. That asymmetry is in the measurement's
// favour for the streaming modes, not against them.
//
// Run it directly to see a single number:
//   pnpm exec tsx --expose-gc docs/scenarios/proofs/large-response-memory/probe.ts --mode=buffered --rows=100000
import { stitch } from '../../../../packages/core/src/index';
import { stream, streamSurface } from '../../../../packages/core/src/stream';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    ResolvedStitchConfig,
    StitchEvent,
} from '../../../../packages/core/src/types';
import { batchedSurface, drainBatched } from './batched-export';
import {
    bufferingAdapter,
    concatObjects,
    eagerArray,
    ndjson,
    singleArray,
    streamingAdapter,
} from './fake-export';
import { type Measurement, type Sampler, measure } from './mem';
import { countingValidator } from './validator-spy';

const URL = 'https://api.vendor.example/v1/products/export';

/** Forced-GC marks per run — the retained-heap curve, at a cost the run can absorb. */
const MARKS = 12;
/** Rows per batch in the assembled answer (C8). */
export const BATCH = 500;

type Mode =
    // the buffered baseline and its no-library floor
    | 'buffered'
    | 'parse-only'
    // the decoders in isolation: the engine is not in the picture
    | 'decoder-json'
    | 'decoder-ndjson'
    | 'decoder-concat'
    // the decoders through the engine, drained via `.stream()`
    | 'stream-json'
    | 'stream-ndjson'
    // the same, awaited (the collected array is the declared result)
    | 'stream-json-await'
    | 'stream-ndjson-await'
    // an `output` contract on the streaming path
    | 'stream-json-output'
    | 'stream-ndjson-output'
    // a producer that ignores backpressure
    | 'eager-json'
    // the assembled answer, over each wire format
    | 'assembled-json'
    | 'assembled-ndjson';

function arg(name: string, fallback: string): string {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * Drain a `.stream()` event spine, discarding every delta. Returns the delta count.
 *
 * `extra` adds CONSUMER-side sampling, and exactly one mode uses it: `eager-json`, whose producer
 * front-loads the whole body before a byte is decoded, so producer-driven marks all land before the
 * interesting phase. That mode is therefore not heap-comparable with the others — its claim is about
 * `peakBuffers`, not `peakLive`.
 */
async function drainDeltas(
    events: AsyncIterable<StitchEvent>,
    extra?: { s: Sampler; every: number },
): Promise<number> {
    let n = 0;
    const errors: string[] = [];
    for await (const ev of events) {
        if (ev.type === 'delta') {
            n++;
            if (extra && n % extra.every === 0) extra.s.mark();
        } else if (ev.type === 'error') errors.push(ev.message);
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
    return n;
}

async function run(
    mode: Mode,
    rows: number,
    bufferChars: number | undefined,
): Promise<Measurement> {
    const streamCfg = (decode: 'json' | 'ndjson') =>
        bufferChars === undefined
            ? ({ decode } as const)
            : ({ decode, buffer: { chars: bufferChars } } as const);

    switch (mode) {
        // ---- the buffered baseline ---------------------------------------------------------
        case 'buffered': {
            const wire = singleArray(rows);
            return measure(async (s) => {
                wire.watch(s, MARKS);
                const exportAll = stitch({
                    url: URL,
                    adapter: bufferingAdapter(wire, { onPeak: s.mark }),
                });
                const products = (await exportAll()) as unknown[];
                s.mark(); // taken WHILE the parsed tree is still referenced — that is the point
                return products.length;
            }, wire.wire);
        }
        // No library at all: read the body to text, `JSON.parse`. The floor the buffered path
        // cannot beat, and the thing `fetchAdapter` itself does (http-adapter.ts:133-138).
        case 'parse-only': {
            const wire = singleArray(rows);
            return measure(async (s) => {
                wire.watch(s, MARKS);
                const reader = wire.body.getReader();
                const decoder = new TextDecoder();
                let parts: string[] = [];
                for (;;) {
                    const r = await reader.read();
                    if (r.done) break;
                    parts.push(decoder.decode(r.value, { stream: true }));
                }
                parts.push(decoder.decode());
                const text = parts.join('');
                parts = [];
                s.mark(); // the whole wire text, live, nothing parsed
                const parsed = JSON.parse(text) as unknown[];
                s.mark(); // text AND tree
                return parsed.length;
            }, wire.wire);
        }

        // ---- the decoders in isolation (no engine) -----------------------------------------
        // `streamSurface.stream` is exactly what the engine calls; calling it directly measures the
        // DECODER's working set with nothing accumulating around it.
        case 'decoder-json':
        case 'decoder-concat':
        case 'decoder-ndjson': {
            const decode = mode === 'decoder-ndjson' ? 'ndjson' : 'json';
            const wire =
                mode === 'decoder-json'
                    ? singleArray(rows)
                    : mode === 'decoder-concat'
                      ? concatObjects(rows)
                      : ndjson(rows);
            const hook = streamSurface.stream as NonNullable<Surface['stream']>;
            const cfg: ResolvedStitchConfig = {
                kind: streamSurface,
                stream: streamCfg(decode),
            };
            return measure(async (s) => {
                wire.watch(s, MARKS);
                let n = 0;
                for await (const row of hook(
                    { status: 200, headers: {}, body: wire.body },
                    cfg,
                )) {
                    void row;
                    n++;
                }
                return n;
            }, wire.wire);
        }

        // ---- the decoders through the engine -----------------------------------------------
        case 'stream-json':
        case 'stream-ndjson':
        case 'stream-json-output':
        case 'stream-ndjson-output': {
            const decode = mode.startsWith('stream-json') ? 'json' : 'ndjson';
            const withOutput = mode.endsWith('-output');
            const wire = decode === 'json' ? singleArray(rows) : ndjson(rows);
            const base = {
                url: URL,
                adapter: streamingAdapter(wire),
                stream: streamCfg(decode),
            };
            const exportAll = withOutput
                ? stream({ ...base, output: countingValidator() })
                : stream(base);
            return measure(async (s) => {
                wire.watch(s, MARKS);
                return drainDeltas(exportAll.stream());
            }, wire.wire);
        }
        case 'stream-json-await':
        case 'stream-ndjson-await': {
            const decode = mode === 'stream-json-await' ? 'json' : 'ndjson';
            const wire = decode === 'json' ? singleArray(rows) : ndjson(rows);
            const exportAll = stream({
                url: URL,
                adapter: streamingAdapter(wire),
                stream: streamCfg(decode),
            });
            return measure(async (s) => {
                wire.watch(s, MARKS);
                const products = await exportAll();
                s.mark(); // the collected array is live here
                return products.length;
            }, wire.wire);
        }

        // ---- a producer that ignores backpressure -------------------------------------------
        // `eagerArray` enqueues the WHOLE body before the consumer reads a byte, so its own `watch`
        // samples fire during `start()` — before anything is decoded. That is the point: the peak
        // this mode reports is the stream's internal queue, not the decoder's.
        case 'eager-json': {
            const wire = eagerArray(rows);
            const exportAll = stream({
                url: URL,
                adapter: streamingAdapter(wire),
                stream: streamCfg('json'),
            });
            return measure(async (s) => {
                wire.watch(s, MARKS);
                return drainDeltas(exportAll.stream(), {
                    s,
                    every: Math.max(1, Math.floor(rows / MARKS)),
                });
            }, wire.wire);
        }

        // ---- the assembled answer ------------------------------------------------------------
        case 'assembled-json':
        case 'assembled-ndjson': {
            const decode = mode === 'assembled-json' ? 'json' : 'ndjson';
            const wire = decode === 'json' ? singleArray(rows) : ndjson(rows);
            let sunk = 0;
            const surface = batchedSurface({
                batch: BATCH,
                validate: countingValidator().validate,
                // Stand-in for the database insert. It must not RETAIN the rows, which is the whole
                // discipline: process the batch, keep a summary, let it go.
                onBatch: (batch) => {
                    sunk += batch.length;
                },
            });
            // `stitch({ kind })`, NOT `stream({ kind })` — the `stream()` helper spreads your config
            // and then overwrites `kind` with `streamSurface` (stream.ts:143-146), so a custom
            // surface passed to it is silently dropped. C8(b) asserts that.
            const exportAll = stitch({
                url: URL,
                adapter: streamingAdapter(wire),
                stream: streamCfg(decode),
                kind: surface,
            });
            return measure(async (s) => {
                wire.watch(s, MARKS);
                const done = await drainBatched(exportAll.stream());
                s.mark();
                if (done.error !== undefined) throw new Error(done.error);
                if (done.rows !== sunk)
                    throw new Error('receipt total disagreed with the sink');
                return done.rows;
            }, wire.wire);
        }
    }
}

async function main(): Promise<void> {
    const mode = arg('mode', 'buffered') as Mode;
    const rows = Number(arg('rows', '10000'));
    const bufferArg = arg('buffer', '');
    const bufferChars = bufferArg === '' ? undefined : Number(bufferArg);
    try {
        const m = await run(mode, rows, bufferChars);
        console.log(JSON.stringify({ mode, rows, ok: true, ...m }));
    } catch (e) {
        // A workload that BLEW UP is a measurement too — C3's whole finding is one of these. Report
        // it as data on stdout rather than a stack trace on stderr, so the claim scripts can assert
        // on the message.
        console.log(
            JSON.stringify({
                mode,
                rows,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            }),
        );
    }
}

void main();
