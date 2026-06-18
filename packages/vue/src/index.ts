// @stitchapi/vue — Vue 3 bindings for StitchAPI.
//
// These composables are a THIN layer over `@stitchapi/query-core`: that package
// owns the reactive store (subscribe / getSnapshot / refetch / cancel), and Vue's
// reactivity reads it through a single `shallowRef` holding the immutable
// snapshot. Because all the behaviour lives in the framework-agnostic core, the
// React / Svelte / Solid bindings are the same few lines against their own
// reactive primitive.
//
// - `useStitch`       — the unary request/response composable.
// - `useStitchStream` — the streaming composable: re-renders as `delta` chunks
//                       arrive. This is the differentiator over plain
//                       request/response query libraries.
// - `queryOptions`    — an OPTIONAL TanStack Query adapter (returns a plain POJO,
//                       so it needs no import of `@tanstack/vue-query`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryState,
    createStitchQuery,
} from '@stitchapi/query-core';
import {
    type ComputedRef,
    type MaybeRefOrGetter,
    computed,
    onScopeDispose,
    shallowRef,
    toValue,
    watch,
} from 'vue';

export type {
    CreateStitchQueryOptions,
    QueryInput,
    QueryOutput,
    StitchLike,
    StitchQuery,
    StitchQueryState,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Composable result
// ---------------------------------------------------------------------------

/**
 * What `useStitch` / `useStitchStream` return: each reactive state field as its
 * own `ComputedRef` (so the object stays destructurable WITHOUT losing
 * reactivity, the Vue idiom) plus the imperative `refetch` / `cancel` handles.
 */
export interface UseStitchReturn<T> {
    readonly status: ComputedRef<StitchQueryState<T>['status']>;
    /** The validated output (unary) or the latest streamed value (streaming). */
    readonly data: ComputedRef<T | undefined>;
    /** The thrown reason on failure. */
    readonly error: ComputedRef<unknown>;
    /** Accumulated `delta` chunks, in arrival order. */
    readonly chunks: ComputedRef<readonly unknown[]>;
    readonly isPending: ComputedRef<boolean>;
    readonly isError: ComputedRef<boolean>;
    readonly isSuccess: ComputedRef<boolean>;
    readonly isStreaming: ComputedRef<boolean>;
    /** Abort the in-flight run and re-run from scratch. */
    refetch: () => void;
    /** Abort the in-flight run, if any. */
    cancel: () => void;
}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

interface UseStitchOptions<T> extends CreateStitchQueryOptions<T> {}

// A structural key of the input so an equal-shaped literal does not re-create the
// handle, but `{ id: 1 }` → `{ id: 2 }` does. Mirrors `@stitchapi/react`.
function defaultKey(input: unknown): string {
    try {
        return JSON.stringify(input ?? null);
    } catch {
        // Non-serialisable input (a function, a cyclic object) → opt out of
        // structural keying; falling back to a fresh key re-creates each time.
        return Math.random().toString(36);
    }
}

// `input` and `options` may be passed as plain values, refs, or getters so a
// composable in a `<script setup>` re-runs the call when they change. `toValue`
// unwraps all three.
function useStitchInternal<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeRefOrGetter<unknown>,
    options: MaybeRefOrGetter<UseStitchOptions<T>>,
    stream: boolean,
): UseStitchReturn<T> {
    // The single reactive cell every consumer reads through. The core hands out a
    // NEW frozen snapshot only on a real change, so swapping the ref is cheap and
    // never tears. `shallowRef` is deliberate: the snapshot is already immutable,
    // so deep reactivity would only add overhead.
    const snapshot = shallowRef<StitchQueryState<T>>(
        // Seed with a synchronous read below once the first handle exists; this
        // placeholder is replaced before any consumer can observe it.
        undefined as unknown as StitchQueryState<T>,
    );

    let query: StitchQuery<T> | undefined;
    let unsubscribe: (() => void) | undefined;

    // (Re)build the handle for the current input/options. Tears down the previous
    // one first so a superseded run can't keep publishing.
    function build(): void {
        unsubscribe?.();
        query?.destroy();

        const opts = toValue(options);
        const resolvedInput = toValue(input);
        query = createStitchQuery<T, unknown>(stitch, resolvedInput, {
            stream,
            ...(opts.mode ? { mode: opts.mode } : {}),
            ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
            ...(opts.onSuccess ? { onSuccess: opts.onSuccess } : {}),
            ...(opts.onError ? { onError: opts.onError } : {}),
        });

        // Seed synchronously (the store may already be `pending`), then track.
        snapshot.value = query.getSnapshot();
        unsubscribe = query.subscribe(() => {
            // `query` is non-null here — the listener can only fire while the
            // handle that registered it is live.
            snapshot.value = query!.getSnapshot();
        });
    }

    build();

    // Re-create the handle (and re-fetch) when a structural key of the input or
    // the streaming-relevant options change. The stitch's stable `__config.name`
    // joins the key so two stitches with the same input still differ.
    const name = (stitch as { __config?: { name?: string } }).__config?.name;
    const depKey = (): string => {
        const opts = toValue(options);
        return JSON.stringify([
            name ?? '',
            defaultKey(toValue(input)),
            stream,
            opts.mode ?? null,
            opts.enabled ?? null,
        ]);
    };
    watch(depKey, () => build());

    // Drop listeners and abort the run when the owning scope (component / manual
    // `effectScope`) is disposed.
    onScopeDispose(() => {
        unsubscribe?.();
        query?.destroy();
    });

    const field = <K extends keyof StitchQueryState<T>>(
        k: K,
    ): ComputedRef<StitchQueryState<T>[K]> => computed(() => snapshot.value[k]);

    return {
        status: field('status'),
        data: field('data'),
        error: field('error'),
        chunks: field('chunks'),
        isPending: field('isPending'),
        isError: field('isError'),
        isSuccess: field('isSuccess'),
        isStreaming: field('isStreaming'),
        refetch: () => query?.refetch(),
        cancel: () => query?.cancel(),
    };
}

// ---------------------------------------------------------------------------
// useStitch — unary
// ---------------------------------------------------------------------------

/**
 * Run a stitch as a request/response query and re-render on its transitions.
 *
 * `input` and `options` accept a plain value, a `ref`, or a getter — change any
 * of them and the query is re-created (and re-fetched) when a structural key
 * shifts. The in-flight run is aborted when the scope is disposed.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * const { data, isPending, isError, refetch } = useStitch(getUser, () => ({
 *     params: { id: props.id },
 * }));
 * </script>
 *
 * <template>
 *   <Spinner v-if="isPending" />
 *   <Error v-else-if="isError" @retry="refetch" />
 *   <Profile v-else :user="data" />
 * </template>
 * ```
 */
export function useStitch<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: MaybeRefOrGetter<QueryInput<S>>,
    options?: MaybeRefOrGetter<UseStitchOptions<QueryOutput<S>>>,
): UseStitchReturn<QueryOutput<S>>;
export function useStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeRefOrGetter<Input>,
    options?: MaybeRefOrGetter<UseStitchOptions<T>>,
): UseStitchReturn<T>;
export function useStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeRefOrGetter<unknown>,
    options: MaybeRefOrGetter<UseStitchOptions<T>> = {},
): UseStitchReturn<T> {
    return useStitchInternal<T>(stitch, input, options, false);
}

// ---------------------------------------------------------------------------
// useStitchStream — streaming
// ---------------------------------------------------------------------------

/**
 * Run a streaming stitch (an `sse` / `stream` surface) and re-render as each
 * `delta` chunk arrives. Same return shape as {@link useStitch}; `data` is the
 * accumulated chunks (`mode: 'append'`, default) or the latest chunk
 * (`mode: 'replace'`), and `chunks` is the running list. `status` is
 * `'streaming'` until the terminal `result`, then `'success'`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * const { chunks, isStreaming } = useStitchStream(chat, () => ({
 *     body: { prompt: props.prompt },
 * }));
 * </script>
 * ```
 */
export function useStitchStream<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: MaybeRefOrGetter<QueryInput<S>>,
    options?: MaybeRefOrGetter<UseStitchOptions<QueryOutput<S>>>,
): UseStitchReturn<QueryOutput<S>>;
export function useStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeRefOrGetter<Input>,
    options?: MaybeRefOrGetter<UseStitchOptions<T>>,
): UseStitchReturn<T>;
export function useStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeRefOrGetter<unknown>,
    options: MaybeRefOrGetter<UseStitchOptions<T>> = {},
): UseStitchReturn<T> {
    return useStitchInternal<T>(stitch, input, options, true);
}

// ---------------------------------------------------------------------------
// queryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to `@stitchapi/react`'s `queryOptions` — a plain POJO with no
// framework import, so it feeds `@tanstack/vue-query`'s `useQuery(options)`
// (or any other) just the same.

/** The plain object {@link queryOptions} returns — structurally compatible with
 * TanStack Query's `useQuery(options)` without importing the library. */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on `@tanstack/vue-query` — it just returns a POJO. Pass it straight
 * to `useQuery`:
 *
 * ```ts
 * import { useQuery } from '@tanstack/vue-query';
 * import { queryOptions } from '@stitchapi/vue';
 *
 * const { data } = useQuery(queryOptions(getUser, { params: { id } }));
 * ```
 *
 * The `queryFn` awaits the stitch (the validated output); the `queryKey` is the
 * stitch's `name` (when present) plus the input, so TanStack caches per call.
 */
export function queryOptions<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
): StitchQueryOptions<QueryOutput<S>>;
export function queryOptions<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
): StitchQueryOptions<T>;
export function queryOptions<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
): StitchQueryOptions<T> {
    const name = (stitch as { __config?: { name?: string } }).__config?.name;
    return {
        queryKey: [name ?? 'stitch', input ?? null],
        queryFn: () => Promise.resolve(stitch(input)),
    };
}
