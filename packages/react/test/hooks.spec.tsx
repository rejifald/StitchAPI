// @stitchapi/react hook behaviour, rendered into jsdom with @testing-library.
// Driven by FAKE stitches — no engine, no network.
import { stitchQueryOptions, useStitch, useStitchStream } from '../src';

import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import type { StitchEvent } from 'stitchapi';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(cleanup);

// --- fakes -----------------------------------------------------------------

function unaryStitch<T>(
    settle: (input: unknown) => Promise<T>,
    config?: { name?: string; path?: string; url?: string },
): StitchLike<T> {
    const fn = (input?: unknown): StitchCallResult<T> => {
        const promise = settle(input);
        return {
            then: (onf, onr) => promise.then(onf, onr),
            stream() {
                return (async function* () {
                    const value = await promise;
                    yield {
                        type: 'result',
                        data: value,
                        status: 200,
                        attempts: 1,
                        at: 0,
                    } satisfies StitchEvent<T>;
                })();
            },
        };
    };
    if (config) (fn as { __config?: unknown }).__config = config;
    return fn;
}

function streamStitch<T>(events: StitchEvent<T>[]): StitchLike<T> {
    return (): StitchCallResult<T> => {
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

// --- useStitch -------------------------------------------------------------

describe('useStitch', () => {
    function User({
        stitch,
        id,
    }: {
        stitch: StitchLike<{ name: string }>;
        id: string;
    }): React.ReactElement {
        const { data, isPending, isError } = useStitch(stitch, {
            params: { id },
        });
        if (isPending) return <span>loading</span>;
        if (isError) return <span>error</span>;
        return <span>{data?.name}</span>;
    }

    test('renders pending → success', async () => {
        const stitch = unaryStitch(async () => ({ name: 'Ada' }));
        render(<User stitch={stitch} id="1" />);

        expect(screen.getByText('loading')).toBeDefined();
        await waitFor(() => expect(screen.getByText('Ada')).toBeDefined());
    });

    test('renders error on rejection', async () => {
        const stitch = unaryStitch<{ name: string }>(async () => {
            throw new Error('nope');
        });
        render(<User stitch={stitch} id="1" />);
        await waitFor(() => expect(screen.getByText('error')).toBeDefined());
    });

    test('refetch re-runs the call', async () => {
        let n = 0;
        const stitch = unaryStitch(async () => ({ name: `v${++n}` }));

        function Comp(): React.ReactElement {
            const { data, refetch } = useStitch(stitch, {});
            return (
                <div>
                    <span>{data?.name ?? '...'}</span>
                    <button onClick={refetch}>go</button>
                </div>
            );
        }
        render(<Comp />);
        await waitFor(() => expect(screen.getByText('v1')).toBeDefined());
        act(() => {
            screen.getByText('go').click();
        });
        await waitFor(() => expect(screen.getByText('v2')).toBeDefined());
    });

    test('changing input re-fetches (new structural key)', async () => {
        const stitch = unaryStitch(async (input) => ({
            name: `id-${(input as { params: { id: string } }).params.id}`,
        }));

        function Wrapper(): React.ReactElement {
            const [id, setId] = React.useState('1');
            return (
                <div>
                    <User stitch={stitch} id={id} />
                    <button onClick={() => setId('2')}>next</button>
                </div>
            );
        }
        render(<Wrapper />);
        await waitFor(() => expect(screen.getByText('id-1')).toBeDefined());
        act(() => {
            screen.getByText('next').click();
        });
        await waitFor(() => expect(screen.getByText('id-2')).toBeDefined());
    });

    test('enabled:false stays idle and never invokes the stitch', async () => {
        let calls = 0;
        const stitch = unaryStitch(async () => {
            calls += 1;
            return { name: 'Ada' };
        });

        function Comp(): React.ReactElement {
            const { status, isPending } = useStitch(
                stitch,
                { params: { id: '1' } },
                { enabled: false },
            );
            return (
                <span data-testid="status">
                    {status}
                    {isPending ? '!' : ''}
                </span>
            );
        }
        render(<Comp />);

        // The gate holds the store at idle — no pending, no run.
        expect(screen.getByTestId('status').textContent).toBe('idle');
        // Flush microtasks: an eager run would have called the stitch by now.
        await Promise.resolve();
        expect(calls).toBe(0);
    });

    test('a fresh stitch identity each render does not re-fetch (no loop)', async () => {
        let calls = 0;
        const settle = async (): Promise<{ name: string }> => {
            calls += 1;
            return { name: `call-${calls}` };
        };

        function Comp(): React.ReactElement {
            const [, force] = React.useState(0);
            // `unaryStitch(settle)` mints a new function identity on every
            // render. With the structural input unchanged, that identity churn
            // must NOT key a fresh run — otherwise each run's notify would
            // re-render and re-create, looping forever.
            const { data } = useStitch(unaryStitch(settle), {
                params: { id: '1' },
            });
            return (
                <div>
                    <span data-testid="name">{data?.name ?? '...'}</span>
                    <button onClick={() => force((n) => n + 1)}>
                        rerender
                    </button>
                </div>
            );
        }
        render(<Comp />);
        await waitFor(() =>
            expect(screen.getByTestId('name').textContent).toBe('call-1'),
        );

        act(() => {
            screen.getByText('rerender').click();
        });
        act(() => {
            screen.getByText('rerender').click();
        });

        // Two extra renders (new stitch identity each), same structural key →
        // still exactly one run.
        expect(calls).toBe(1);
        expect(screen.getByTestId('name').textContent).toBe('call-1');
    });
});

// --- useStitchStream -------------------------------------------------------

describe('useStitchStream', () => {
    test('re-renders as delta chunks arrive, then settles success', async () => {
        const events: StitchEvent<number[]>[] = [
            { type: 'delta', chunk: 1, at: 0 },
            { type: 'delta', chunk: 2, at: 0 },
            { type: 'delta', chunk: 3, at: 0 },
            {
                type: 'result',
                data: [1, 2, 3],
                status: 200,
                attempts: 1,
                at: 0,
            },
            { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
        ];

        function Stream(): React.ReactElement {
            const { chunks, isStreaming, isSuccess } = useStitchStream(
                streamStitch(events),
                undefined,
            );
            return (
                <div>
                    <span data-testid="chunks">
                        {(chunks as number[]).join(',')}
                    </span>
                    <span data-testid="status">
                        {isSuccess
                            ? 'done'
                            : isStreaming
                              ? 'streaming'
                              : 'idle'}
                    </span>
                </div>
            );
        }

        render(<Stream />);

        // First chunk lands → streaming with [1].
        await waitFor(() =>
            expect(screen.getByTestId('chunks').textContent).toBe('1'),
        );
        // All chunks accumulate and the stream settles to success.
        await waitFor(() => {
            expect(screen.getByTestId('chunks').textContent).toBe('1,2,3');
            expect(screen.getByTestId('status').textContent).toBe('done');
        });
    });

    test('replace mode shows only the latest chunk', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', data: 20, status: 200, attempts: 1, at: 0 },
        ];

        function Stream(): React.ReactElement {
            const { data } = useStitchStream(streamStitch(events), undefined, {
                mode: 'replace',
            });
            return <span data-testid="data">{String(data ?? '')}</span>;
        }
        render(<Stream />);
        await waitFor(() =>
            expect(screen.getByTestId('data').textContent).toBe('20'),
        );
    });
});

// --- UseStitchOptions surface ------------------------------------------------

describe('UseStitchOptions', () => {
    test("the store's 'streaming' flag cannot be passed to the hooks", () => {
        const stitch = unaryStitch(async () => 1);
        // Never executed — compile-time assertions only: each hook hard-sets
        // `streaming`, so passing it must be a TYPE ERROR rather than being
        // silently ignored.
        void function TypeOnly(): void {
            // @ts-expect-error — 'streaming' is omitted from UseStitchOptions
            useStitch(stitch, {}, { streaming: true });
            // @ts-expect-error — 'streaming' is omitted from UseStitchOptions
            useStitchStream(stitch, {}, { streaming: false });
        };
        expect(true).toBe(true);
    });
});

// --- stitchQueryOptions ----------------------------------------------------------

describe('stitchQueryOptions', () => {
    test('returns a TanStack-shaped POJO with key + async queryFn', async () => {
        const stitch = unaryStitch(async () => ({ ok: true }), {
            name: 'getThing',
        });
        const opts = stitchQueryOptions(stitch, { params: { id: '7' } });
        expect(opts.queryKey).toEqual(['getThing', { params: { id: '7' } }]);
        await expect(opts.queryFn()).resolves.toEqual({ ok: true });
    });

    test('falls back to "stitch" when no __config.name', () => {
        const stitch = unaryStitch(async () => 1);
        const opts = stitchQueryOptions(stitch, null);
        expect(opts.queryKey[0]).toBe('stitch');
    });
});

// --- stitchQueryOptions: cache-key derivation regressions ------------------
// The derivation now lives in `@stitchapi/query-core` (`stitchKey.of`) and is
// re-exported here; these regressions stay to guard the re-export wiring. Each
// of these FAILED before the original fix (the local copy shared the same three
// bugs as `@stitchapi/swr`'s `swrKey`).

describe('stitchQueryOptions — no cache collision between nameless stitches', () => {
    // Bug 1 (correctness): `name ?? 'stitch'` keyed every nameless stitch as the
    // literal 'stitch', so two distinct endpoints with same-shaped input collided
    // on one TanStack Query cache entry. Fixed by mirroring core's `nameOf`
    // (name ?? path ?? url ?? 'stitch').
    test('two nameless stitches with different paths get DIFFERENT keys', () => {
        const getUser = unaryStitch(async () => 1, { path: '/users/{id}' });
        const getOrder = unaryStitch(async () => 1, { path: '/orders/{id}' });
        const input = { params: { id: '1' } };

        const userKey = stitchQueryOptions(getUser, input).queryKey;
        const orderKey = stitchQueryOptions(getOrder, input).queryKey;

        expect(userKey).not.toEqual(orderKey);
        expect(userKey[0]).toBe('/users/{id}');
        expect(orderKey[0]).toBe('/orders/{id}');
    });
});

describe('stitchQueryOptions — no secret leak in the query key', () => {
    // Bug 2 (security): the raw `input` went straight into the queryKey, so a
    // per-call `authorization` header serialised the bearer token into the
    // TanStack Query key (persisted, and shown in the devtools panel). Fixed by
    // redacting denylisted header VALUES.
    test('a per-call authorization header does not put the token in the key', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const { queryKey } = stitchQueryOptions(getUser, {
            params: { id: '1' },
            headers: { authorization: 'Bearer SECRET123' },
        });

        expect(JSON.stringify(queryKey)).not.toContain('SECRET123');
    });

    test('redacts the secret header but keeps a benign one (no fresh collision)', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const [, keyInput] = stitchQueryOptions(getUser, {
            params: { id: '1' },
            headers: {
                authorization: 'Bearer SECRET123',
                'accept-language': 'en-US',
            },
        }).queryKey;

        const headers = (keyInput as { headers: Record<string, string> })
            .headers;
        expect(headers['authorization']).not.toContain('SECRET123');
        expect(headers['accept-language']).toBe('en-US');
    });
});

describe('stitchQueryOptions — no refetch storm from runtime-only input fields', () => {
    // Bug 2 (reliability): `signal`/`onProgress` are runtime-only (never
    // serialised, per CONTRACT.md). An inline `onProgress` churns identity every
    // render, so keying it re-fetched forever. Fixed by excluding both fields.
    test('two distinct inline onProgress functions produce EQUAL keys', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const base = { params: { id: '1' } };

        const keyA = stitchQueryOptions(getUser, {
            ...base,
            onProgress: () => {},
        }).queryKey;
        const keyB = stitchQueryOptions(getUser, {
            ...base,
            onProgress: () => {},
        }).queryKey;

        expect(keyA).toEqual(keyB);
    });

    test('a per-call signal does not enter the key', () => {
        const getUser = unaryStitch(async () => 1, { name: 'getUser' });
        const controller = new AbortController();

        const withSignal = stitchQueryOptions(getUser, {
            params: { id: '1' },
            signal: controller.signal,
        }).queryKey;
        const without = stitchQueryOptions(getUser, {
            params: { id: '1' },
        }).queryKey;

        expect(withSignal).toEqual(without);
    });
});
