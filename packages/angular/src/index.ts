// @stitchapi/angular — Angular bindings for StitchAPI.
//
// These functions are a THIN layer over `@stitchapi/query-core`: that package
// owns the reactive store (subscribe / getSnapshot / refetch / cancel), and
// Angular consumes it as BOTH a signal and an RxJS observable, from one shared
// execution. Because all the behaviour lives in the framework-agnostic core, the
// React / Vue / Svelte / Solid bindings are the same few lines against their own
// reactive primitive.
//
// - `injectStitch`       — the unary request/response primitive.
// - `injectStitchStream` — the streaming primitive: emits as `delta` chunks
//                          arrive. This is the differentiator over plain
//                          request/response query libraries.
// - `queryOptions`       — an OPTIONAL TanStack Query adapter (returns a plain
//                          POJO, so it needs no import of the Angular adapter).
//
// The observable is the bridge off the store; the signal is derived from it via
// `toSignal`, so a single query feeds both. `state$` and the signals share one
// execution (multicast), and the run is torn down with the injection context.
import {
    DestroyRef,
    Injector,
    type Signal,
    assertInInjectionContext,
    computed,
    inject,
} from '@angular/core';
import {
    takeUntilDestroyed,
    toObservable,
    toSignal,
} from '@angular/core/rxjs-interop';
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryState,
    type StitchQueryStatus,
    createStitchQuery,
} from '@stitchapi/query-core';
import { Observable, of } from 'rxjs';
import { shareReplay, switchMap } from 'rxjs/operators';
import { compact } from 'stitchapi';

export type {
    CreateStitchQueryOptions,
    QueryInput,
    QueryOutput,
    StitchLike,
    StitchQuery,
    StitchQueryState,
    StitchQueryStatus,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A value, a `Signal` of it, or a zero-arg getter — Angular's idiom for "static
 * or reactive". Passing a signal/getter recreates the query (and re-fetches) when
 * the tracked value changes; a plain value is read once. */
export type InjectInput<T> = T | Signal<T> | (() => T);

export interface InjectStitchOptions<T> extends CreateStitchQueryOptions<T> {
    /** Injection context to use when `injectStitch` is called outside one (e.g. a
     * test, or a non-injection callback). Defaults to the ambient context. */
    injector?: Injector;
}

/** What `injectStitch` / `injectStitchStream` return: the reactive state exposed
 * BOTH as fine-grained signals AND as an RxJS observable (`state$`), from one
 * shared query execution, plus the imperative `refetch` / `cancel` handles. */
export interface InjectStitchResult<T> {
    /** The whole snapshot as a signal — read `state().data` etc. in a template or
     * `computed`. */
    readonly state: Signal<StitchQueryState<T>>;
    /** The validated output (unary) or the latest streamed value (streaming). */
    readonly data: Signal<T | undefined>;
    /** The thrown reason on failure. */
    readonly error: Signal<unknown>;
    /** The lifecycle status. */
    readonly status: Signal<StitchQueryStatus>;
    /** Accumulated `delta` chunks, in arrival order. */
    readonly chunks: Signal<readonly unknown[]>;
    /** `status === 'pending'`. */
    readonly isPending: Signal<boolean>;
    /** `status === 'error'`. */
    readonly isError: Signal<boolean>;
    /** `status === 'success'`. */
    readonly isSuccess: Signal<boolean>;
    /** `status === 'streaming'`. */
    readonly isStreaming: Signal<boolean>;
    /** The same state as an observable — for the `async` pipe / RxJS consumers.
     * Multicast: it shares the one query execution with the signals above. */
    readonly state$: Observable<StitchQueryState<T>>;
    /** Abort the in-flight run and re-run from scratch. */
    refetch: () => void;
    /** Abort the in-flight run, if any. */
    cancel: () => void;
}

// ---------------------------------------------------------------------------
// Shared driver
// ---------------------------------------------------------------------------

// The store's seed value, surfaced before the first real snapshot (an instant).
// It matches core's idle snapshot exactly so the signals are well-formed from the
// start.
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

/** Turn the reactive (or static) input into an observable of the current value.
 * A signal/getter becomes a `toObservable(computed(...))` that re-emits on change;
 * a plain value becomes a single-shot `of(value)`. */
function inputObservable<I>(
    input: InjectInput<I>,
    injector: Injector,
): Observable<I> {
    if (typeof input === 'function') {
        // A Signal is itself a getter, so both `Signal<I>` and `() => I` flow
        // through here; `computed` tracks any signals read inside.
        const source = computed(() => (input as () => I)());
        return toObservable(source, { injector });
    }
    return of(input as I);
}

function injectStitchInternal<T>(
    stitch: StitchLike<T, unknown>,
    input: InjectInput<unknown>,
    options: InjectStitchOptions<T>,
    stream: boolean,
): InjectStitchResult<T> {
    if (!options.injector) assertInInjectionContext(injectStitch);
    const injector = options.injector ?? inject(Injector);
    const destroyRef = injector.get(DestroyRef);

    const { mode, enabled, onSuccess, onError } = options;
    const coreOptions: CreateStitchQueryOptions<T> & { stream: boolean } =
        compact({
            stream,
            mode,
            enabled,
            onSuccess,
            onError,
        });

    // The live query handle, captured for the imperative refetch/cancel. It is
    // reassigned whenever the input changes (switchMap tears down the old one).
    let current: StitchQuery<T> | undefined;

    const state$ = inputObservable(input, injector).pipe(
        // Recreate the handle on each input value; the inner Observable owns the
        // store subscription and tears the handle down on unsubscribe.
        switchMap(
            (value) =>
                new Observable<StitchQueryState<T>>((subscriber) => {
                    const handle = createStitchQuery<T, unknown>(
                        stitch,
                        value,
                        coreOptions,
                    );
                    current = handle;
                    subscriber.next(handle.getSnapshot());
                    const off = handle.subscribe(() =>
                        subscriber.next(handle.getSnapshot()),
                    );
                    return () => {
                        off();
                        handle.destroy();
                        if (current === handle) current = undefined;
                    };
                }),
        ),
        // Complete (and tear down the store) when the injection context dies.
        takeUntilDestroyed(destroyRef),
        // One execution shared by the signal AND any `async`-pipe consumers.
        shareReplay({ bufferSize: 1, refCount: true }),
    );

    const state = toSignal(state$, {
        initialValue: IDLE_STATE as StitchQueryState<T>,
        injector,
    });

    return {
        state,
        data: computed(() => state().data),
        error: computed(() => state().error),
        status: computed(() => state().status),
        chunks: computed(() => state().chunks),
        isPending: computed(() => state().isPending),
        isError: computed(() => state().isError),
        isSuccess: computed(() => state().isSuccess),
        isStreaming: computed(() => state().isStreaming),
        state$,
        refetch: () => current?.refetch(),
        cancel: () => current?.cancel(),
    };
}

// ---------------------------------------------------------------------------
// injectStitch — unary
// ---------------------------------------------------------------------------

/**
 * Run a stitch as a request/response query, exposed as Angular signals and an
 * RxJS observable from one shared execution. Call it in an injection context
 * (a component/directive field initializer, or `runInInjectionContext`); read
 * `result.data()` in a template, or `result.state$ | async`.
 *
 * `input` may be a plain value (read once) or a `Signal` / getter (`() =>
 * this.id()`) — when its value changes the query is recreated and re-fetched.
 * The in-flight run is aborted when the injection context is destroyed.
 *
 * @example
 * ```ts
 * readonly user = injectStitch(getUser, () => ({ params: { id: this.id() } }));
 * // template: @if (user.isPending()) { ... } @else { {{ user.data()?.name }} }
 * ```
 */
export function injectStitch<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: InjectInput<QueryInput<S>>,
    options?: InjectStitchOptions<QueryOutput<S>>,
): InjectStitchResult<QueryOutput<S>>;
export function injectStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: InjectInput<Input>,
    options?: InjectStitchOptions<T>,
): InjectStitchResult<T>;
export function injectStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: InjectInput<unknown>,
    options: InjectStitchOptions<T> = {},
): InjectStitchResult<T> {
    return injectStitchInternal<T>(stitch, input, options, false);
}

// ---------------------------------------------------------------------------
// injectStitchStream — streaming
// ---------------------------------------------------------------------------

/**
 * Run a streaming stitch (an `sse` / `stream` surface) and surface each `delta`
 * chunk as it arrives, as signals and an observable. Same shape as {@link
 * injectStitch}; `data()` is the accumulated chunks (`mode: 'append'`, default)
 * or the latest chunk (`mode: 'replace'`), `chunks()` is the running list, and
 * `status()` is `'streaming'` until the terminal `result`, then `'success'`.
 *
 * @example
 * ```ts
 * readonly chat = injectStitchStream(stream, () => ({ body: { prompt: this.prompt() } }));
 * // template: @for (c of chat.chunks(); track $index) { <span>{{ c }}</span> }
 * ```
 */
export function injectStitchStream<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: InjectInput<QueryInput<S>>,
    options?: InjectStitchOptions<QueryOutput<S>>,
): InjectStitchResult<QueryOutput<S>>;
export function injectStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: InjectInput<Input>,
    options?: InjectStitchOptions<T>,
): InjectStitchResult<T>;
export function injectStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: InjectInput<unknown>,
    options: InjectStitchOptions<T> = {},
): InjectStitchResult<T> {
    return injectStitchInternal<T>(stitch, input, options, true);
}

// ---------------------------------------------------------------------------
// queryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to the other bindings' `queryOptions` (no framework import) — the
// POJO shape `@tanstack/angular-query-experimental`'s `injectQuery(() => ...)`
// consumes is the same `{ queryKey, queryFn }` TanStack uses everywhere.

/** The plain object {@link stitchQueryOptions} returns — structurally compatible with
 * TanStack Query's options without importing the library. */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on `@tanstack/angular-query-experimental` — it just returns a POJO:
 *
 * ```ts
 * import { injectQuery } from '@tanstack/angular-query-experimental';
 * import { stitchQueryOptions } from '@stitchapi/angular';
 *
 * readonly user = injectQuery(() => stitchQueryOptions(getUser, { params: { id: this.id() } }));
 * ```
 *
 * The `queryFn` awaits the stitch (the validated output); the `queryKey` is the
 * stitch's `name` (when present) plus the input, so TanStack caches per call.
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
