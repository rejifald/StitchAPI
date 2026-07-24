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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (returns a plain
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
    StitchQueryResult,
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

// --- key derivation (shared logic; duplicated in @stitchapi/react) ----------
// These helpers are intentionally copied verbatim from `@stitchapi/react`'s key
// derivation: they are separate published packages, so a cross-package import
// would add a runtime dependency. Keep the copies in lock-step.

/** The `__config` slice a key derives from. Mirrors core's `nameOf`
 * (`name ?? path ?? 'stitch'`) plus a `url` fallback for URL-configured stitches. */
type KeyConfig = { name?: string; path?: string; url?: string };

/** A stable, human-meaningful name for the stitch. Mirrors core's `nameOf`
 * (`packages/core/src/engine.ts`) — `name ?? path ?? url ?? 'stitch'` — so two
 * DISTINCT nameless stitches (`/users/{id}` vs `/orders/{id}`) don't collapse to
 * the literal `'stitch'` and collide on one cache entry. */
function nameOf(stitch: unknown): string {
    const cfg = (stitch as { __config?: KeyConfig }).__config;
    return cfg?.name ?? cfg?.path ?? cfg?.url ?? 'stitch';
}

// Header names whose VALUES are secrets — mirrors core's private `SECRET_HEADERS`
// trace denylist (`packages/core/src/trace.ts`), which is not exported. We redact
// the value (rather than dropping the header) so the key stays stable per token
// AND callers who legitimately vary a response by a non-secret header (e.g.
// `accept-language`) keep separate cache entries. Compared case-insensitively; the
// `*-token` / `*-api-key` suffix rules catch vendor spellings without enumerating.
const SECRET_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
]);
const REDACTED = '[redacted]';

function isSecretHeader(name: string): boolean {
    const k = name.toLowerCase();
    return (
        SECRET_HEADERS.has(k) || k.endsWith('-token') || k.endsWith('-api-key')
    );
}

/**
 * Build the value that goes into a cache/query key from a stitch's per-call input.
 * Never puts the raw input in the key:
 *
 * - drops `signal` / `onProgress` — runtime-only, never-serialised (CONTRACT.md);
 *   `onProgress` in particular churns identity every render, which would refetch
 *   forever if it entered the key;
 * - redacts the VALUES of secret-bearing headers (`authorization`, `cookie`, …)
 *   so a bearer token can't leak into a persisted / devtools-visible key, while
 *   keeping non-secret headers so they still vary the cache;
 * - keeps every other field (`params` / `query` / `body` / `variables` / …) as-is.
 *
 * `null` / `undefined` inputs stay `null`; a primitive input is returned unchanged.
 */
function keyInputFor(input: unknown): unknown {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'object') return input;

    const {
        signal: _signal,
        onProgress: _onProgress,
        ...rest
    } = input as {
        signal?: unknown;
        onProgress?: unknown;
        headers?: Record<string, unknown>;
    } & Record<string, unknown>;

    if (rest.headers && typeof rest.headers === 'object') {
        const headers: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest.headers)) {
            headers[k] = isSecretHeader(k) ? REDACTED : v;
        }
        rest.headers = headers;
    }
    return rest;
}

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
// stitchQueryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to the other bindings' `stitchQueryOptions` (no framework import) —
// the POJO shape `@tanstack/angular-query-experimental`'s `injectQuery(() => ...)`
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
 * The `queryFn` awaits the stitch (the validated output); the `queryKey` is a
 * stable name for the stitch plus a sanitised copy of the input (secret header
 * values redacted, runtime-only `signal`/`onProgress` dropped), so TanStack caches
 * per call without leaking a bearer token into the key or refetching every render.
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
    return {
        queryKey: [nameOf(stitch), keyInputFor(input)],
        queryFn: () => Promise.resolve(stitch(input)),
    };
}
