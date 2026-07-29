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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter, re-exported from
//                          `@stitchapi/query-core` (returns a plain POJO, so it
//                          needs no import of the Angular adapter; named with
//                          the `stitch` prefix because TanStack exports its own
//                          `queryOptions`, see ADR 0012).
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
    type StitchQueryResult,
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
    StitchQueryOptions,
    StitchQueryResult,
    StitchQueryStatus,
} from '@stitchapi/query-core';

// The TanStack Query adapter and its key derivation live in
// `@stitchapi/query-core` — ONE shared implementation across every framework
// binding, so the key format (and its secret-redaction guarantees) cannot drift
// between frameworks. Re-exported here so Angular apps import everything from
// `@stitchapi/angular`.
export {
    deriveQueryKey,
    keyInputFor,
    nameOf,
    stitchQueryOptions,
} from '@stitchapi/query-core';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** A value, a `Signal` of it, or a zero-arg getter — Angular's idiom for "static
 * or reactive" (the sibling of Vue's `MaybeRefOrGetter` and Solid's
 * `MaybeAccessor`). Passing a signal/getter recreates the query (and re-fetches)
 * when the tracked value changes; a plain value is read once. */
export type MaybeSignal<T> = T | Signal<T> | (() => T);

/**
 * Options accepted by {@link injectStitch} / {@link injectStitchStream}.
 *
 * The store's `streaming` flag is deliberately OMITTED: each injector hard-sets
 * it (`injectStitch` → unary, `injectStitchStream` → streaming), so passing it
 * would be silently ignored — the type forbids it instead.
 */
export interface InjectStitchOptions<T>
    extends Omit<CreateStitchQueryOptions<T>, 'streaming'> {
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
    readonly state: Signal<StitchQueryResult<T>>;
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
    readonly state$: Observable<StitchQueryResult<T>>;
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

/** Turn the reactive (or static) input into an observable of the current value.
 * A signal/getter becomes a `toObservable(computed(...))` that re-emits on change;
 * a plain value becomes a single-shot `of(value)`. */
function inputObservable<I>(
    input: MaybeSignal<I>,
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
    input: MaybeSignal<unknown>,
    options: InjectStitchOptions<T>,
    streaming: boolean,
): InjectStitchResult<T> {
    if (!options.injector) assertInInjectionContext(injectStitch);
    const injector = options.injector ?? inject(Injector);
    const destroyRef = injector.get(DestroyRef);

    const { mode, enabled, onSuccess, onError } = options;
    const coreOptions: CreateStitchQueryOptions<T> = compact({
        streaming,
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
                new Observable<StitchQueryResult<T>>((subscriber) => {
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
        initialValue: IDLE_STATE as StitchQueryResult<T>,
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
    input: MaybeSignal<QueryInput<S>>,
    options?: InjectStitchOptions<QueryOutput<S>>,
): InjectStitchResult<QueryOutput<S>>;
export function injectStitch<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeSignal<Input>,
    options?: InjectStitchOptions<T>,
): InjectStitchResult<T>;
export function injectStitch<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeSignal<unknown>,
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
    input: MaybeSignal<QueryInput<S>>,
    options?: InjectStitchOptions<QueryOutput<S>>,
): InjectStitchResult<QueryOutput<S>>;
export function injectStitchStream<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: MaybeSignal<Input>,
    options?: InjectStitchOptions<T>,
): InjectStitchResult<T>;
export function injectStitchStream<T>(
    stitch: StitchLike<T, unknown>,
    input: MaybeSignal<unknown>,
    options: InjectStitchOptions<T> = {},
): InjectStitchResult<T> {
    return injectStitchInternal<T>(stitch, input, options, true);
}
