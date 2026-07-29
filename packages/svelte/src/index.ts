// @stitchapi/svelte — Svelte bindings for StitchAPI.
//
// These stores are a THIN layer over `@stitchapi/query-core`: that package owns
// the reactive lifecycle (subscribe / getSnapshot / refetch / cancel), and
// Svelte's `readable` adapts it to the `{ subscribe }` store contract — which is
// what `$store` auto-subscription and `<script>` reactivity read. Because all the
// behaviour lives in the framework-agnostic core, this binding is a few lines.
//
// `readable` is the safest cross-version surface: it is unchanged between Svelte 4
// and Svelte 5 (runes are additive), so one store works on both.
//
// - `stitchStore`       — the unary request/response store.
// - `stitchStreamStore` — the streaming store: emits a new state as each `delta`
//                         chunk arrives. The differentiator over plain
//                         request/response query libraries.
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (returns a plain
//                         POJO, so it needs no import of `@tanstack/svelte-query`).
//                         Re-exported verbatim from `@stitchapi/query-core`, the
//                         single shared implementation, so a stitch keys
//                         identically no matter which framework binding built it.
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryResult,
    createStitchQuery,
} from '@stitchapi/query-core';
import { type Readable, readable } from 'svelte/store';

export type {
    CreateStitchQueryOptions,
    QueryInput,
    QueryOutput,
    StitchLike,
    StitchQuery,
    StitchQueryOptions,
    StitchQueryResult,
} from '@stitchapi/query-core';

// The TanStack Query adapter is the ONE shared implementation in query-core
// (`deriveQueryKey` and its helpers included, for callers who key their own
// caches). Named `stitchQueryOptions` — not a bare `queryOptions` — because
// TanStack Query itself exports a `queryOptions` (ADR 0012).
export {
    deriveQueryKey,
    keyInputFor,
    nameOf,
    stitchQueryOptions,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

/**
 * A Svelte-readable view of a stitch query. It is a real `Readable<state>` (so
 * `$store` and `subscribe` work), with the imperative `refetch` / `cancel`
 * handles attached as methods. The underlying query is started lazily — on the
 * store's FIRST subscriber — and `destroy()`ed when the last unsubscribes, so an
 * unused store costs nothing and a torn-down scope aborts its run.
 */
export interface SvelteStitchStore<T> extends Readable<StitchQueryResult<T>> {
    /** Abort the in-flight run and re-run from scratch. */
    refetch: () => void;
    /** Abort the in-flight run, if any. */
    cancel: () => void;
}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

function makeStore<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: CreateStitchQueryOptions<T>,
): SvelteStitchStore<T> {
    // The query is created EAGERLY (so `getSnapshot` has a real handle to seed
    // the store and `refetch`/`cancel` work before the first subscriber), but its
    // run only starts when `enabled` says so, exactly like the core store. We
    // pass `enabled: false` to defer the actual fetch to first subscription, then
    // kick it off in `readable`'s start callback — so a store nobody subscribes to
    // never fires a request.
    const { enabled = true, ...rest } = options;
    const query: StitchQuery<T> = createStitchQuery<T, unknown>(stitch, input, {
        ...rest,
        enabled: false,
    });

    // `readable(initial, start)`: `start(set)` runs on the first subscriber and
    // returns a `stop` callback invoked when the last subscriber leaves. We seed
    // with the current snapshot, push every notification through `set`, fire the
    // deferred fetch, and tear the query down on stop.
    const store = readable<StitchQueryResult<T>>(query.getSnapshot(), (set) => {
        const unsubscribe = query.subscribe(() => set(query.getSnapshot()));
        // Sync once in case state advanced between creation and subscription,
        // then start the run if the caller didn't opt out.
        set(query.getSnapshot());
        if (enabled) query.refetch();
        return () => {
            unsubscribe();
            query.destroy();
        };
    });

    return {
        subscribe: store.subscribe,
        refetch: () => query.refetch(),
        cancel: () => query.cancel(),
    };
}

// ---------------------------------------------------------------------------
// stitchStore — unary
// ---------------------------------------------------------------------------

/**
 * Run a stitch as a request/response query, exposed as a Svelte store.
 *
 * The run starts on the store's first subscriber (so `$store` in a component
 * fetches when the component mounts) and is aborted when the last subscriber
 * leaves (component teardown). Call `refetch()` to re-run, `cancel()` to abort.
 * The returned value is a Svelte store — re-create it when `input`/`options`
 * change (e.g. derive it inside a `$:` block keyed on those) and let scope
 * teardown destroy it.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { stitchStore } from '@stitchapi/svelte';
 *   export let id: string;
 *   const user = stitchStore(getUser, { params: { id } });
 * </script>
 * {#if $user.isPending}<Spinner />
 * {:else if $user.isError}<Retry onclick={user.refetch} />
 * {:else}<h1>{$user.data?.name}</h1>{/if}
 * ```
 */
export function stitchStore<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: CreateStitchQueryOptions<QueryOutput<S>>,
): SvelteStitchStore<QueryOutput<S>>;
export function stitchStore<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: CreateStitchQueryOptions<T>,
): SvelteStitchStore<T>;
export function stitchStore<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: CreateStitchQueryOptions<T> = {},
): SvelteStitchStore<T> {
    return makeStore<T>(stitch, input, { ...options, streaming: false });
}

// ---------------------------------------------------------------------------
// stitchStreamStore — streaming
// ---------------------------------------------------------------------------

/**
 * Run a streaming stitch (an `sse` / `stream` surface) as a Svelte store, emitting
 * a new state as each `delta` chunk arrives. Same state shape as
 * {@link stitchStore}; `data` is the accumulated chunks (`mode: 'append'`,
 * default) or the latest chunk (`mode: 'replace'`), and `chunks` is the running
 * list. `status` is `'streaming'` until the terminal `result`, then `'success'`.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { stitchStreamStore } from '@stitchapi/svelte';
 *   const chat = stitchStreamStore(chatStitch, { body: { prompt } });
 * </script>
 * {#each $chat.chunks as c}<span>{c}</span>{/each}
 * {#if $chat.isStreaming}<Cursor />{/if}
 * ```
 */
export function stitchStreamStore<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: CreateStitchQueryOptions<QueryOutput<S>>,
): SvelteStitchStore<QueryOutput<S>>;
export function stitchStreamStore<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: CreateStitchQueryOptions<T>,
): SvelteStitchStore<T>;
export function stitchStreamStore<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options: CreateStitchQueryOptions<T> = {},
): SvelteStitchStore<T> {
    return makeStore<T>(stitch, input, { ...options, streaming: true });
}
