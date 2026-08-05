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
            terminal?.type === 'result' ? terminal.data : (undefined as T);
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

    test('preserves the P10 field set — body included — across serialisation', async () => {
        class RichError extends Error {
            override name = 'StitchError';
            status = 502;
            attempts = 3;
            body = { error: 'bad gateway', upstream: ['a', 'b'] }; // parsed JSON payload → carried
            url = 'https://api.example.com/users/1';
        }
        const qfn = stitchQueryFn(
            unaryStitch(async () => {
                throw new RichError('bad gateway');
            }),
        );
        const result = await qfn({});

        expect(result.error).toEqual({
            name: 'StitchError',
            message: 'bad gateway',
            status: 502,
            attempts: 3,
            body: { error: 'bad gateway', upstream: ['a', 'b'] },
            url: 'https://api.example.com/users/1',
        });
        // The whole error survives a real JSON round trip intact (Redux persistence).
        expect(JSON.parse(JSON.stringify(result.error))).toEqual(result.error);
    });

    test('drops non-JSON-survivable fields and the raw response carrier', async () => {
        const cyclic: Record<string, unknown> = {};
        cyclic['self'] = cyclic;
        class LeakyError extends Error {
            override name = 'RateLimitError';
            status = 429;
            retryAfter = 1000; // plain data → carried
            // The full AdapterResponse lives on the thrown instance ONLY (core's rule) —
            // its headers (set-cookie & co.) must never reach Redux state.
            response = {
                status: 429,
                headers: { 'set-cookie': 'secret' },
                body: {},
            };
            onRetry = (): void => {}; // function → dropped
            inner = new RangeError('nested'); // class instance → dropped
            loop = cyclic; // cycle → dropped (JSON.stringify would throw)
        }
        const qfn = stitchQueryFn(
            unaryStitch(async () => {
                throw new LeakyError('rate limited (HTTP 429)');
            }),
        );
        const result = await qfn({});

        expect(result.error).toEqual({
            name: 'RateLimitError',
            message: 'rate limited (HTTP 429)',
            status: 429,
            retryAfter: 1000,
        });
        expect(result.error && 'response' in result.error).toBe(false);
    });

    test('serialises a non-Error throw via String(reason)', async () => {
        const qfn = stitchQueryFn(
            unaryStitch(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error
                throw 'plain string failure';
            }),
        );
        const result = await qfn({});
        expect(result.error).toEqual({
            name: 'Error',
            message: 'plain string failure',
        });
    });
});

// --- stitchStreamUpdater ---------------------------------------------------

describe('stitchStreamUpdater', () => {
    const events: StitchEvent<number>[] = [
        { type: 'delta', chunk: 1, at: 0 },
        { type: 'delta', chunk: 2, at: 0 },
        { type: 'delta', chunk: 3, at: 0 },
        { type: 'result', data: 3, status: 200, attempts: 1, at: 0 },
        { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
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

    test("scalar shorthand: 'replace' ≡ { mode: 'replace' } (P12), and {} is rejected (P20)", async () => {
        const { data, api } = mockCache<number>([]);
        await stitchStreamUpdater<number>(streamStitch(events), 'replace')(
            undefined,
            api,
        );
        expect(data).toEqual([3]);

        // @ts-expect-error — P20: the empty object is not a valid options value;
        // the all-defaults case is omitting the argument.
        stitchStreamUpdater<number>(streamStitch(events), {});
    });

    test('stops when the cache entry is removed, even if the stream never ends', async () => {
        const data: number[] = [];
        const api: CacheLifecycleApi<number[]> = {
            updateCachedData: (recipe) => recipe(data),
            cacheDataLoaded: Promise.resolve({ data }),
            // The entry is evicted (component unmounted) — this must win the race.
            cacheEntryRemoved: Promise.resolve(),
        };
        // A stitch whose stream never completes on its own.
        const neverEnding: StreamableStitchLike<number> = () => ({
            then: (onf) => Promise.resolve(undefined as never).then(onf),
            stream() {
                return (async function* () {
                    await new Promise<void>(() => {});
                    // Unreachable — the promise above never settles, which is the
                    // point (the stream neither yields nor completes). Present so
                    // this reads as a generator to `require-yield`; `never` keeps it
                    // assignable to the AsyncIterable<StitchEvent<number>> contract.
                    yield undefined as never;
                })();
            },
        });

        // Must resolve via cacheEntryRemoved rather than hang on the live stream.
        await expect(
            stitchStreamUpdater<number>(neverEnding)(undefined, api),
        ).resolves.toBeUndefined();
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
                                data: 1,
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
