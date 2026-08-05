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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter, re-exported from
//                       `@stitchapi/query-core` (returns a plain POJO, so it needs
//                       no import of `@tanstack/react-query`; named with the
//                       `stitch` prefix because TanStack exports its own
//                       `queryOptions`, see ADR 0012).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryResult,
    createStitchQuery,
    keyInputFor,
    nameOf,
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
    StitchQueryOptions,
    StitchQueryResult,
} from '@stitchapi/query-core';

// The TanStack Query adapter and its key derivation live in
// `@stitchapi/query-core` — ONE shared implementation across every framework
// binding, so the key format (and its secret-redaction guarantees) cannot drift
// between frameworks. Re-exported here so React apps import everything from
// `@stitchapi/react`.
export {
    deriveQueryKey,
    keyInputFor,
    nameOf,
    stitchQueryOptions,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Hook options & result
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link useStitch} / {@link useStitchStream}.
 *
 * The store's `streaming` flag is deliberately OMITTED: each hook hard-sets it
 * (`useStitch` → unary, `useStitchStream` → streaming), so passing it would be
 * silently ignored — the type forbids it instead.
 */
export interface UseStitchOptions<T> extends Omit<
    CreateStitchQueryOptions<T>,
    'streaming'
> {
    /** Explicit re-create trigger. When provided, the handle is re-created only
     * when one of these changes (by `Object.is`), instead of the default
     * structural key of `input`. */
    deps?: readonly unknown[];
}

/** What `useStitch` / `useStitchStream` return: the reactive state plus the
 * imperative `refetch` / `cancel` handles. */
export interface UseStitchResult<T> extends StitchQueryResult<T> {
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
        // Sanitise first (via query-core's `keyInputFor`): an inline `onProgress`
        // (fresh identity per render) would otherwise churn the structural key
        // and loop; a per-call `signal` would add non-deterministic noise. Both
        // are runtime-only, so they are dropped.
        return JSON.stringify(keyInputFor(input));
    } catch {
        // Non-serialisable input (a function, a cyclic object) → opt out of
        // structural keying; the caller should pass explicit `deps`.
        return Math.random().toString(36);
    }
}

function useStitchInternal<T>(
    stitch: StitchLike<T>,
    input: unknown,
    options: UseStitchOptions<T> & { streaming: boolean },
): UseStitchResult<T> {
    const { deps, streaming, mode, enabled, onSuccess, onError } = options;

    // Keep the latest callbacks in a ref so changing them does not re-create the
    // handle (and so the store never holds a stale closure).
    const cbRef = useRef<{
        onSuccess?: (d: T) => void;
        onError?: (e: unknown) => void;
    }>({});
    cbRef.current = compact({ onSuccess, onError });

    // Hold the latest `stitch` in a ref. A caller who passes an INLINE stitch
    // (`useStitch(() => stitch(...), ...)`) hands us a fresh function identity on
    // every render — that must NOT re-create the handle (it would loop: a new run
    // notifies, which re-renders, which makes another stitch). The store always
    // calls through this stable wrapper, so the live function is used without its
    // identity entering the dep key.
    const stitchRef = useRef(stitch);
    stitchRef.current = stitch;
    const stableStitch = useRef<StitchLike<T>>((input?: unknown) =>
        stitchRef.current(input),
    ).current;

    // The dependency list that triggers a fresh handle (and re-fetch). Default: a
    // structural key of the input + a stable name for the stitch (NOT its function
    // identity; via query-core's `nameOf`, so two nameless stitches on different
    // paths don't share a dep key) + the streaming flags. Pass `options.deps` to
    // override.
    const depKey = deps
        ? deps
        : [nameOf(stitch), defaultKey(input), streaming, mode, enabled];

    const query: StitchQuery<T> = useMemo(
        () =>
            createStitchQuery<T>(
                stableStitch,
                input,
                compact({
                    streaming,
                    mode,
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
    stitch: StitchLike<T>,
    input: unknown,
    options: UseStitchOptions<T> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, {
        ...options,
        streaming: false,
    });
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
    stitch: StitchLike<T>,
    input: unknown,
    options: UseStitchOptions<T> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, { ...options, streaming: true });
}
