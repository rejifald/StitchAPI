// @stitchapi/swr — use a stitch as an SWR fetcher.
//
// Unlike `@stitchapi/react` (which OWNS the call lifecycle via query-core), this is
// a thin adapter for apps already standardised on [SWR](https://swr.vercel.app):
// SWR keeps owning caching, deduping, and revalidation, while the stitch stays the
// typed, validated, traced fetcher. No `@stitchapi/query-core` — SWR is the store.
//
// - `useStitchSWR` — the hook: `useSWR` with the stitch as the fetcher.
// - `swrKey`       — the cache key a stitch+input maps to, for manual `useSWR`,
//                    conditional fetching (`enabled ? swrKey(...) : null`), or
//                    global `mutate`.
//
// SWR models request/response only — for streaming (`sse` / `stream` surfaces)
// reach for `useStitchStream` from `@stitchapi/react` instead.
import type { Stitch } from 'stitchapi';
import useSWR, { type SWRConfiguration, type SWRResponse } from 'swr';

// ---------------------------------------------------------------------------
// The structural call contract
// ---------------------------------------------------------------------------

/** A callable that, given its input, returns an awaitable validated output. The
 * real `Stitch` satisfies this; so does a plain fake in a test. SWR only needs the
 * awaitable side, so — unlike the reactive bindings — there is no `.stream()`. */
// The MINIMAL await-only stitch duck-type (CONTRACT.md P9): this adapter never calls `.stream()`,
// so it accepts any `(input?) => PromiseLike<T>`. The RICH canonical `StitchLike` (awaitable +
// streamable) lives in `@stitchapi/query-core`; a real stitch satisfies both.
export type StitchLike<T, Input = unknown> = (input?: Input) => PromiseLike<T>;

// `QueryOutput` / `QueryInput` deliberately re-state `@stitchapi/query-core`'s
// inference helpers over THIS package's minimal `StitchLike` tier (CONTRACT.md P9
// de-list): same identifier, same conditional shape, but inferring from the
// await-only duck-type above — a cross-package import would add a runtime
// dependency this adapter intentionally does not have. query-core's rich tier is
// assignable to the minimal one, so both spellings agree on any real stitch.

/** The validated output type of a stitch (or `StitchLike`). */
export type QueryOutput<S> =
    S extends Stitch<infer O, infer _I>
        ? O
        : S extends StitchLike<infer O2, infer _I2>
          ? O2
          : unknown;

/** The input type of a stitch (or `StitchLike`). */
export type QueryInput<S> =
    S extends Stitch<infer _O, infer I>
        ? I
        : S extends StitchLike<infer _O2, infer I2>
          ? I2
          : unknown;

// ---------------------------------------------------------------------------
// swrKey
// ---------------------------------------------------------------------------

/** The SWR cache key a stitch+input maps to: a stable name for the stitch plus a
 * sanitised copy of the input (secret header values redacted, runtime-only fields
 * dropped), so SWR caches and dedupes per call without leaking or churning. */
export type StitchSWRKey = readonly [name: string, input: unknown];

// --- key derivation (shared logic; duplicated in @stitchapi/react) ---------
// These two helpers are intentionally copied verbatim into `@stitchapi/react`'s
// `stitchQueryOptions`: they are separate published packages, so a cross-package
// import would add a runtime dependency. Keep the two copies in lock-step.

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
 * Build the value that goes into the cache key from a stitch's per-call input.
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

/**
 * Build the SWR key for a stitch call — use it for conditional fetching or a
 * targeted `mutate`:
 *
 * ```ts
 * import useSWR from 'swr';
 * import { swrKey } from '@stitchapi/swr';
 *
 * // Skip the request until `id` exists (SWR's null-key convention).
 * const { data } = useSWR(id ? swrKey(getUser, { params: { id } }) : null, () =>
 *     getUser({ params: { id } }),
 * );
 * ```
 */
export function swrKey<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
): StitchSWRKey;
export function swrKey<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
): StitchSWRKey;
export function swrKey<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
): StitchSWRKey {
    return [nameOf(stitch), keyInputFor(input)];
}

// ---------------------------------------------------------------------------
// useStitchSWR
// ---------------------------------------------------------------------------

/**
 * Run a stitch through SWR. Returns SWR's own response (`data`, `error`,
 * `isLoading`, `isValidating`, `mutate`) — SWR owns caching and revalidation; the
 * stitch is the validated fetcher. The cache key is {@link swrKey}, so two calls
 * with the same stitch + input dedupe.
 *
 * ```tsx
 * import { useStitchSWR } from '@stitchapi/swr';
 *
 * function Profile({ id }: { id: string }) {
 *     const { data, error, isLoading } = useStitchSWR(getUser, { params: { id } });
 *     if (isLoading) return <Spinner />;
 *     if (error) return <Retry />;
 *     return <h1>{data?.name}</h1>;
 * }
 * ```
 *
 * Pass SWR options as the third argument (`{ revalidateOnFocus, refreshInterval,
 * … }`). For conditional fetching use {@link swrKey} with a bare `useSWR`.
 */
// The third parameter is `options` (house vocabulary); its TYPE stays SWR's own
// `SWRConfiguration` — an adapter mirror keeps upstream spelling (CONTRACT.md P18).
export function useStitchSWR<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    options?: SWRConfiguration<QueryOutput<S>>,
): SWRResponse<QueryOutput<S>>;
export function useStitchSWR<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    options?: SWRConfiguration<T>,
): SWRResponse<T>;
export function useStitchSWR<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    options?: SWRConfiguration<T>,
): SWRResponse<T> {
    // The stitch is the fetcher; SWR caches by `swrKey`. `Promise.resolve` lifts
    // the stitch's thenable result into a real Promise for SWR.
    return useSWR<T>(
        swrKey(stitch, input),
        () => Promise.resolve(stitch(input)),
        options,
    );
}
