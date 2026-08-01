// The `stitchapi/sse-emit` subpath: the framework-agnostic half of turning a stitch's event
// stream into Server-Sent Events on the SERVER. It is the emission-side twin of `stitchapi/sse`
// (which CONSUMES an SSE response); every HTTP adapter — `@stitchapi/{fastify,hono,express,elysia}`
// and `@stitchapi/next` — shares these types, the shorthand folds, the SSE wire serializer, and
// (critically) the same secure-by-default error framing, instead of each carrying its own copy.
//
// What is NOT here is the per-framework driver: how bytes actually reach the client (Hono's
// `streamSSE`, Fastify's `reply.raw`, a Web `ReadableStream`, …). Each adapter keeps that, and
// nothing else.
//
// Zero-dep and browser-safe (no `node:*`): pure types + string building, so it satisfies the same
// three gates as its siblings and rides the `browser` export condition. Reached only through the
// `sse-emit` subpath — `import { stitch }` pulls in none of it.
import type { AtLeastOne, StitchEvent, StitchEventSource } from './types';
import { envelope } from './util';

/**
 * Anything an SSE emitter can drive: an event iterable (a `.stream()` generator), or anything
 * that hands one back (a `StitchResult`, a stitch stub). RE-EXPORTED from the barrel rather than
 * restated here, so an adapter accepts exactly what core says a source is — there is one
 * definition, so there is nothing to keep in step. (`AsyncGenerator` needs no arm of its own: it
 * already satisfies `AsyncIterable`.)
 */
export type { StitchEventSource } from './types';

/**
 * Resolve the canonical intake to the event iterable itself: a `.stream()`-bearing source (a
 * `StitchResult`, a stitch stub) is asked for its stream; an iterable is used as-is. Every
 * adapter's driver starts here, so the two arms are unwrapped in exactly one place.
 */
export function toIterable<T>(
    source: StitchEventSource<T>,
): AsyncIterable<StitchEvent<T>> {
    return Symbol.asyncIterator in source
        ? (source as AsyncIterable<StitchEvent<T>>)
        : source.stream();
}

/** The terminal `error` event a stitch stream emits — carries `message`, `status`, `attempts`. */
export type StitchErrorEvent = Extract<StitchEvent, { type: 'error' }>;

/** Shape a `delta` chunk into the SSE frame `data`. Receives the zero-based frame index alongside
 *  the chunk, so a shaper can number, batch or checkpoint without keeping its own counter. A
 *  one-argument shaper stays valid — JS ignores extra arguments and TS accepts the narrower
 *  signature — so `data: (c) => c.text` needs no change. */
export type DeltaShaper = (chunk: unknown, index: number) => string;
/** Shape a terminal `error` event into the SSE frame `data`. */
export type ErrorShaper = (event: StitchErrorEvent) => string;

/**
 * How each `delta` becomes a message frame. The bare {@link DeltaShaper} form (`delta: (c) => …`)
 * is shorthand for `{ data: (c) => … }` (folded by {@link resolveDelta}).
 */
export interface DeltaFrameOptions {
    /**
     * Map a `delta` chunk to the SSE frame `data`. Default: the chunk itself (a string is sent
     * as-is; anything else is `JSON.stringify`-ed — see {@link defaultData}). Pull the text out of
     * a structured chunk with, e.g., `(c) => c.choices[0].delta.content ?? ''`. Receives the
     * zero-based frame index as a second argument.
     */
    data?: DeltaShaper;
    /**
     * Emit an `event:` line per frame (the SSE event name). Default: none (an unnamed `message`
     * event, which `EventSource.onmessage` receives). A fixed string labels every message
     * (`event: 'token'`); a **function** names them per chunk — e.g. routing tool-calls and text
     * to different client handlers off one stream.
     */
    event?: string | ((chunk: unknown, index: number) => string);
    /**
     * Provide an `id:` line per frame (the SSE last-event id), e.g. for resumable streams. Receives
     * the chunk and the zero-based frame index.
     */
    id?: (chunk: unknown, index: number) => string;
}

/**
 * How the terminal `error` becomes the final frame. The bare {@link ErrorShaper} form
 * (`error: (e) => …`) is shorthand for `{ data: (e) => … }` (folded by {@link resolveError}).
 */
export interface ErrorFrameOptions {
    /**
     * Shape the SSE `data` written for a terminal `error` event (or an uncaught throw mid-stream,
     * normalised to an error event via {@link toErrorEvent}). **Default: a generic token
     * (`data: error`, see {@link DEFAULT_ERROR_DATA})** — the raw `event.message` is deliberately
     * *not* echoed, because it can disclose internal network topology (a transport failure reads
     * like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to
     * an untrusted client. Opt in with `(e) => e.message` when the upstream messages are known
     * safe, or return your own payload (e.g. `() => JSON.stringify({ error: 'stream failed' })`). A
     * multi-line return gets one `data:` line each (SSE spec).
     */
    data?: ErrorShaper;
    /** The `event:` name of the terminal error frame. Default `'error'`. */
    event?: string;
    /**
     * Observe the real failure, server-side (a stitch `error` event, or a throw) — use it to
     * log/trace. It does **not** shape the client-facing frame: the SSE `data` sent to the client
     * is controlled by {@link ErrorFrameOptions.data} (a generic token by default), so the raw
     * message reaches your logs here but never the client.
     */
    observe?: (err: unknown) => void;
}

/**
 * The framework-agnostic SSE emit options every adapter shares. Each adapter's public options
 * type (`StreamStitchSseOptions`, `SendStitchSseOptions`, `SseResponseOptions`) extends this,
 * adding only its own framework-specific fields (e.g. Express's `req`, Next's `signal`).
 */
export interface SseEmitOptions {
    /**
     * How each `delta` becomes a frame. Pass a **function** as shorthand for `{ data }`
     * (`delta: (c) => c.text`), or the full `{ data, event, id }` object to set the SSE
     * `event:` / `id:` lines too.
     */
    delta?: DeltaShaper | AtLeastOne<DeltaFrameOptions>;
    /**
     * How the terminal error becomes the final frame. Pass a **function** as shorthand for
     * `{ data }` (`error: (e) => e.message`), or the full `{ data, event, observe }` object. By
     * default the client gets a generic `data: error` token — the raw message is withheld to avoid
     * disclosing internal topology.
     */
    error?: ErrorShaper | AtLeastOne<ErrorFrameOptions>;
}

// The bare function form of each frame option is the `data` shorthand — `envelope` folds it to
// `{ data }`, passes a full object through, and turns the `= {}` default into an empty object.
/** Fold the `delta` option's function shorthand (`(c) => …` ≡ `{ data: (c) => … }`). */
export const resolveDelta = (
    o?: DeltaShaper | AtLeastOne<DeltaFrameOptions>,
): DeltaFrameOptions => envelope(o, 'data') ?? {};
/** Fold the `error` option's function shorthand (`(e) => …` ≡ `{ data: (e) => … }`). */
export const resolveError = (
    o?: ErrorShaper | AtLeastOne<ErrorFrameOptions>,
): ErrorFrameOptions => envelope(o, 'data') ?? {};

/** The default `delta` mapping: a string chunk verbatim, anything else `JSON.stringify`-ed. */
export function defaultData(chunk: unknown): string {
    return typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
}

/**
 * The generic token written as an `error` frame's `data` by default: the raw upstream message is
 * withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
 * (`HTTP 401`) never reaches the client. Override with `error.data`.
 */
export const DEFAULT_ERROR_DATA = 'error';

/**
 * Normalise a thrown value into the terminal `error` event shape, so an `error.data` opt-in sees a
 * consistent argument whether the failure arrived as a surfaced `error` event or an unexpected
 * throw. `attempts`/`at` are best-effort placeholders — an `error.data` hook keys off
 * `name`/`message`.
 */
export function toErrorEvent(reason: unknown): StitchErrorEvent {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    return {
        type: 'error',
        name: e.name,
        message: e.message,
        attempts: 0,
        at: 0,
    };
}

/**
 * Serialize one SSE frame: an optional `event:` line, an optional `id:` line, then one `data:` line
 * per line of `data` (the SSE spec joins multi-line payloads with `\n`, so splitting keeps a
 * multi-line payload from breaking the framing), terminated by the blank line that ends a frame. An
 * empty `event` is treated as none.
 */
export function sseFrame(data: string, event?: string, id?: string): string {
    const lines: string[] = [];
    if (event) lines.push(`event: ${event}`);
    if (id !== undefined) lines.push(`id: ${id}`);
    for (const line of data.split('\n')) lines.push(`data: ${line}`);
    return `${lines.join('\n')}\n\n`;
}

/**
 * Serialize a `delta` chunk into a full SSE frame using resolved {@link DeltaFrameOptions}: the
 * chunk is shaped by `delta.data` (falling back to {@link defaultData}), labelled with `delta.event`
 * and `delta.id(chunk, index)` when set. This is the raw-writer adapters' delta path; the structured
 * emitters (Hono's `writeSSE`) build the frame themselves from the same resolved options.
 */
export function deltaFrame(
    chunk: unknown,
    index: number,
    delta: DeltaFrameOptions,
): string {
    const raw = delta.data?.(chunk, index) ?? defaultData(chunk);
    const id = delta.id ? delta.id(chunk, index) : undefined;
    return sseFrame(raw, deltaEvent(chunk, index, delta), id);
}

/**
 * Resolve {@link DeltaFrameOptions.event} for one frame: a fixed name passes through, a function
 * is called with the chunk and its index, and `undefined` stays `undefined` (an unnamed `message`
 * event). Exported because the STRUCTURED emitters — Hono's `writeSSE`, Nest's `MessageEvent` —
 * build their own frame objects instead of going through {@link deltaFrame}, and must not each
 * re-implement the function-form check.
 */
export function deltaEvent(
    chunk: unknown,
    index: number,
    delta: DeltaFrameOptions,
): string | undefined {
    return typeof delta.event === 'function'
        ? delta.event(chunk, index)
        : delta.event;
}
