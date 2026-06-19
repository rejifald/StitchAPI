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
import type { Stitch, StitchEvent } from 'stitchapi';

// ---------------------------------------------------------------------------
// The structural call contract
// ---------------------------------------------------------------------------

/** A callable returning an awaitable validated output (the unary surface). */
export type StitchLike<T, Input = unknown> = (input?: Input) => PromiseLike<T>;

/** A callable whose result is also streamable (`sse` / `stream` surfaces). */
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
 * the error's `name` and `message` plus any primitive own fields (e.g. a
 * `StitchError`'s `status`). */
export interface StitchQueryFnError {
    readonly name: string;
    readonly message: string;
    readonly [key: string]: unknown;
}

/** RTK Query's `queryFn` return shape (`{ data } | { error }`), stated
 * structurally so it composes with `build.query({ queryFn })`. */
export type QueryFnResult<Data> =
    | { data: Data; error?: undefined }
    | { data?: undefined; error: StitchQueryFnError };

function isPrimitive(v: unknown): boolean {
    return (
        v === null ||
        v === undefined ||
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
    );
}

function serializeError(reason: unknown): StitchQueryFnError {
    if (reason instanceof Error) {
        const extra: Record<string, unknown> = {};
        const own = reason as unknown as Record<string, unknown>;
        for (const key of Object.keys(reason)) {
            const value = own[key];
            if (isPrimitive(value)) extra[key] = value;
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
    stitch: StitchLike<T, unknown>,
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

/** How a streaming endpoint folds `delta` chunks into its cached array. */
export interface StreamUpdaterOptions {
    /** `'append'` (default) pushes every chunk; `'replace'` keeps only the latest. */
    readonly mode?: 'append' | 'replace';
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
 * The cached data is the accumulated chunks (`mode: 'append'`, default) or the
 * latest chunk (`mode: 'replace'`). Streaming stops when the cache entry is removed.
 */
export function stitchStreamUpdater<Chunk, Input = unknown>(
    stitch: StreamableStitchLike<unknown, Input>,
    options?: StreamUpdaterOptions,
): (input: Input, api: CacheLifecycleApi<Chunk[]>) => Promise<void>;
export function stitchStreamUpdater<Chunk>(
    stitch: StreamableStitchLike<unknown, unknown>,
    options: StreamUpdaterOptions = {},
): (input: unknown, api: CacheLifecycleApi<Chunk[]>) => Promise<void> {
    const mode = options.mode ?? 'append';
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
