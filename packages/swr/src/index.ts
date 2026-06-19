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
export type StitchLike<T, Input = unknown> = (input?: Input) => PromiseLike<T>;

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

/** The SWR cache key a stitch+input maps to: the stitch's `name` (when present)
 * plus the input, so SWR caches and dedupes per call. */
export type StitchSWRKey = readonly [name: string, input: unknown];

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
    const name = (stitch as { __config?: { name?: string } }).__config?.name;
    return [name ?? 'stitch', input ?? null];
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
export function useStitchSWR<S extends StitchLike<unknown, never>>(
    stitch: S,
    input: QueryInput<S>,
    config?: SWRConfiguration<QueryOutput<S>>,
): SWRResponse<QueryOutput<S>>;
export function useStitchSWR<T, Input = unknown>(
    stitch: StitchLike<T, Input>,
    input: Input,
    config?: SWRConfiguration<T>,
): SWRResponse<T>;
export function useStitchSWR<T>(
    stitch: StitchLike<T, unknown>,
    input: unknown,
    config?: SWRConfiguration<T>,
): SWRResponse<T> {
    // The stitch is the fetcher; SWR caches by `swrKey`. `Promise.resolve` lifts
    // the stitch's thenable result into a real Promise for SWR.
    return useSWR<T>(
        swrKey(stitch, input),
        () => Promise.resolve(stitch(input)),
        config,
    );
}
