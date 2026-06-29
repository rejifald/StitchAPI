import { stitchSse } from '../src';

import type { StitchEvent } from 'stitchapi';
import { describe, expect, it } from 'vitest';

// Subscribe and collect message data until the observable terminates.
const collect = (
    obs: ReturnType<typeof stitchSse>,
): Promise<{ data: unknown[]; error?: Error }> =>
    new Promise((resolve) => {
        const data: unknown[] = [];
        obs.subscribe({
            next: (m) => data.push(m.data),
            error: (error: Error) => resolve({ data, error }),
            complete: () => resolve({ data }),
        });
    });

async function* events(
    ...evs: StitchEvent[]
): AsyncGenerator<StitchEvent, void> {
    for (const e of evs) yield e;
}

describe('stitchSse', () => {
    it('forwards delta chunks as messages and completes at stream end', async () => {
        const { data, error } = await collect(
            stitchSse(
                events(
                    {
                        type: 'start',
                        name: 'x',
                        method: 'GET',
                        url: 'u',
                        input: {},
                        at: 0,
                    },
                    { type: 'delta', chunk: 'a', at: 0 },
                    { type: 'delta', chunk: 'b', at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ),
            ),
        );
        expect(error).toBeUndefined();
        expect(data).toEqual(['a', 'b']); // control events not forwarded
    });

    it('errors the observable on an error event, after any prior deltas', async () => {
        const { data, error } = await collect(
            stitchSse(
                events(
                    { type: 'delta', chunk: 'a', at: 0 },
                    {
                        type: 'error',
                        name: 'x',
                        message: 'boom',
                        attempts: 1,
                        at: 0,
                    },
                ),
            ),
        );
        expect(data).toEqual(['a']);
        expect(error?.message).toBe('boom');
    });

    it('applies the data mapper to each chunk', async () => {
        const { data } = await collect(
            stitchSse(events({ type: 'delta', chunk: { text: 'hi' }, at: 0 }), {
                data: (c) => (c as { text: string }).text,
            }),
        );
        expect(data).toEqual(['hi']);
    });

    it('aborts the upstream generator when the subscription tears down', async () => {
        let returned = false;
        const gen: AsyncIterable<StitchEvent> = {
            [Symbol.asyncIterator]() {
                return {
                    next: () =>
                        new Promise<IteratorResult<StitchEvent>>(() => {
                            /* never resolves — a long-running upstream */
                        }),
                    return: () => {
                        returned = true;
                        return Promise.resolve({
                            done: true,
                            value: undefined,
                        });
                    },
                };
            },
        };
        const sub = stitchSse(gen).subscribe({ next: () => {} });
        sub.unsubscribe();
        expect(returned).toBe(true); // teardown called iterator.return()
    });
});
