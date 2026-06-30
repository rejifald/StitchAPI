// @stitchapi/react — React bindings for StitchAPI.
//
// These hooks are a THIN layer over `@stitchapi/query-core`: that package owns
// the reactive store (subscribe / getSnapshot / refetch / cancel), and React's
// `useSyncExternalStore` reads it tearing-free. Because all the behaviour lives
// in the framework-agnostic core, Vue / Svelte / Solid bindings are the same few
// lines against their own external-store primitive.
//
// - `useStitch`       — the unary request/response hook.
// - `useStitchStream` — the streaming hook: re-renders as `delta` chunks arrive.
//                       This is the differentiator over plain request/response
//                       query libraries.
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (returns a plain POJO,
//                       so it needs no import of `@tanstack/react-query`; named with the
//                       `stitch` prefix because TanStack exports its own `queryOptions`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryState,
    createStitchQuery,
} from '@stitchapi/query-core';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { compact } from 'stitchapi';

export type {
    CreateStitchQueryOptions,
    QueryInput,
    QueryOutput,
    StitchLike,
    StitchQuery,
    StitchQueryState,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

/** What `useStitch` / `useStitchStream` return: the reactive state plus the
 * imperative `refetch` / `cancel` handles. */
export interface UseStitchResult<T> extends StitchQueryState<T> {
    /** Abort the in-flight run and re-run from scratch. */
    refetch: () => void;
    /** Abort the in-flight run, if any. */
    cancel: () => void;
}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

// `deps` lets the caller control when the query handle is re-created. By default
// we derive a stable identity from the stitch + a structural key of the input, so
// `{ id: 1 }` !== `{ id: 2 }` re-fetches but a re-render with an equal-shaped
// literal does not. A caller who keys differently passes explicit `deps`.
function defaultKey(input: unknown): string {
    try {
        return JSON.stringify(input ?? null);
    } catch {
        // Non-serialisable input (a function, a cyclic object) → opt out of
        // structural keying; the caller should pass explicit `deps`.
        return Math.random().toString(36);
    }
}

interface UseStitchOptions<T> extends CreateStitchQueryOptions<T> {
    /** Explicit re-create trigger. When provided, the handle is re-created only
     * when one of these changes (by `Object.is`), instead of the default
     * structural key of `input`. */
    deps?: readonly unknown[];
}

function useStitchInternal<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: UseStitchOptions<T> & { stream: boolean },
): UseStitchResult<T> {
    const { deps, stream, mode, enabled, onSuccess, onError } = options;

    // Keep the latest callbacks in a ref so changing them does not re-create the
    // handle (and so the store never holds a stale closure).
    const cbRef = useRef<{
        onSuccess?: (d: T) => void;
        onError?: (e: unknown) => void;
    }>({});
    cbRef.current = {
        ...(onSuccess ? { onSuccess } : {}),
        ...(onError ? { onError } : {}),
    };

    // Hold the latest `stitch` in a ref. A caller who passes an INLINE stitch
    // (`useStitch(() => stitch(...), ...)`) hands us a fresh function identity on
    // every render — that must NOT re-create the handle (it would loop: a new run
    // notifies, which re-renders, which makes another stitch). The store always
    // calls through this stable wrapper, so the live function is used without its
    // identity entering the dep key.
    const stitchRef = useRef(stitch);
    stitchRef.current = stitch;
    const stableStitch = useRef<StitchLike<T, unknown>>((input?: unknown) =>
        stitchRef.current(input),
    ).current;

    // The dependency list that triggers a fresh handle (and re-fetch). Default: a
    // structural key of the input + the stitch's stable `__config.name` (NOT its
    // function identity) + the streaming flags. Pass `options.deps` to override.
    const name = (stitch as { __config?: { name?: string } }).__config?.name;
    const depKey = deps
        ? deps
        : [name ?? '', defaultKey(input), stream, mode, enabled];

    const query: StitchQuery<T> = useMemo(
        () =>
            createStitchQuery<T, unknown>(
                stableStitch,
                input,
                compact({
                    stream,
                    ...(mode ? { mode } : {}),
                    enabled,
                    onSuccess: (d: T) => cbRef.current.onSuccess?.(d),
                    onError: (e: unknown) => cbRef.current.onError?.(e),
                }),
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        depKey,
    );

    // Destroy the previous handle when a new one supersedes it, and on unmount.
    useEffect(() => () => query.destroy(), [query]);

    const subscribe = useCallback(
        (listener: () => void) => query.subscribe(listener),
        [query],
    );
    const getSnapshot = useCallback(() => query.getSnapshot(), [query]);

    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const refetch = useCallback(() => query.refetch(), [query]);
    const cancel = useCallback(() => query.cancel(), [query]);

    return useMemo(
        () => ({ ...state, refetch, cancel }),
        [state, refetch, cancel],
    );
}

// ---------------------------------------------------------------------------
// useStitch — unary
// ---------------------------------------------------------------------------

/**
 * Run a stitch as a request/response query and re-render on its transitions.
 *
 * The query handle is re-created (and re-fetched) when a structural key of
 * `input` (or the stitch's `__config.name`) changes; pass `options.deps` to
 * control that explicitly. An inline stitch is safe — its function identity does
 * NOT trigger a re-create. The in-flight run is aborted on unmount.
 *
 * @example
 * ```tsx
 * const { data, isPending, isError, refetch } = useStitch(getUser, { params: { id } });
 * if (isPending) return <Spinner />;
 * if (isError) return <Error onRetry={refetch} />;
 * return <Profile user={data} />;
 * ```
 */
export function useStitch<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: UseStitchOptions<QueryOutput<S>>,
): UseStitchResult<QueryOutput<S>>;
export function useStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: UseStitchOptions<T>,
): UseStitchResult<T>;
export function useStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: UseStitchOptions<T> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, { ...options, stream: false });
}

// ---------------------------------------------------------------------------
// useStitchStream — streaming
// ---------------------------------------------------------------------------

/**
 * Run a streaming stitch (an `sse` / `stream` surface) and re-render as each
 * `delta` chunk arrives. Same result shape as {@link useStitch}; `data` is the
 * accumulated chunks (`mode: 'append'`, default) or the latest chunk
 * (`mode: 'replace'`), and `chunks` is the running list. `status` is
 * `'streaming'` until the terminal `result`, then `'success'`.
 *
 * @example
 * ```tsx
 * const { chunks, isStreaming } = useStitchStream(chat, { body: { prompt } });
 * return <Tokens chunks={chunks} live={isStreaming} />;
 * ```
 */
export function useStitchStream<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: UseStitchOptions<QueryOutput<S>>,
): UseStitchResult<QueryOutput<S>>;
export function useStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: UseStitchOptions<T>,
): UseStitchResult<T>;
export function useStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: UseStitchOptions<T> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, { ...options, stream: true });
}

// ---------------------------------------------------------------------------
// stitchQueryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

/** The plain object {@link stitchQueryOptions} returns — structurally compatible with
 * TanStack Query's `useQuery(options)` without importing the library. */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on `@tanstack/react-query` — it just returns a POJO. Pass it
 * straight to `useQuery`:
 *
 * ```tsx
 * import { useQuery } from '@tanstack/react-query';
 * import { stitchQueryOptions } from '@stitchapi/react';
 *
 * const { data } = useQuery(stitchQueryOptions(getUser, { params: { id } }));
 * ```
 *
 * The `queryFn` awaits the stitch (the validated output); the `queryKey` is the
 * stitch's `name` (when present) plus the input, so TanStack caches per call.
 *
 * Named `stitchQueryOptions` (not a bare `queryOptions`) because TanStack Query
 * itself exports a `queryOptions` — the bare name would clash on import. See
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md).
 */
export function stitchQueryOptions<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
): StitchQueryOptions<QueryOutput<S>>;
export function stitchQueryOptions<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
): StitchQueryOptions<T>;
export function stitchQueryOptions<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
): StitchQueryOptions<T> {
    const name = (stitch as { __config?: { name?: string } }).__config?.name;
    return {
        queryKey: [name ?? 'stitch', input ?? null],
        queryFn: () => Promise.resolve(stitch(input)),
    };
}

/**
 * @deprecated Renamed to {@link stitchQueryOptions} — a bare `queryOptions` collides
 * with TanStack Query's own `queryOptions` export when both are imported. See
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the
 * `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export const queryOptions = stitchQueryOptions;
