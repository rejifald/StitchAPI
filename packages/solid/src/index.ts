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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (returns a plain
//                          POJO, so it needs no import of `@tanstack/solid-query`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryResult,
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
    StitchQueryOptions,
    StitchQueryResult,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Primitive result
// ---------------------------------------------------------------------------

/** What `createStitch` / `createStitchStream` return: the reactive store (a Solid
 * proxy, so reading `store.data` inside an effect/JSX tracks it) plus the
 * imperative `refetch` / `cancel` handles. */
export interface SolidStitchStore<T> {
    /** The reactive state — a Solid store proxy. Read fields inside tracking
     * scopes (effects, JSX) to re-run on change. */
    readonly state: StitchQueryResult<T>;
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

/**
 * Options accepted by {@link createStitch} / {@link createStitchStream}.
 *
 * The store's `streaming` flag is deliberately OMITTED: each primitive hard-sets it
 * (`createStitch` → unary, `createStitchStream` → streaming), so passing it would be
 * silently ignored — the type forbids it instead. Matches react/vue/angular (CONTRACT.md P16).
 */
export interface CreateStitchOptions<T> extends Omit<
    CreateStitchQueryOptions<T>,
    'streaming'
> {}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

// The store's seed value, read before the effect mirrors the first real snapshot
// (the effect is non-deferred, so this is only ever visible for an instant). It
// matches core's idle snapshot exactly so `state` is well-formed from the start.
const IDLE_STATE: StitchQueryResult<unknown> = {
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
    stitch: StitchLike<T>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>>,
    streaming: boolean,
): SolidStitchStore<T> {
    // The Solid store we reconcile from the core query's snapshots. `reconcile`
    // does a structural diff so only the fields that actually changed notify
    // their dependents (mirrors core's identity-stable snapshots, fine-grained).
    const [state, setState] = createStore<StitchQueryResult<T>>(
        IDLE_STATE as StitchQueryResult<T>,
    );

    // Hold the latest `stitch` in a ref-like closure. A caller who passes an
    // INLINE stitch hands a fresh function identity, which must NOT recreate the
    // handle; the store always calls through this stable wrapper.
    let liveStitch = stitch;
    const stableStitch: StitchLike<T> = (arg?: unknown) => liveStitch(arg);

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
                const handle = createStitchQuery<T>(
                    stableStitch,
                    currentInput,
                    compact({
                        streaming,
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
): SolidStitchStore<QueryOutput<S>>;
export function createStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeAccessor<Input>,
    options?: MaybeAccessor<CreateStitchOptions<T>>,
): SolidStitchStore<T>;
export function createStitch<T>(
    stitch: StitchLike<T>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>> = {},
): SolidStitchStore<T> {
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
): SolidStitchStore<QueryOutput<S>>;
export function createStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeAccessor<Input>,
    options?: MaybeAccessor<CreateStitchOptions<T>>,
): SolidStitchStore<T>;
export function createStitchStream<T>(
    stitch: StitchLike<T>,
    input: MaybeAccessor<unknown>,
    options: MaybeAccessor<CreateStitchOptions<T>> = {},
): SolidStitchStore<T> {
    return createStitchInternal<T>(stitch, input, options, true);
}

// ---------------------------------------------------------------------------
// stitchQueryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// The single implementation lives in `@stitchapi/query-core` (already a runtime
// peer of this package): `stitchQueryOptions(stitch, input)` returns the plain
// `{ queryKey, queryFn }` POJO that `@tanstack/solid-query`'s
// `createQuery(options)` consumes — no import of TanStack itself. The key is
// `stitchKey.of`'s stable, secret-redacted derivation, shared verbatim across
// every framework binding (CONTRACT.md P9). Named `stitchQueryOptions` (not a
// bare `queryOptions`) because TanStack Query exports its own `queryOptions` —
// see ADR 0012, which is also why the key grammar is `stitchKey` and not a bare
// `queryKey`.
// Need the key alone (e.g. for TanStack invalidation)? Import `stitchKey` from
// `@stitchapi/query-core` — it is already an installed peer.
//
// This barrel deliberately stops at the adapter where React / Vue / Svelte /
// Angular also re-export `stitchKey`. That divergence PREDATES the key fold and
// is left standing here: those four say "import everything from the binding",
// this one says "the peer is already installed, import from it", and both are
// written as if principled. Picking one is an additive change to a public
// surface and a separate call from folding three names into one — see the
// CHANGELOG entry for the fold.
export { stitchQueryOptions } from '@stitchapi/query-core';
