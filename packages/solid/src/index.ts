// @stitchapi/solid — Solid bindings for StitchAPI.
//
// These primitives are a THIN layer over `@stitchapi/query-core`: that package
// owns the reactive store (subscribe / getSnapshot / refetch / cancel), and Solid
// mirrors it into a `createStore` reconciled on each notification. Because all the
// behaviour lives in the framework-agnostic core, the React / Vue / Svelte / Solid
// bindings are the same few lines against their own reactive primitive.
//
// - `createStitch`       — the unary request/response primitive.
// - `createStitchStream` — the streaming primitive: re-renders as `delta` chunks
//                          arrive. This is the differentiator over plain
//                          request/response query libraries.
// - `queryOptions`       — an OPTIONAL TanStack Query adapter (returns a plain
//                          POJO, so it needs no import of `@tanstack/solid-query`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryState,
    createStitchQuery,
} from '@stitchapi/query-core';
import { createEffect, on, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
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
// Primitive result
// ---------------------------------------------------------------------------

/** What `createStitch` / `createStitchStream` return: the reactive store (a Solid
 * proxy, so reading `store.data` inside an effect/JSX tracks it) plus the
 * imperative `refetch` / `cancel` handles. */
export interface StitchStore<T> {
    /** The reactive state — a Solid store proxy. Read fields inside tracking
     * scopes (effects, JSX) to re-run on change. */
    readonly state: StitchQueryState<T>;
    /** Abort the in-flight run and re-run from scratch. */
    refetch: () => void;
    /** Abort the in-flight run, if any. */
    cancel: () => void;
}

// ---------------------------------------------------------------------------
// Reactive inputs
// ---------------------------------------------------------------------------

/** A value or a zero-arg accessor of it — Solid's idiom for "static or reactive".
 * Passing an accessor (a signal getter, or `() => props.x`) lets the primitive
 * recreate the handle when the value changes; a plain value is read once. */
export type MaybeAccessor<T> = T | (() => T);

function access<T>(value: MaybeAccessor<T>): T {
    return typeof value === 'function' ? (value as () => T)() : value;
}

export interface CreateStitchOptions<T> extends CreateStitchQueryOptions<T> {}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

// The store's seed value, read before the effect mirrors the first real snapshot
// (the effect is non-deferred, so this is only ever visible for an instant). It
// matches core's idle snapshot exactly so `state` is well-formed from the start.
const IDLE_STATE: StitchQueryState<unknown> = {
    status: 'idle',
    data: undefined,
    error: undefined,
    chunks: [],
    isPending: false,
    isError: false,
    isSuccess: false,
    isStreaming: false,
};

function createStitchInternal<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>>,
    stream: boolean,
): StitchStore<T> {
    // The Solid store we reconcile from the core query's snapshots. `reconcile`
    // does a structural diff so only the fields that actually changed notify
    // their dependents (mirrors core's identity-stable snapshots, fine-grained).
    const [state, setState] = createStore<StitchQueryState<T>>(
        IDLE_STATE as StitchQueryState<T>,
    );

    // Hold the latest `stitch` in a ref-like closure. A caller who passes an
    // INLINE stitch hands a fresh function identity, which must NOT recreate the
    // handle; the store always calls through this stable wrapper.
    let liveStitch = stitch;
    const stableStitch: StitchLike<T, unknown> = (arg?: unknown) =>
        liveStitch(arg);

    // The live query handle — reassigned by the effect on input/option changes.
    let query: StitchQuery<T> | undefined;

    // Recreate the handle whenever the tracked input / options change. `on`
    // makes the dependencies explicit (and `defer: false` runs it immediately),
    // so an inline stitch identity never enters the trigger.
    createEffect(
        on(
            () => [access(input), access(options)] as const,
            ([currentInput, currentOptions]) => {
                liveStitch = stitch;
                // Tear down the superseded handle before standing up the new one.
                query?.destroy();

                const { mode, enabled, onSuccess, onError } = currentOptions;
                const handle = createStitchQuery<T, unknown>(
                    stableStitch,
                    currentInput,
                    compact({
                        stream,
                        mode,
                        enabled,
                        onSuccess,
                        onError,
                    }),
                );
                query = handle;

                // Mirror the snapshot into the store, then on every transition.
                // `reconcile` keeps the proxy identity stable and only patches the
                // changed fields.
                setState(reconcile(handle.getSnapshot()));
                const off = handle.subscribe(() => {
                    setState(reconcile(handle.getSnapshot()));
                });

                // Drop the listener (and the handle) when this effect re-runs or
                // the owning scope is disposed.
                onCleanup(() => {
                    off();
                    handle.destroy();
                });
            },
        ),
    );

    return {
        state,
        refetch: () => query?.refetch(),
        cancel: () => query?.cancel(),
    };
}

// ---------------------------------------------------------------------------
// createStitch — unary
// ---------------------------------------------------------------------------

/**
 * Run a stitch as a request/response query and reconcile its transitions into a
 * Solid store. Read `store.state.data` / `store.state.isPending` inside JSX or an
 * effect to re-render on change.
 *
 * `input` and `options` may be plain values (read once) or accessors (`() =>
 * props.id`, a signal getter) — when an accessor's value changes the query handle
 * is recreated and re-fetched. An inline stitch is safe: its function identity
 * does NOT trigger a recreate. The in-flight run is aborted on scope teardown.
 *
 * @example
 * ```tsx
 * const user = createStitch(getUser, () => ({ params: { id: id() } }));
 * return (
 *   <Show when={!user.state.isPending} fallback={<Spinner />}>
 *     {user.state.isError ? <Retry onClick={user.refetch} /> : <Profile data={user.state.data} />}
 *   </Show>
 * );
 * ```
 */
export function createStitch<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: MaybeAccessor<QueryInput<S>>,
    options?: MaybeAccessor<CreateStitchOptions<QueryOutput<S>>>,
): StitchStore<QueryOutput<S>>;
export function createStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeAccessor<Input>,
    options?: MaybeAccessor<CreateStitchOptions<T>>,
): StitchStore<T>;
export function createStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>> = {},
): StitchStore<T> {
    return createStitchInternal<T>(stitch, input, options, false);
}

// ---------------------------------------------------------------------------
// createStitchStream — streaming
// ---------------------------------------------------------------------------

/**
 * Run a streaming stitch (an `sse` / `stream` surface) and reconcile each `delta`
 * chunk into the Solid store as it arrives. Same store shape as {@link
 * createStitch}; `state.data` is the accumulated chunks (`mode: 'append'`,
 * default) or the latest chunk (`mode: 'replace'`), and `state.chunks` is the
 * running list. `state.status` is `'streaming'` until the terminal `result`, then
 * `'success'`.
 *
 * @example
 * ```tsx
 * const chat = createStitchStream(stream, () => ({ body: { prompt: prompt() } }));
 * return <Tokens chunks={chat.state.chunks} live={chat.state.isStreaming} />;
 * ```
 */
export function createStitchStream<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: MaybeAccessor<QueryInput<S>>,
    options?: MaybeAccessor<CreateStitchOptions<QueryOutput<S>>>,
): StitchStore<QueryOutput<S>>;
export function createStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeAccessor<Input>,
    options?: MaybeAccessor<CreateStitchOptions<T>>,
): StitchStore<T>;
export function createStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>> = {},
): StitchStore<T> {
    return createStitchInternal<T>(stitch, input, options, true);
}

// ---------------------------------------------------------------------------
// queryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to `@stitchapi/react`'s `queryOptions` (no framework import) — the
// POJO shape `@tanstack/solid-query`'s `createQuery(options)` consumes is the same
// `{ queryKey, queryFn }` TanStack uses everywhere.

/** The plain object {@link queryOptions} returns — structurally compatible with
 * TanStack Query's `createQuery(options)` without importing the library. */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on `@tanstack/solid-query` — it just returns a POJO. Pass it straight
 * to `createQuery`:
 *
 * ```tsx
 * import { createQuery } from '@tanstack/solid-query';
 * import { queryOptions } from '@stitchapi/solid';
 *
 * const query = createQuery(() => queryOptions(getUser, { params: { id: id() } }));
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
