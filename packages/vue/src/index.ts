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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (a plain POJO, so
//                       it needs no import of `@tanstack/vue-query`). Implemented
//                       once in `@stitchapi/query-core` and re-exported here.
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
import { compact } from 'stitchapi';
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
    StitchQueryOptions,
    StitchQueryResult,
} from '@stitchapi/query-core';

// The TanStack Query adapter is implemented once in `@stitchapi/query-core`
// (`deriveQueryKey` + `stitchQueryOptions`) so a stitch keys identically in every
// framework binding. Re-exported here so Vue apps import from one place.
export {
    deriveQueryKey,
    keyInputFor,
    nameOf,
    stitchQueryOptions,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Composable result
// ---------------------------------------------------------------------------

/**
 * What `useStitch` / `useStitchStream` return: each reactive state field as its
 * own `ComputedRef` (so the object stays destructurable WITHOUT losing
 * reactivity, the Vue idiom) plus the imperative `refetch` / `cancel` handles.
 */
export interface UseStitchResult<T> {
    readonly status: ComputedRef<StitchQueryResult<T>['status']>;
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
// Composable options
// ---------------------------------------------------------------------------

/**
 * Options for {@link useStitch} / {@link useStitchStream}: the query-core
 * options minus `streaming` — which composable you call decides that
 * (`useStitch` is unary, `useStitchStream` streams).
 */
export interface UseStitchOptions<T> extends Omit<
    CreateStitchQueryOptions<T>,
    'streaming'
> {}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

// A structural key of the input so an equal-shaped literal does not re-create the
// handle, but `{ id: 1 }` → `{ id: 2 }` does. Mirrors `@stitchapi/react`. Sanitises
// first via query-core's `keyInputFor` so an inline `onProgress` (fresh identity
// per render) can't churn the key and loop, and a per-call `signal` adds no
// non-deterministic noise — both are runtime-only.
function defaultKey(input: unknown): string {
    try {
        return JSON.stringify(keyInputFor(input));
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
    streaming: boolean,
): UseStitchResult<T> {
    // The single reactive cell every consumer reads through. The core hands out a
    // NEW frozen snapshot only on a real change, so swapping the ref is cheap and
    // never tears. `shallowRef` is deliberate: the snapshot is already immutable,
    // so deep reactivity would only add overhead.
    const snapshot = shallowRef<StitchQueryResult<T>>(
        // Seed with a synchronous read below once the first handle exists; this
        // placeholder is replaced before any consumer can observe it.
        undefined as unknown as StitchQueryResult<T>,
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
        query = createStitchQuery<T, unknown>(
            stitch,
            resolvedInput,
            compact({
                streaming,
                mode: opts.mode,
                enabled: opts.enabled,
                onSuccess: opts.onSuccess,
                onError: opts.onError,
            }),
        );

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
    // the streaming-relevant options change. A stable name for the stitch (via
    // `nameOf`, NOT the raw `name` — so two nameless stitches on different paths
    // don't share a dep key) joins the key so two stitches with the same input
    // still differ.
    const name = nameOf(stitch);
    const depKey = (): string => {
        const opts = toValue(options);
        return JSON.stringify([
            name,
            defaultKey(toValue(input)),
            streaming,
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

    const field = <K extends keyof StitchQueryResult<T>>(
        k: K,
    ): ComputedRef<StitchQueryResult<T>[K]> =>
        computed(() => snapshot.value[k]);

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
): UseStitchResult<QueryOutput<S>>;
export function useStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeRefOrGetter<Input>,
    options?: MaybeRefOrGetter<UseStitchOptions<T>>,
): UseStitchResult<T>;
export function useStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeRefOrGetter<unknown>,
    options: MaybeRefOrGetter<UseStitchOptions<T>> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, options, false);
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
): UseStitchResult<QueryOutput<S>>;
export function useStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeRefOrGetter<Input>,
    options?: MaybeRefOrGetter<UseStitchOptions<T>>,
): UseStitchResult<T>;
export function useStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeRefOrGetter<unknown>,
    options: MaybeRefOrGetter<UseStitchOptions<T>> = {},
): UseStitchResult<T> {
    return useStitchInternal<T>(stitch, input, options, true);
}
