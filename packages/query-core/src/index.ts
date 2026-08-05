// @stitchapi/query-core — a tiny, framework-agnostic reactive store wrapping a
// StitchAPI call.
//
// A `stitch` (from `stitchapi`) is a typed declarative call: invoking it returns
// a `StitchResult<T>` that is BOTH awaitable (`PromiseLike<T>` → the validated
// output) AND streamable (`.stream()` → an `AsyncGenerator<StitchEvent<T>>`
// carrying `delta` chunks and a terminal `result`/`error`). This package turns
// that one-shot call into a SUBSCRIBABLE store: a `getSnapshot()` / `subscribe()`
// handle that drives React's `useSyncExternalStore` (see `@stitchapi/react`) and,
// later, the equivalent primitives in Vue / Svelte / Solid. It imports NO
// framework and NO `node:*` — its only runtime import is its `stitchapi` peer
// (for the shared secret-key predicate) — so it is browser- and edge-safe.
//
// The store owns the lifecycle the engine deliberately leaves to a host: it runs
// the call under an `AbortController`, publishes status transitions to listeners,
// `cancel()`s by aborting, and `refetch()`es by re-running. For a streaming
// surface it consumes `.stream()` and pushes a state update as each `delta`
// arrives — the reactive differentiator over plain request/response query libs.
import { isSecretKey } from 'stitchapi';
import type { Stitch, StitchEvent, StitchResult } from 'stitchapi';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The lifecycle status of a query. `'streaming'` is entered when a streaming
 * surface has emitted at least one `delta` but not yet its terminal `result`. */
export type StitchQueryStatus =
    'idle' | 'pending' | 'streaming' | 'success' | 'error';

/**
 * A snapshot of a query's reactive state. Stable by identity between
 * notifications: the store only ever hands out a NEW object when something
 * actually changed, so `useSyncExternalStore` (and `===` checks elsewhere) never
 * tear or loop.
 */
export interface StitchQueryResult<T> {
    readonly status: StitchQueryStatus;
    /** The validated output (unary) or the latest streamed value (streaming). */
    readonly data: T | undefined;
    /** The thrown reason on failure (a `StitchError` from core, or any throw). */
    readonly error: unknown;
    /** Accumulated `delta` chunks, in arrival order. Empty for a unary call, or
     * when `mode: 'replace'` (only the latest chunk is kept on `data`). */
    readonly chunks: readonly unknown[];
    /** `status === 'pending'` — a convenience flag for the common render branch. */
    readonly isPending: boolean;
    /** `status === 'error'`. */
    readonly isError: boolean;
    /** `status === 'success'`. */
    readonly isSuccess: boolean;
    /** `status === 'streaming'`. */
    readonly isStreaming: boolean;
}

/** How a streaming query folds its `delta` chunks into `data`. */
export interface CreateStitchQueryOptions<T> {
    /**
     * Drive the call through `.stream()` and update state per `delta`. Off by
     * default — a unary `await` is the simplest correct path. When a stitch uses
     * a streaming surface (`sse` / `stream`), set this so chunks render as they
     * arrive.
     */
    readonly streaming?: boolean;
    /**
     * For a streaming query, how `data` reflects the stream. `'append'` (default)
     * collects every chunk into `chunks` and sets `data` to the running array.
     * `'replace'` keeps only the latest chunk as `data` (and an empty `chunks`).
     * Ignored for a unary call.
     */
    readonly mode?: 'append' | 'replace';
    /** Run the call immediately on creation. Default `true`. Set `false` to start
     * `idle` and fetch lazily via `refetch()`. */
    readonly enabled?: boolean;
    /** Called with the validated value on success (unary or stream terminal). */
    readonly onSuccess?: (data: T) => void;
    /** Called with the thrown reason on failure. */
    readonly onError?: (error: unknown) => void;
}

/** A subscribable query handle — the shape `useSyncExternalStore` consumes. */
export interface StitchQuery<T> {
    /** Register a listener; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
    /** The current immutable state. Identity-stable between real changes. */
    getSnapshot(): StitchQueryResult<T>;
    /** Abort the in-flight run (if any) and re-run from scratch. */
    refetch(): void;
    /** Abort the in-flight run, if any. Leaves the last state in place; the run
     * settles as an `error` carrying the abort reason. */
    cancel(): void;
    /** Abort and drop all listeners — call when the owner unmounts. */
    destroy(): void;
}

// ---------------------------------------------------------------------------
// The structural call contract
// ---------------------------------------------------------------------------

// We accept anything that, when called, returns a `StitchResult`-like value: a
// thenable that also exposes `.stream()`. This is exactly the real `Stitch`
// callable, but stated structurally so a plain fake (a function returning an
// async-iterable-bearing thenable) drives the store in tests without the engine.

/** The minimal streaming surface the store consumes off a call result. */
export interface StreamableResult<T> {
    stream(): AsyncIterable<StitchEvent<T>>;
}

/** A value the store can both await and stream — core's `StitchResult<T>`. */
export type StitchCallResult<T> = PromiseLike<T> & StreamableResult<T>;

/** A callable that produces a {@link StitchCallResult}. Core's `Stitch` satisfies
 * this; so does a hand-written fake in a test. `Input` defaults to `unknown` so
 * an input-less stitch is callable with no argument. */
export type StitchLike<T, Input = unknown> = (
    input?: Input,
) => StitchCallResult<T>;

// ---------------------------------------------------------------------------
// Output/Input inference helpers — recover a stitch's types
// ---------------------------------------------------------------------------

/** The output type of a stitch (or stitch-like callable). */
export type QueryOutput<S> =
    S extends Stitch<infer O, infer _I>
        ? O
        : S extends StitchLike<infer O, infer _I2>
          ? O
          : unknown;

/** The call-argument type of a stitch (or stitch-like callable). */
export type QueryInput<S> =
    S extends Stitch<infer _O, infer I>
        ? I
        : S extends StitchLike<infer _O2, infer I2>
          ? I2
          : unknown;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

// `NoInfer` keeps `data` from driving `T`'s inference (so a `data: undefined`
// branch does not collapse `T` to `undefined`). TS ships it as of 5.4.
interface Core<T> {
    status: StitchQueryStatus;
    data: NoInfer<T> | undefined;
    error: unknown;
    chunks: readonly unknown[];
}

const IDLE: StitchQueryResult<never> = freeze<never>({
    status: 'idle',
    data: undefined,
    error: undefined,
    chunks: [],
});

function freeze<T>(partial: Core<T>): StitchQueryResult<T> {
    const { status } = partial;
    const state: StitchQueryResult<T> = {
        status,
        data: partial.data,
        error: partial.error,
        chunks: partial.chunks,
        isPending: status === 'pending',
        isError: status === 'error',
        isSuccess: status === 'success',
        isStreaming: status === 'streaming',
    };
    return Object.freeze(state);
}

/**
 * Create a reactive store around a single stitch call.
 *
 * @param stitch a `Stitch` from `stitchapi` (or any stitch-like callable).
 * @param input  the call argument; pass `undefined` for an input-less stitch.
 * @param options streaming / lifecycle behaviour — see {@link CreateStitchQueryOptions}.
 */
export function createStitchQuery<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: CreateStitchQueryOptions<QueryOutput<S>>,
): StitchQuery<QueryOutput<S>>;
export function createStitchQuery<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: CreateStitchQueryOptions<T>,
): StitchQuery<T>;
export function createStitchQuery<T>(
    stitch: StitchLike<T>,
    input: unknown,
    options: CreateStitchQueryOptions<T> = {},
): StitchQuery<T> {
    const {
        streaming = false,
        mode = 'append',
        enabled = true,
        onSuccess,
        onError,
    } = options;

    const listeners = new Set<() => void>();
    let state = IDLE as StitchQueryResult<T>;
    let controller: AbortController | undefined;
    // A token guards against a stale run resolving after a newer refetch/cancel:
    // every run captures the token live at start, and only the current run may
    // publish.
    let runToken = 0;
    let destroyed = false;

    function setState(next: StitchQueryResult<T>): void {
        state = next;
        for (const l of listeners) l();
    }

    function abortCurrent(reason?: unknown): void {
        controller?.abort(reason);
        controller = undefined;
    }

    async function runUnary(token: number): Promise<void> {
        try {
            const value = await stitch(input);
            if (token !== runToken || destroyed) return;
            setState(
                freeze<T>({
                    status: 'success',
                    data: value,
                    error: undefined,
                    chunks: [],
                }),
            );
            onSuccess?.(value);
        } catch (error) {
            if (token !== runToken || destroyed) return;
            setState(
                freeze<T>({
                    status: 'error',
                    data: undefined,
                    error,
                    chunks: [],
                }),
            );
            onError?.(error);
        }
    }

    async function runStream(token: number): Promise<void> {
        const collected: unknown[] = [];
        try {
            for await (const event of stitch(input).stream()) {
                if (token !== runToken || destroyed) return;
                if (event.type === 'delta') {
                    if (mode === 'append') {
                        collected.push(event.chunk);
                        setState(
                            freeze<T>({
                                status: 'streaming',
                                data: collected.slice() as unknown as T,
                                error: undefined,
                                chunks: collected.slice(),
                            }),
                        );
                    } else {
                        setState(
                            freeze<T>({
                                status: 'streaming',
                                data: event.chunk as T,
                                error: undefined,
                                chunks: [],
                            }),
                        );
                    }
                } else if (event.type === 'result') {
                    const value = event.data;
                    setState(
                        freeze<T>({
                            status: 'success',
                            data: value,
                            error: undefined,
                            chunks: mode === 'append' ? collected.slice() : [],
                        }),
                    );
                    onSuccess?.(value);
                } else if (event.type === 'error') {
                    const error = new Error(event.message);
                    setState(
                        freeze<T>({
                            status: 'error',
                            data: undefined,
                            error,
                            chunks: mode === 'append' ? collected.slice() : [],
                        }),
                    );
                    onError?.(error);
                }
            }
        } catch (error) {
            if (token !== runToken || destroyed) return;
            setState(
                freeze<T>({
                    status: 'error',
                    data: undefined,
                    error,
                    chunks: mode === 'append' ? collected.slice() : [],
                }),
            );
            onError?.(error);
        }
    }

    function start(): void {
        if (destroyed) return;
        abortCurrent(new DOMExceptionLike('The query was superseded.'));
        const token = ++runToken;
        controller = new AbortController();
        setState(
            freeze<T>({
                status: 'pending',
                data: undefined,
                error: undefined,
                chunks: [],
            }),
        );
        // `void` the promise: errors are folded into state, never unhandled.
        void (streaming ? runStream(token) : runUnary(token));
    }

    if (enabled) start();

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot() {
            return state;
        },
        refetch() {
            start();
        },
        cancel() {
            // Invalidate the in-flight run so its late resolution can't publish.
            runToken++;
            abortCurrent(new DOMExceptionLike('The query was cancelled.'));
        },
        destroy() {
            destroyed = true;
            runToken++;
            abortCurrent(new DOMExceptionLike('The query was destroyed.'));
            listeners.clear();
        },
    };
}

// A minimal `AbortController.abort(reason)` reason that reads like a DOMException
// without depending on the DOM lib at runtime (browser/edge/node all have
// `Error`). Carries `name: 'AbortError'` so consumers can branch on it.
class DOMExceptionLike extends Error {
    override readonly name = 'AbortError';
    constructor(message: string) {
        super(message);
    }
}

// ---------------------------------------------------------------------------
// TanStack Query interop — the canonical options shape + key derivation
// ---------------------------------------------------------------------------
// The one shared implementation behind every TanStack binding's
// `stitchQueryOptions` (react / vue / svelte / solid / angular) and the swr
// binding's key builder. Bindings import from here instead of carrying private
// copies, so the key format — and its secret-redaction guarantees — cannot
// drift between frameworks (CONTRACT.md P9).

/**
 * The canonical options object a binding's `stitchQueryOptions(...)` returns —
 * structurally what TanStack Query's `useQuery` / `createQuery` / `injectQuery`
 * consume, WITHOUT importing the library.
 *
 * `queryKey` / `queryFn` — and the `*Options` name itself, which TanStack uses
 * for exactly this shape — are TanStack Query's own vocabulary, kept verbatim
 * as a deliberate standards-interop carve-out (CONTRACT.md P22): this type
 * exists solely to be handed to TanStack, so renaming any part of it would buy
 * a translation seam and nothing else. The name is blessed; do not rename.
 */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/** The `__config` slice a key derives from. Mirrors core's `nameOf`
 * (`name ?? path ?? 'stitch'`) plus a `url` fallback for URL-configured stitches. */
interface KeyConfig {
    name?: string;
    path?: string;
    url?: string;
}

/** A stable, human-meaningful name for the stitch — the first segment of a
 * derived query key. Mirrors core's `nameOf` (`packages/core/src/engine.ts`) —
 * `name ?? path ?? url ?? 'stitch'` — so two DISTINCT nameless stitches
 * (`/users/{id}` vs `/orders/{id}`) don't collapse to the literal `'stitch'`
 * and collide on one cache entry. */
export function nameOf(stitch: unknown): string {
    const cfg = (stitch as { __config?: KeyConfig }).__config;
    return cfg?.name ?? cfg?.path ?? cfg?.url ?? 'stitch';
}

// Header names whose VALUES are secrets — the header-specific denylist on top of
// core's `isSecretKey` predicate (which contributes the secret stems — `token`,
// `secret`, `apikey`, … — and any caller-registered names via
// `registerSecretKey`). We redact the value (rather than dropping the header) so
// the key stays stable per token AND callers who legitimately vary a response by
// a non-secret header (e.g. `accept-language`) keep separate cache entries.
// Compared case-insensitively; the `*-token` / `*-api-key` suffix rules catch
// vendor spellings the stems miss (dashes defeat the `api_key`/`apikey` stems).
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
        SECRET_HEADERS.has(k) ||
        k.endsWith('-token') ||
        k.endsWith('-api-key') ||
        isSecretKey(k)
    );
}

/**
 * Build the value that goes into a cache/query key from a stitch's per-call
 * input — the second segment of a derived query key. Never puts the raw input
 * in the key:
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
export function keyInputFor(input: unknown): unknown {
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

/**
 * Derive the canonical cache/query key for a stitch call: a stable name for the
 * stitch (see {@link nameOf}) plus a sanitised copy of the input (see
 * {@link keyInputFor}). Every binding — the five TanStack adapters' query keys
 * and the swr key builder — derives from here, so a stitch keys identically no
 * matter which framework reads it.
 */
export function deriveQueryKey(
    stitch: unknown,
    input: unknown,
): readonly [string, unknown] {
    return [nameOf(stitch), keyInputFor(input)];
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on any `@tanstack/*-query` package — it just returns a POJO. The
 * framework bindings re-export this; pass it straight to `useQuery` /
 * `createQuery` / `injectQuery`:
 *
 * ```ts
 * import { useQuery } from '@tanstack/react-query';
 * import { stitchQueryOptions } from '@stitchapi/react';
 *
 * const { data } = useQuery(stitchQueryOptions(getUser, { params: { id } }));
 * ```
 *
 * The `queryFn` awaits the stitch (the validated output); the `queryKey` is
 * {@link deriveQueryKey}'s stable, secret-redacted key, so TanStack caches per
 * call without leaking a bearer token into the key or refetching every render.
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
    stitch: StitchLike<T>,
    input: unknown,
): StitchQueryOptions<T> {
    return {
        queryKey: deriveQueryKey(stitch, input),
        queryFn: () => Promise.resolve(stitch(input)),
    };
}

// ---------------------------------------------------------------------------
// Re-exports for binding authors
// ---------------------------------------------------------------------------

export type { Stitch, StitchEvent, StitchResult };
