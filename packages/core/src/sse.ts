// The `stitchapi/sse` surface subpath (ADR 0005 Decision 4): Server-Sent Events over `fetch` +
// Web Streams — never `EventSource` (GET-only, no custom headers, Node-absent — fails all three
// gates). The `stream` hook parses the `text/event-stream` wire format off the response's
// `ReadableStream` and yields one parsed event per `delta` chunk. SSE rides the same auth / retry /
// headers spine as every other surface. Auto-reconnection / `Last-Event-ID` resume is now IN (issue
// #71), behind the off-by-default `sse.reconnect` option: the surface exposes three generic resume
// hooks (`resumeToken` → the event `id`, `resumeRetryMs` → the event `retry`, `applyResume` → set
// the `Last-Event-ID` request header) and the engine drives the reconnect loop surface-agnostically.
//
// Bundle-frugal (Decision 10): this module — and the frame parser — is reached only through the
// `sse` subpath, never from the root entry; `import { stitch }` pulls in no SSE code.
import type { InputOf, OutputOf } from './infer';
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

/**
 * One Server-Sent Event. `data` is JSON-parsed when it parses, else the raw string. `event` (the
 * type), `id` (last-event id), and `retry` (reconnect ms) are present only when the event carried
 * them. An event is only produced when at least one `data:` field was seen (the SSE spec).
 *
 * The `data` payload type `T` defaults to `unknown` (issue #115): the runtime parser never knows the
 * shape, so every internal use (`parseEventStream`, `contractValue`) and every existing import stays
 * `SseEvent<unknown>` — byte-identical to the old non-generic `SseEvent`. Only the public `sse(...)`
 * helper refines `T` from the config's `output` schema, since `output` validates each event's `.data`
 * (the `sse` surface's `contractValue` points per-`delta` validation at `.data`).
 */
export interface SseEvent<T = unknown> {
    event?: string;
    data: T;
    id?: string;
    retry?: number;
}

// JSON-parse the data payload, falling back to the raw string when it is not JSON (a bare word, a
// log line, …). `JSON.parse` returns `any`; the function's `unknown` return keeps callers honest.
function parseData(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// Parse the `text/event-stream` grammar off a byte stream: events are separated by blank lines;
// `event:` / `data:` / `id:` / `retry:` fields accumulate (multiple `data:` lines join with `\n`);
// `:`-prefixed lines are comments; exactly one leading space after the field colon is stripped. A
// trailing event with no terminating blank line is discarded (spec), as is a block with no `data:`.
async function* parseEventStream(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void> {
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;
    let dataLines: string[] = [];

    for await (const raw of lineReader(body)) {
        // lineReader splits on `\n`; strip a trailing `\r` so CRLF streams parse (the SSE plumbing
        // shared with `stream`'s `'lines'` stays a literal `\n` split — Q3).
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

        if (line === '') {
            // Blank line dispatches the event — but only if a `data:` field was seen. An id/retry/
            // event-only block sets no data and is not dispatched (SSE spec dispatch step 2).
            if (dataLines.length > 0) {
                const ev: SseEvent = { data: parseData(dataLines.join('\n')) };
                if (event !== undefined) ev.event = event;
                if (id !== undefined) ev.id = id;
                if (retry !== undefined) ev.retry = retry;
                yield ev;
            }
            event = undefined;
            id = undefined;
            retry = undefined;
            dataLines = [];
            continue;
        }
        if (line.startsWith(':')) continue; // comment

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1); // strip ONE leading space

        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
        else if (field === 'id') {
            if (!value.includes('\0')) id = value; // SSE: ignore an id containing NUL
        } else if (field === 'retry') {
            if (/^\d+$/.test(value)) retry = Number(value);
        }
        // any other field name is ignored
    }
}

/**
 * The SSE surface. Its `stream` hook marks it streaming (Decision 12): the engine opens the live
 * body, feeds it here, and emits each parsed {@link SseEvent} as a `delta` chunk. Its
 * `contractValue` hook points per-`delta` `output` validation at each event's `data` payload (ADR
 * 0005 Addendum) — the contract describes the payload, not the `{ event, data, id, retry }` envelope.
 */
export const sseSurface: Surface<StitchInput, SseEvent[]> = {
    id: 'sse',
    async *stream(res: AdapterResponse) {
        const body = res.body;
        if (body instanceof ReadableStream)
            yield* parseEventStream(body as ReadableStream<Uint8Array>);
    },
    contractValue: (chunk) => (chunk as SseEvent).data,
    // Resumable-SSE hooks (issue #71). The engine reads the last `id:` and server `retry:` off each
    // emitted event, and — when the body drops and `sse.reconnect` is on — replays the id as the
    // `Last-Event-ID` header on the reopened request. Plain reads/writes; no SSE-ism leaks into the
    // engine, which stays surface-agnostic (it only knows "this surface can resume").
    resumeToken: (chunk) => (chunk as SseEvent).id,
    resumeRetryMs: (chunk) => (chunk as SseEvent).retry,
    applyResume: (req, token) => {
        req.headers['Last-Event-ID'] = token;
    },
};

/** sse members bound to a seam. `stitch(config)` creates an sse member of `seam`; `seam` is the
 *  underlying handle for lifecycle/principal (`.as`/`.flush`/`.close`). */
export interface SseSeamApi {
    readonly stitch: <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ) => Stitch<SseEvent<OutputOf<C>>[], InputOf<C>>;
    readonly seam: Seam;
}

// Standalone sse stitch: the call argument is inferred from `config.input`, the result fixed to the
// collected event array (a streaming await resolves to all of its `delta` chunks — Stage 5). Each
// event's `.data` is typed from `config.output` via `OutputOf<C>` (#115) — `unknown` when no `output`,
// keeping `SseEvent<unknown>[]` identical to the old `SseEvent[]`. The `as` retypes the loose
// `makeStitch` result to the declared `InputOf<C>`/`SseEvent<OutputOf<C>>[]`: now that `InputOf` reads
// `extends`-fragment schemas (#76) it is no longer a clean supertype of `StitchInput` under an
// unresolved `C`, so this loose body needs the same retype `stitch()`/`seam` get from their
// inferring overloads. Sound — the runtime stitch is byte-identical (the type tests cover it).
const sseStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    config: C,
): Stitch<SseEvent<OutputOf<C>>[], InputOf<C>> =>
    makeStitch<SseEvent[]>({
        ...config,
        kind: sseSurface,
    }) as unknown as Stitch<SseEvent<OutputOf<C>>[], InputOf<C>>;

// Bind sse members to a seam through the seam's surface-agnostic `stitch({ kind })` (Decision 3) —
// no per-surface seam method; one shared runtime / principal boundary.
function bindSeam(s: Seam): SseSeamApi {
    const stitch = <
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<SseEvent<OutputOf<C>>[], InputOf<C>> =>
        s.stitch<SseEvent[]>({
            ...config,
            kind: sseSurface,
        }) as unknown as Stitch<SseEvent<OutputOf<C>>[], InputOf<C>>;
    return { stitch, seam: s };
}

/**
 * The sse surface's authoring helper — callable for the terse form (`sse(config)`) plus:
 * - `sse.stitch(config)` — a standalone sse stitch (alias of the callable).
 * - `sse.seam(existingSeam)` — bind sse members to an existing seam.
 * - `sse.seam(options)` — a new seam whose members default to sse.
 * - `sse.surface` — the sse {@link Surface} identity.
 */
export const sse = Object.assign(sseStitch, {
    surface: sseSurface,
    stitch: sseStitch,
    seam: (arg: Seam | SeamOptions): SseSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});
