// @stitchapi/swr behaviour, driven through SWR in a jsdom env with React Testing
// Library. Driven by FAKE stitches — no engine, no network. Each render wraps SWR
// in a fresh in-memory cache so tests don't share state.
import { swrKey, useStitchSWR } from '../src';
import type { StitchLike } from '../src';

import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, createElement } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, test } from 'vitest';

// --- fakes -----------------------------------------------------------------

/** A unary stitch: resolves (or rejects) after a tick. SWR only needs the
 * awaitable side, so the fake is just a thenable. `config` mirrors the real
 * `__config` slice `swrKey` reads (`name`, and — after the fix — `path`/`url`). */
function unaryStitch<T>(
    settle: (input: unknown) => Promise<T>,
    config?: { name?: string; path?: string; url?: string },
): StitchLike<T> {
    const fn = (input?: unknown): PromiseLike<T> => ({
        then: (onf, onr) => settle(input).then(onf, onr),
    });
    if (config) (fn as { __config?: unknown }).__config = config;
    return fn;
}

/** Wrap children in an isolated SWR cache (fresh Map per test). */
function wrapper({ children }: { children: ReactNode }) {
    return createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        children,
    );
}

// --- swrKey ----------------------------------------------------------------

describe('swrKey', () => {
    test('uses __config.name + input', () => {
        const stitch = unaryStitch(async () => 1, { name: 'getThing' });
        expect(swrKey(stitch, { params: { id: '7' } })).toEqual([
            'getThing',
            { params: { id: '7' } },
        ]);
    });

    test('falls back to "stitch" and normalises undefined input to null', () => {
        const stitch = unaryStitch(async () => 1);
        expect(swrKey(stitch, undefined)).toEqual(['stitch', null]);
    });
});

// --- swrKey: cache-key derivation regressions ------------------------------
// These pin the three bugs the derivation used to have (all shared with
// `@stitchapi/react`'s `stitchQueryOptions`). Each FAILED before the fix.

describe('swrKey — no cache collision between nameless stitches', () => {
    // Bug 1 (correctness): `name ?? 'stitch'` keyed EVERY nameless stitch as the
    // literal 'stitch', so two distinct endpoints with same-shaped input collided
    // on one SWR entry and served each other's data. The fix mirrors core's
    // `nameOf` (name ?? path ?? url ?? 'stitch').
    test('two nameless stitches with different paths get DIFFERENT keys', () => {
        const getUser = unaryStitch(async () => 1, { path: '/users/{id}' });
        const getOrder = unaryStitch(async () => 1, { path: '/orders/{id}' });
        const input = { params: { id: '1' } };

        const userKey = swrKey(getUser, input);
        const orderKey = swrKey(getOrder, input);

        // Distinct endpoints must not share a cache entry.
        expect(userKey).not.toEqual(orderKey);
        expect(userKey[0]).toBe('/users/{id}');
        expect(orderKey[0]).toBe('/orders/{id}');
    });
});

describe('swrKey — no secret leak in the cache key', () => {
    // Bug 2 (security): the raw `input` went straight into the key, so a per-call
    // `authorization` header serialised the bearer token into the SWR key — which
    // is persisted by cache providers and shown in devtools. The fix redacts
    // denylisted header VALUES (keeping the header present so it still varies the
    // cache), never the token itself.
    test('a per-call authorization header does not put the token in the key', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const key = swrKey(getUser, {
            params: { id: '1' },
            headers: { authorization: 'Bearer SECRET123' },
        });

        expect(JSON.stringify(key)).not.toContain('SECRET123');
    });

    test('redacts the secret header but keeps a benign one (no fresh collision)', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const [, keyInput] = swrKey(getUser, {
            params: { id: '1' },
            headers: {
                authorization: 'Bearer SECRET123',
                'accept-language': 'en-US',
            },
        });

        const headers = (keyInput as { headers: Record<string, string> })
            .headers;
        // Secret value gone, header slot retained…
        expect(headers['authorization']).not.toContain('SECRET123');
        // …and the non-secret header is preserved so callers who legitimately
        // vary by `accept-language` still get separate cache entries.
        expect(headers['accept-language']).toBe('en-US');
    });
});

describe('swrKey — no refetch storm from runtime-only input fields', () => {
    // Bug 2 (reliability): `signal`/`onProgress` are runtime-only (never
    // serialised, per CONTRACT.md). An inline `onProgress` mints a fresh function
    // identity every render, so serialising it churned the key every render →
    // endless refetch. The fix excludes both fields from the key.
    test('two distinct inline onProgress functions produce EQUAL keys', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const base = { params: { id: '1' } };

        const keyA = swrKey(getUser, { ...base, onProgress: () => {} });
        const keyB = swrKey(getUser, { ...base, onProgress: () => {} });

        expect(keyA).toEqual(keyB);
    });

    test('a per-call signal does not enter the key', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const controller = new AbortController();

        const withSignal = swrKey(getUser, {
            params: { id: '1' },
            signal: controller.signal,
        });
        const without = swrKey(getUser, { params: { id: '1' } });

        expect(withSignal).toEqual(without);
    });
});

// --- useStitchSWR ----------------------------------------------------------

describe('useStitchSWR', () => {
    test('fetches through the stitch and exposes the validated data', async () => {
        const getUser = unaryStitch(async () => ({ name: 'Ada' }));
        const { result } = renderHook(
            () => useStitchSWR(getUser, { params: { id: '1' } }),
            { wrapper },
        );

        expect(result.current.isLoading).toBe(true);
        await waitFor(() =>
            expect(result.current.data).toEqual({ name: 'Ada' }),
        );
        expect(result.current.error).toBeUndefined();
    });

    test('surfaces a thrown reason on SWR `error`', async () => {
        const boom = new Error('nope');
        const getUser = unaryStitch<{ name: string }>(async () => {
            throw boom;
        });
        const { result } = renderHook(() => useStitchSWR(getUser, {}), {
            wrapper,
        });

        await waitFor(() => expect(result.current.error).toBe(boom));
        expect(result.current.data).toBeUndefined();
    });

    test('dedupes two components with the same stitch + input', async () => {
        let calls = 0;
        const getUser = unaryStitch(async () => {
            calls++;
            return { name: 'Ada' };
        });

        function Twice() {
            const a = useStitchSWR(getUser, { params: { id: '1' } });
            const b = useStitchSWR(getUser, { params: { id: '1' } });
            return createElement(
                'div',
                null,
                `${a.data?.name ?? ''}|${b.data?.name ?? ''}`,
            );
        }

        render(createElement(Twice), { wrapper });
        await waitFor(() => screen.getByText('Ada|Ada'));
        // One shared cache entry → the fetcher runs once for both hooks.
        expect(calls).toBe(1);
    });

    test('forwards the SWR options (third argument) to useSWR', async () => {
        const getUser = unaryStitch(async () => ({ name: 'fresh' }));
        const { result } = renderHook(
            () =>
                useStitchSWR(
                    getUser,
                    { params: { id: '1' } },
                    { fallbackData: { name: 'cached' } },
                ),
            { wrapper },
        );

        // `fallbackData` is an SWR option, so its presence proves the third
        // argument reached useSWR: the cached value shows immediately…
        expect(result.current.data).toEqual({ name: 'cached' });
        // …then the stitch fetcher revalidates to the fresh value.
        await waitFor(() =>
            expect(result.current.data).toEqual({ name: 'fresh' }),
        );
    });
});
