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
 * awaitable side, so the fake is just a thenable. */
function unaryStitch<T>(
    settle: (input: unknown) => Promise<T>,
    config?: { name?: string },
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

    test('forwards the SWR config (third argument) to useSWR', async () => {
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

        // `fallbackData` is a config option, so its presence proves the third
        // argument reached useSWR: the cached value shows immediately…
        expect(result.current.data).toEqual({ name: 'cached' });
        // …then the stitch fetcher revalidates to the fresh value.
        await waitFor(() =>
            expect(result.current.data).toEqual({ name: 'fresh' }),
        );
    });
});
