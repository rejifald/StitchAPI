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
// - `useStitch` / `useStitchStream` — hook-style aliases for the two above, for
//                         callers who prefer the `use*` naming.
// - `queryOptions`     — an OPTIONAL TanStack Query adapter (returns a plain POJO,
//                         so it needs no import of `@tanstack/svelte-query`).
import {
    type CreateStitchQueryOptions,
    type QueryInput,
    type QueryOutput,
    type StitchLike,
    type StitchQuery,
    type StitchQueryState,
    createStitchQuery,
} from '@stitchapi/query-core';
import { type Readable, readable } from 'svelte/store';

export type {
    CreateStitchQueryOptions,
    QueryInput,
    QueryOutput,
    StitchLike,
    StitchQuery,
    StitchQueryState,
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
export interface SvelteStitchStore<T> extends Readable<StitchQueryState<T>> {
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
    options: CreateStitchQueryOptions<T> & { stream: boolean },
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
    const store = readable<StitchQueryState<T>>(query.getSnapshot(), (set) => {
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
    return makeStore<T>(stitch, input, { ...options, stream: false });
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
    return makeStore<T>(stitch, input, { ...options, stream: true });
}

// ---------------------------------------------------------------------------
// useStitch / useStitchStream — hook-style aliases
// ---------------------------------------------------------------------------

/** Alias for {@link stitchStore}, for callers who prefer the `use*` naming. The
 * returned value is a Svelte store — re-create it when `input`/`options` change
 * (e.g. derive it inside a `$:` block keyed on those) and let scope teardown
 * destroy it. */
export const useStitch = stitchStore;

/** Alias for {@link stitchStreamStore}. */
export const useStitchStream = stitchStreamStore;

// ---------------------------------------------------------------------------
// queryOptions — optional TanStack Query adapter
// ---------------------------------------------------------------------------

// IDENTICAL to `@stitchapi/react`'s `queryOptions` — it imports no framework, so
// the POJO is framework-neutral and feeds `@tanstack/svelte-query`'s
// `createQuery` exactly as it feeds React's `useQuery`.

// --- key derivation (shared logic; duplicated in @stitchapi/react + swr) ----
// These helpers are intentionally copied verbatim from `@stitchapi/react`
// (`packages/react/src/index.ts`, landed in #406) and `@stitchapi/swr`: they are
// separate published packages, so a cross-package import would add a runtime
// dependency. Keep the copies in lock-step.

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

/** The plain object {@link stitchQueryOptions} returns — structurally compatible with
 * TanStack Query's `createQuery(options)` without importing the library. */
export interface StitchQueryOptions<T> {
    queryKey: readonly unknown[];
    queryFn: (ctx?: { signal?: AbortSignal }) => Promise<T>;
}

/**
 * Build a TanStack-Query-compatible options object for a stitch, WITHOUT a hard
 * dependency on `@tanstack/svelte-query` — it just returns a POJO. Pass it
 * straight to `createQuery`:
 *
 * ```ts
 * import { createQuery } from '@tanstack/svelte-query';
 * import { stitchQueryOptions } from '@stitchapi/svelte';
 *
 * const query = createQuery(stitchQueryOptions(getUser, { params: { id } }));
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

/**
 * @deprecated Renamed to {@link stitchQueryOptions} — a bare `queryOptions` collides
 * with TanStack Query's own `queryOptions` export when both are imported. See
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the
 * `1.0.0-rc` line and removed at the 1.0 GA cut.
 */
export const queryOptions = stitchQueryOptions;
