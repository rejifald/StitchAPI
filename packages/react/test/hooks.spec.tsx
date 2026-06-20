// @stitchapi/react hook behaviour, rendered into jsdom with @testing-library.
// Driven by FAKE stitches — no engine, no network.
import {
    // Deprecated alias (ADR 0012) — exercised by the alias-guard test below.
    queryOptions,
    stitchQueryOptions,
    useStitch,
    useStitchStream,
} from '../src';

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

    test('queryOptions stays a deprecated alias of stitchQueryOptions (ADR 0012)', () => {
        expect(queryOptions).toBe(stitchQueryOptions);
    });
});
