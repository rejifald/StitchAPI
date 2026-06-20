// @stitchapi/react hook behaviour, rendered into jsdom with @testing-library.
// Driven by FAKE stitches — no engine, no network.
import { queryOptions, useStitch, useStitchStream } from '../src';

import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import type { StitchEvent } from 'stitchapi';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(cleanup);

// --- fakes -----------------------------------------------------------------

function unaryStitch<T>(
    settle: (input: unknown) => Promise<T>,
    config?: { name?: string },
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
                        value,
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
                value: [1, 2, 3],
                status: 200,
                attempts: 1,
                at: 0,
            },
            { type: 'done', ok: true, ms: 1, attempts: 1, at: 0 },
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
            { type: 'result', value: 20, status: 200, attempts: 1, at: 0 },
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

// --- queryOptions ----------------------------------------------------------

describe('queryOptions', () => {
    test('returns a TanStack-shaped POJO with key + async queryFn', async () => {
        const stitch = unaryStitch(async () => ({ ok: true }), {
            name: 'getThing',
        });
        const opts = queryOptions(stitch, { params: { id: '7' } });
        expect(opts.queryKey).toEqual(['getThing', { params: { id: '7' } }]);
        await expect(opts.queryFn()).resolves.toEqual({ ok: true });
    });

    test('falls back to "stitch" when no __config.name', () => {
        const stitch = unaryStitch(async () => 1);
        const opts = queryOptions(stitch, null);
        expect(opts.queryKey[0]).toBe('stitch');
    });
});
