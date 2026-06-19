// @stitchapi/rtk-query behaviour. The adapters are plain framework-agnostic
// functions, so they are driven directly (no Redux store) — plus one real
// `createApi` to prove they compose. Driven by FAKE stitches: no engine, no network.
import { stitchQueryFn, stitchStreamUpdater } from '../src';
import type {
    CacheLifecycleApi,
    StitchLike,
    StreamableStitchLike,
} from '../src';

import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';

// --- fakes -----------------------------------------------------------------

function unaryStitch<T>(settle: (input: unknown) => Promise<T>): StitchLike<T> {
    return (input?: unknown): PromiseLike<T> => ({
        then: (onf, onr) => settle(input).then(onf, onr),
    });
}

function streamStitch<T>(events: StitchEvent<T>[]): StreamableStitchLike<T> {
    return () => {
        const terminal = events.find((e) => e.type === 'result');
        const value =
            terminal && terminal.type === 'result'
                ? terminal.value
                : (undefined as T);
        const promise = Promise.resolve(value);
        return {
            then: (onf, onr) => promise.then(onf, onr),
            stream() {
                return (async function* () {
                    for (const e of events) {
                        await Promise.resolve();
                        yield e;
                    }
                })();
            },
        };
    };
}

/** A mock of the slice of RTK's cache-lifecycle API the updater uses, backed by a
 * real array so we can assert what got pushed. `cacheEntryRemoved` never resolves. */
function mockCache<T>(seed: T[]): {
    data: T[];
    api: CacheLifecycleApi<T[]>;
} {
    const data = seed;
    return {
        data,
        api: {
            updateCachedData: (recipe) => recipe(data),
            cacheDataLoaded: Promise.resolve({ data }),
            cacheEntryRemoved: new Promise<void>(() => {}),
        },
    };
}

// --- stitchQueryFn ---------------------------------------------------------

describe('stitchQueryFn', () => {
    test('returns { data } with the validated output on success', async () => {
        const qfn = stitchQueryFn(unaryStitch(async () => ({ name: 'Ada' })));
        await expect(qfn({ params: { id: '1' } })).resolves.toEqual({
            data: { name: 'Ada' },
        });
    });

    test('returns { error } with a serialisable reason on a throw', async () => {
        class StitcheyError extends Error {
            override name = 'StitchError';
            status = 404;
        }
        const qfn = stitchQueryFn<{ name: string }>(
            unaryStitch(async () => {
                throw new StitcheyError('not found');
            }),
        );
        const result = await qfn({});
        expect(result).toEqual({
            error: { name: 'StitchError', message: 'not found', status: 404 },
        });
        // The error is a plain serialisable object (safe for Redux state).
        expect(result.error && typeof result.error).toBe('object');
    });
});

// --- stitchStreamUpdater ---------------------------------------------------

describe('stitchStreamUpdater', () => {
    const events: StitchEvent<number>[] = [
        { type: 'delta', chunk: 1, at: 0 },
        { type: 'delta', chunk: 2, at: 0 },
        { type: 'delta', chunk: 3, at: 0 },
        { type: 'result', value: 3, status: 200, attempts: 1, at: 0 },
        { type: 'done', ok: true, ms: 1, attempts: 1, at: 0 },
    ];

    test('append mode pushes every delta chunk into the cached array', async () => {
        const { data, api } = mockCache<number>([]);
        await stitchStreamUpdater<number>(streamStitch(events))(undefined, api);
        expect(data).toEqual([1, 2, 3]);
    });

    test('replace mode keeps only the latest chunk', async () => {
        const { data, api } = mockCache<number>([]);
        await stitchStreamUpdater<number>(streamStitch(events), {
            mode: 'replace',
        })(undefined, api);
        expect(data).toEqual([3]);
    });
});

// --- composition with createApi -------------------------------------------

describe('createApi composition', () => {
    test('both adapters slot into a real endpoint definition', () => {
        const api = createApi({
            baseQuery: fakeBaseQuery(),
            endpoints: (build) => ({
                getUser: build.query<{ name: string }, { id: string }>({
                    queryFn: stitchQueryFn(
                        unaryStitch(async () => ({ name: 'Ada' })),
                    ),
                }),
                chat: build.query<number[], void>({
                    queryFn: () => ({ data: [] }),
                    onCacheEntryAdded: stitchStreamUpdater<number>(
                        streamStitch([
                            { type: 'delta', chunk: 1, at: 0 },
                            {
                                type: 'result',
                                value: 1,
                                status: 200,
                                attempts: 1,
                                at: 0,
                            },
                        ]),
                    ),
                }),
            }),
        });
        expect(api.reducerPath).toBe('api');
        expect(typeof api.reducer).toBe('function');
    });
});
