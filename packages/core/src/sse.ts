// The `stitchapi/sse` surface subpath (ADR 0005 Decision 4): Server-Sent Events over `fetch` +
// Web Streams — never `EventSource` (GET-only, no custom headers, Node-absent — fails all three
// gates). The `stream` hook parses the `text/event-stream` wire format off the response's
// `ReadableStream` and yields one parsed event per `delta` chunk. SSE rides the same auth / retry /
// headers spine as every other surface. Auto-reconnection / `Last-Event-ID` resume is now IN (issue
// #71), behind the off-by-default `sse.reconnect` option: the surface exposes three generic resume
// hooks (`resumeToken` → the event `id`, `resumeRetry` → the event `retry`, `applyResume` → set
// the `Last-Event-ID` request header) and the engine drives the reconnect loop surface-agnostically.
//
// Bundle-frugal (Decision 10): this module — and the frame parser — is reached only through the
// `sse` subpath, never from the root entry; `import { stitch }` pulls in no SSE code.
import type { InputOf, OutputOf } from './infer';
import { JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS } from './json-stream';
import { lineReader } from './line-reader';
import { seam as makeSeam } from './seam';
import { makeStitch } from './stitch';
import type { Surface } from './surface';
import {
    type AdapterResponse,
    type NoUnknownConfigKeys,
    type NoUnknownNestedKeys,
    type ResolvedStitchConfig,
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

// The fields accumulated for the current event block, reset on every blank line.
interface SseFrame {
    event?: string;
    id?: string;
    retry?: number;
    dataLines: string[];
}

function freshFrame(): SseFrame {
    return { dataLines: [] };
}

// Apply one non-blank, non-comment field line to the frame. Split on the first colon; the value has
// exactly one leading space stripped (SSE). `event` / `data` / `id` / `retry` are recognised — a
// `data:` line accumulates (multiple join with `\n`), an `id` containing NUL and a non-numeric
// `retry` are ignored per spec — and any other field name is dropped.
function applyFieldLine(frame: SseFrame, line: string): void {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // strip ONE leading space

    if (field === 'event') frame.event = value;
    else if (field === 'data') frame.dataLines.push(value);
    else if (field === 'id') {
        if (!value.includes('\0')) frame.id = value; // SSE: ignore an id containing NUL
    } else if (field === 'retry') {
        if (/^\d+$/.test(value)) frame.retry = Number(value);
    }
}

// Build the event a blank line dispatches — or `undefined` when no `data:` field was seen, since an
// id/retry/event-only block is not dispatched (SSE spec dispatch step 2).
function dispatchFrame(frame: SseFrame): SseEvent | undefined {
    if (frame.dataLines.length === 0) return undefined;
    const ev: SseEvent = { data: parseData(frame.dataLines.join('\n')) };
    if (frame.event !== undefined) ev.event = frame.event;
    if (frame.id !== undefined) ev.id = frame.id;
    if (frame.retry !== undefined) ev.retry = frame.retry;
    return ev;
}

// Parse the `text/event-stream` grammar off a byte stream: events are separated by blank lines;
// `event:` / `data:` / `id:` / `retry:` fields accumulate (multiple `data:` lines join with `\n`);
// `:`-prefixed lines are comments; exactly one leading space after the field colon is stripped. A
// trailing event with no terminating blank line is discarded (spec), as is a block with no `data:`.
//
// `maxBufferChars` bounds the accumulated `data:` payload of a SINGLE in-progress frame (a run of
// `data:` lines with no dispatching blank line): without this an upstream that streams endless
// `data:` fields — or one giant unterminated line — would grow client memory without limit (an OOM
// DoS). `lineReader` caps a single un-terminated LINE with the same knob; this caps the frame that
// spans many terminated lines. Counted in characters of the decoded text, not bytes off the socket.
// Same default (~8M chars) and thrown-error → `error` event contract as the
// `'json'` decoder (`json-stream.ts` / `runStreaming`). Overridable per-stream via `stream.buffer.chars`.
async function* parseEventStream(
    body: ReadableStream<Uint8Array>,
    maxBufferChars: number = JSON_STREAM_DEFAULT_MAX_BUFFER_CHARS,
): AsyncGenerator<SseEvent, void> {
    let frame = freshFrame();
    let frameChars = 0; // accumulated length of the current frame's data lines (+1 per join `\n`)

    for await (const raw of lineReader(body, maxBufferChars)) {
        // lineReader splits on `\n`; strip a trailing `\r` so CRLF streams parse (the SSE plumbing
        // shared with `stream`'s `'lines'` stays a literal `\n` split — Q3).
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

        if (line === '') {
            const ev = dispatchFrame(frame);
            if (ev !== undefined) yield ev;
            frame = freshFrame();
            frameChars = 0;
        } else if (!line.startsWith(':')) {
            const before = frame.dataLines.length;
            applyFieldLine(frame, line); // non-comment field line
            // Track only `data:` growth (the only field that accumulates): the pushed value plus the
            // `\n` that `dispatchFrame` joins it with. A frame that never sees a blank line can't grow
            // past the cap.
            if (frame.dataLines.length > before) {
                const added = frame.dataLines[frame.dataLines.length - 1] ?? '';
                frameChars += added.length + (before > 0 ? 1 : 0);
                if (frameChars > maxBufferChars) {
                    throw new Error(
                        `sse parser: un-dispatched event data exceeded the stream.buffer.chars cap (${String(
                            maxBufferChars,
                        )}); a frame with no terminating blank line was streamed`,
                    );
                }
            }
        }
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
    async *stream(res: AdapterResponse, cfg: ResolvedStitchConfig) {
        const body = res.body;
        if (body instanceof ReadableStream)
            yield* parseEventStream(
                body as ReadableStream<Uint8Array>,
                cfg.stream?.buffer?.chars,
            );
    },
    contractValue: (chunk) => (chunk as SseEvent).data,
    // Resumable-SSE hooks (issue #71). The engine reads the last `id:` and server `retry:` off each
    // emitted event, and — when the body drops and `sse.reconnect` is on — replays the id as the
    // `Last-Event-ID` header on the reopened request. Plain reads/writes; no SSE-ism leaks into the
    // engine, which stays surface-agnostic (it only knows "this surface can resume").
    resumeToken: (chunk) => (chunk as SseEvent).id,
    resumeRetry: (chunk) => (chunk as SseEvent).retry,
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
        config: C & NoUnknownConfigKeys<C> & NoUnknownNestedKeys<C>,
    ) => Stitch<SseEvent<OutputOf<C>>[], InputOf<C>>;
    readonly seam: Seam;
}

// Standalone sse stitch: the call argument is inferred from `config.input`, the result fixed to the
// collected event array (a streaming await resolves to all of its `delta` chunks — Stage 5). Each
// event's `.data` is typed from `config.output` via `OutputOf<C>` (#115) — `unknown` when no `output`,
// keeping `SseEvent<unknown>[]` identical to the old `SseEvent[]`. The `as` retypes the loose
// `makeStitch` result to the declared `InputOf<C>`/`SseEvent<OutputOf<C>>[]`: now that `InputOf` reads
// `extends`-fragment schemas (#76) it is no longer a clean supertype of `StitchInput` under an
// unresolved `C`, so this loose body needs the same retype `stitch()`/`bind` get from their
// inferring overloads. Sound — the runtime stitch is byte-identical (the type tests cover it).
const sseStitch = <
    const C extends Partial<StitchConfig> = Partial<StitchConfig>,
>(
    config: C & NoUnknownConfigKeys<C> & NoUnknownNestedKeys<C>,
): Stitch<SseEvent<OutputOf<C>>[], InputOf<C>> =>
    makeStitch<SseEvent[]>({
        ...config,
        kind: sseSurface,
    }) as unknown as Stitch<SseEvent<OutputOf<C>>[], InputOf<C>>;

// Bind sse members to a seam through the seam's surface-agnostic `stitch({ kind })` (Decision 3) —
// no per-surface seam method; one shared runtime / principal boundary.
function bindSeam(s: Seam): SseSeamApi {
    // Implemented loose and `as`-cast to the declared member type — the same idiom as
    // `download.ts`'s binder, for the same reason: a generic impl whose parameter is
    // `C & NoUnknownConfigKeys<C>` cannot be checked against a member of that same shape, because
    // TypeScript instantiates the impl's `C` with the target's whole intersection and the two
    // `InputOf<C>` return types stop matching. Sound — the runtime is one `s.stitch` call, and the
    // type tests pin every concrete config.
    const stitch = ((config: Partial<StitchConfig>) =>
        s.stitch<SseEvent[]>({
            ...config,
            kind: sseSurface,
        })) as SseSeamApi['stitch'];
    return { stitch, seam: s };
}

/**
 * The sse surface's authoring helper — callable for the terse form (`sse(config)`) plus:
 * - `sse.stitch(config)` — a standalone sse stitch (alias of the callable).
 * - `sse.bind(existingSeam)` — bind sse members to an existing seam.
 * - `sse.bind(options)` — a new seam whose members default to sse.
 * - `sse.surface` — the sse {@link Surface} identity.
 */
export const sse = Object.assign(sseStitch, {
    surface: sseSurface,
    stitch: sseStitch,
    bind: (arg: Seam | SeamOptions): SseSeamApi =>
        bindSeam(isSeam(arg) ? arg : makeSeam(arg)),
});
