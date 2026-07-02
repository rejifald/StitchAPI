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

    it('by default errors the observable with a safe message, withholding the raw upstream message', async () => {
        const { data, error } = await collect(
            stitchSse(
                events(
                    { type: 'delta', chunk: 'a', at: 0 },
                    {
                        type: 'error',
                        name: 'StitchError',
                        // Discloses an internal hostname — must NOT reach the client (topology
                        // disclosure; same class the exception filter fixed on the HTTP surface).
                        message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                        status: 502,
                        attempts: 1,
                        at: 0,
                    },
                ),
            ),
        );
        expect(data).toEqual(['a']); // prior deltas are still delivered
        // Nest renders an errored observable's `message` to the client, so it must be the safe token.
        expect(error?.message).toBe('Upstream request failed');
        expect(error?.message).not.toContain('payments.internal.corp');
        // …but the raw failure is preserved server-side as the error's `cause`.
        expect(
            (error?.cause as { message?: string } | undefined)?.message,
        ).toBe('getaddrinfo ENOTFOUND payments.internal.corp');
    });

    it('exposeMessage opts in to forwarding the raw upstream message', async () => {
        const { data, error } = await collect(
            stitchSse(
                events(
                    { type: 'delta', chunk: 'a', at: 0 },
                    {
                        type: 'error',
                        name: 'StitchError',
                        message: 'upstream blew up',
                        attempts: 1,
                        at: 0,
                    },
                ),
                { exposeMessage: true },
            ),
        );
        expect(data).toEqual(['a']);
        expect(error?.message).toBe('upstream blew up');
    });

    it('message sets a curated client-facing message (string or function), overriding exposeMessage', async () => {
        const fixed = await collect(
            stitchSse(
                events({
                    type: 'error',
                    name: 'StitchError',
                    message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                    attempts: 1,
                    at: 0,
                }),
                {
                    message: 'Payment provider unavailable',
                    exposeMessage: true,
                },
            ),
        );
        expect(fixed.error?.message).toBe('Payment provider unavailable');
        expect(fixed.error?.message).not.toContain('payments.internal.corp');

        const dynamic = await collect(
            stitchSse(
                events({
                    type: 'error',
                    name: 'StitchError',
                    message: 'boom',
                    status: 503,
                    attempts: 1,
                    at: 0,
                }),
                { message: (e) => `upstream ${e.status ?? '???'}` },
            ),
        );
        expect(dynamic.error?.message).toBe('upstream 503');
    });

    it('by default withholds the raw message on a thrown error too, preserving it as cause', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('getaddrinfo ENOTFOUND payments.internal.corp');
        }
        const { data, error } = await collect(stitchSse(boom()));
        expect(data).toEqual(['a']);
        expect(error?.message).toBe('Upstream request failed');
        expect(error?.message).not.toContain('payments.internal.corp');
        expect((error?.cause as Error | undefined)?.message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
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
