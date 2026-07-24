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
// - `stitchQueryOptions` — an OPTIONAL TanStack Query adapter (returns a plain
//                       POJO, so it needs no import of `@tanstack/vue-query`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryResult,
    createStitchQuery,
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
    StitchQueryResult,
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
// Shared driver
// ---------------------------------------------------------------------------

interface UseStitchOptions<T> extends CreateStitchQueryOptions<T> {}

// --- key derivation (shared logic; duplicated in @stitchapi/react + swr) ----
// These helpers are intentionally copied verbatim from `@stitchapi/react`
// (`packages/react/src/index.ts`, landed in #406) and `@stitchapi/swr`: they are
// separate published packages, so a cross-package import would add a runtime
// dependency. Keep the copies in lock-step. Used BOTH by the reactive dep key
// below and by `stitchQueryOptions`.

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

// A structural key of the input so an equal-shaped literal does not re-create the
// handle, but `{ id: 1 }` → `{ id: 2 }` does. Mirrors `@stitchapi/react`. Sanitises
// first via `keyInputFor` so an inline `onProgress` (fresh identity per render)
// can't churn the key and loop, and a per-call `signal` adds no non-deterministic
// noise — both are runtime-only.
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
    stream: boolean,
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
                stream,
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

// ---------------------------------------------------------------------------
// stitchQueryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to `@stitchapi/react`'s `stitchQueryOptions` — a plain POJO with no
// framework import, so it feeds `@tanstack/vue-query`'s `useQuery(options)`
// (or any other) just the same.

/** The plain object {@link stitchQueryOptions} returns — structurally compatible with
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
 * import { stitchQueryOptions } from '@stitchapi/vue';
 *
 * const { data } = useQuery(stitchQueryOptions(getUser, { params: { id } }));
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
