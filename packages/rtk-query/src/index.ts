// @stitchapi/rtk-query — use a stitch inside an RTK Query endpoint.
//
// For apps already on [RTK Query](https://redux-toolkit.js.org/rtk-query/overview):
// RTK Query keeps owning the cache, tags, and generated hooks, while the stitch
// stays the typed, validated, traced call. No `@stitchapi/query-core` — RTK Query
// is the store. The adapters are plain functions (no React), so they work with the
// React and the framework-agnostic entry points alike.
//
// - `stitchQueryFn`      — a stitch as an endpoint `queryFn` (error normalised to a
//                          serialisable shape Redux can hold).
// - `stitchStreamUpdater` — fold a streaming stitch's `delta` chunks into the cache
//                          via an endpoint `onCacheEntryAdded` — RTK Query is the one
//                          cache lib here that models streaming.
import type { AtLeastOne, Stitch, StitchEvent } from 'stitchapi';

// ---------------------------------------------------------------------------
// The structural call contract
// ---------------------------------------------------------------------------

/** A callable returning an awaitable validated output (the unary surface). */
// The MINIMAL await-only stitch duck-type (CONTRACT.md P9): this adapter never calls `.stream()`,
// so it accepts any `(input?) => PromiseLike<T>`. The RICH canonical `StitchLike` (awaitable +
// streamable) lives in `@stitchapi/query-core`; a real stitch satisfies both.
export type StitchLike<T, Input = unknown> = (input?: Input) => PromiseLike<T>;

/** A callable whose result is also streamable (`sse` / `stream` surfaces). */
// The INTENTIONAL rich tier, restated locally (CONTRACT.md P9 de-list): this is the same
// awaitable-plus-`stream()` shape as `@stitchapi/query-core`'s canonical `StitchLike`, deliberately
// under a DISTINCT name — two named tiers, not a unique-by-shape clash. It is restated rather than
// imported because this package takes no `@stitchapi/query-core` dependency by design (RTK Query is
// the store); a real stitch satisfies both tiers.
export type StreamableStitchLike<T, Input = unknown> = (
    input?: Input,
) => PromiseLike<T> & { stream(): AsyncIterable<StitchEvent<T>> };

/** The validated output type of a stitch (or `StitchLike`). */
export type QueryOutput<S> =
    S extends Stitch<infer O, infer _I>
        ? O
        : S extends StitchLike<infer O2, infer _I2>
          ? O2
          : unknown;

/** The input type of a stitch (or `StitchLike`). */
export type QueryInput<S> =
    S extends Stitch<infer _O, infer I>
        ? I
        : S extends StitchLike<infer _O2, infer I2>
          ? I2
          : unknown;

// ---------------------------------------------------------------------------
// stitchQueryFn
// ---------------------------------------------------------------------------

/** A serialisable representation of a thrown reason, safe to hold in Redux state:
 * the error's `name` (the stable discriminator) and `message` plus every
 * JSON-survivable own field. For a `StitchError` / `RateLimitError` that means the
 * whole CONTRACT.md P10 field set — `status?`, `attempts`, `body?`, `url?` — survives
 * into Redux state (`body` is the parsed response payload, plain JSON data), so a
 * consumer can branch on a stored error exactly as on the thrown one. Fields that
 * would not survive `JSON.stringify` intact (functions, class instances, cycles) are
 * dropped, as is `RateLimitError.response`: core documents the raw `AdapterResponse`
 * as riding on the live instance only, never a serialized surface. */
export interface StitchQueryFnError {
    readonly name: string;
    readonly message: string;
    readonly status?: number;
    readonly attempts?: number;
    readonly body?: unknown;
    readonly url?: string;
    readonly [key: string]: unknown;
}

/** RTK Query's `queryFn` return shape (`{ data } | { error }`), stated
 * structurally so it composes with `build.query({ queryFn })`. */
export type QueryFnResult<Data> =
    | { data: Data; error?: undefined }
    | { data?: undefined; error: StitchQueryFnError };

/** Does `value` come back from a `JSON.stringify`/`parse` round trip intact? Plain
 * data only: primitives (finite numbers — `NaN`/`Infinity` degrade to `null`),
 * arrays, and plain objects. Class instances (a raw `Response`, a nested `Error`),
 * functions, symbols, bigints, and cyclic structures do not survive, so their
 * fields are dropped rather than mangled. `undefined` INSIDE a container is fine
 * (JSON omits the key / nulls the array slot without throwing). */
function isJsonSurvivable(value: unknown, seen: Set<object>): boolean {
    if (value === null || value === undefined) return true;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return true;
    if (t === 'number') return Number.isFinite(value);
    if (t !== 'object') return false; // function | symbol | bigint
    const obj = value;
    if (seen.has(obj)) return false; // cycle — JSON.stringify would throw
    seen.add(obj);
    let ok: boolean;
    if (Array.isArray(obj)) {
        ok = obj.every((v) => isJsonSurvivable(v, seen));
    } else {
        const proto: unknown = Object.getPrototypeOf(obj);
        ok =
            (proto === Object.prototype || proto === null) &&
            Object.values(obj).every((v) => isJsonSurvivable(v, seen));
    }
    seen.delete(obj); // path-scoped: shared (DAG) substructure is not a cycle
    return ok;
}

function serializeError(reason: unknown): StitchQueryFnError {
    if (reason instanceof Error) {
        const extra: Record<string, unknown> = {};
        const own = reason as unknown as Record<string, unknown>;
        for (const key of Object.keys(reason)) {
            // The raw response carrier stays behind: core documents
            // `RateLimitError.response` (the full `AdapterResponse`, headers and all)
            // as living on the thrown instance ONLY — it must never serialise into a
            // sink, and Redux state (devtools, persistence) is exactly such a sink.
            // The P10 projection of it (`status`/`body`/`url`) is already lifted onto
            // the error's own fields and survives below.
            if (key === 'response') continue;
            const value = own[key];
            if (value !== undefined && isJsonSurvivable(value, new Set()))
                extra[key] = value;
        }
        return { name: reason.name, message: reason.message, ...extra };
    }
    return { name: 'Error', message: String(reason) };
}

/**
 * Turn a stitch into an RTK Query endpoint `queryFn`. On success it returns
 * `{ data }` with the validated output; on a throw it returns `{ error }` with a
 * serialisable error (so Redux holds no non-serialisable value). Pair it with
 * `fakeBaseQuery()` (or any `baseQuery` — `queryFn` bypasses it):
 *
 * ```ts
 * import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
 * import { stitchQueryFn } from '@stitchapi/rtk-query';
 *
 * export const api = createApi({
 *     baseQuery: fakeBaseQuery(),
 *     endpoints: (build) => ({
 *         getUser: build.query({ queryFn: stitchQueryFn(getUser) }),
 *     }),
 * });
 * // → api.useGetUserQuery({ params: { id } })
 * ```
 */
export function stitchQueryFn<S extends StitchLike<unknown, never>>(
    stitch: S,
): (input: QueryInput<S>) => Promise<QueryFnResult<QueryOutput<S>>>;
export function stitchQueryFn<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
): (input: Input) => Promise<QueryFnResult<T>>;
export function stitchQueryFn<T>(
    stitch: StitchLike<T>,
): (input: unknown) => Promise<QueryFnResult<T>> {
    return async (input: unknown): Promise<QueryFnResult<T>> => {
        try {
            return { data: (await stitch(input)) as T };
        } catch (reason) {
            return { error: serializeError(reason) };
        }
    };
}

// ---------------------------------------------------------------------------
// stitchStreamUpdater
// ---------------------------------------------------------------------------

/** How a streaming endpoint folds `delta` chunks into its cached array:
 * `'append'` (default) pushes every chunk; `'replace'` keeps only the latest. */
export type StreamUpdaterMode = 'append' | 'replace';

/** The {@link stitchStreamUpdater} options envelope. At the parameter the mode is
 * the dominant field, so its scalar is accepted directly (`'replace'` ≡
 * `{ mode: 'replace' }`, CONTRACT.md P12) and the object form requires at least one
 * field — `{}` is a compile error, the all-defaults case is omitting the argument
 * (P20). */
export interface StreamUpdaterOptions {
    /** `'append'` (default) pushes every chunk; `'replace'` keeps only the latest. */
    readonly mode?: StreamUpdaterMode;
}

/** The slice of RTK Query's cache-lifecycle API that {@link stitchStreamUpdater}
 * uses — stated structurally so no RTK generics leak into the signature. */
export interface CacheLifecycleApi<Data> {
    updateCachedData(updateRecipe: (draft: Data) => void): void;
    cacheDataLoaded: Promise<unknown>;
    cacheEntryRemoved: Promise<void>;
}

/**
 * Build an endpoint `onCacheEntryAdded` that streams a stitch's `delta` chunks
 * into the cached array as they arrive — RTK Query is the one cache lib here that
 * models streaming. Seed the endpoint with an empty array via `queryFn`:
 *
 * ```ts
 * chat: build.query<number[], { prompt: string }>({
 *     queryFn: () => ({ data: [] }),
 *     onCacheEntryAdded: stitchStreamUpdater(chat),
 * }),
 * ```
 *
 * The cached data is the accumulated chunks (`'append'`, default) or the latest
 * chunk (`'replace'`): pass the mode scalar — `stitchStreamUpdater(chat, 'replace')`
 * ≡ `{ mode: 'replace' }`. Streaming stops when the cache entry is removed.
 */
export function stitchStreamUpdater<Chunk, Input = unknown>(
    stitch: StreamableStitchLike<unknown, Input>,
    options?: StreamUpdaterMode | AtLeastOne<StreamUpdaterOptions>,
): (input: Input, api: CacheLifecycleApi<Chunk[]>) => Promise<void>;
export function stitchStreamUpdater<Chunk>(
    stitch: StreamableStitchLike<unknown>,
    options?: StreamUpdaterMode | AtLeastOne<StreamUpdaterOptions>,
): (input: unknown, api: CacheLifecycleApi<Chunk[]>) => Promise<void> {
    // The scalar shorthand normalises to the canonical `mode` field (CONTRACT.md P0/P12).
    const mode: StreamUpdaterMode =
        typeof options === 'string' ? options : (options?.mode ?? 'append');
    return async (
        input: unknown,
        api: CacheLifecycleApi<Chunk[]>,
    ): Promise<void> => {
        // Wait for the initial (seeded) cache value before patching it.
        await api.cacheDataLoaded;

        const consume = (async () => {
            for await (const event of stitch(input).stream()) {
                if (event.type !== 'delta') continue;
                const chunk = event.chunk as Chunk;
                api.updateCachedData((draft) => {
                    if (mode === 'replace') draft.length = 0;
                    draft.push(chunk);
                });
            }
        })();

        // Stop streaming when the entry is evicted (component unmounts).
        await Promise.race([consume, api.cacheEntryRemoved]);
    };
}
