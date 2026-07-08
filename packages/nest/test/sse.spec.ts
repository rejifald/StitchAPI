import { streamStitchSse } from '../src';
import type { MessageEventLike } from '../src';

import type { StitchEvent } from 'stitchapi';
import { describe, expect, it } from 'vitest';

// Subscribe and collect messages until the observable terminates.
const collect = (
    obs: ReturnType<typeof streamStitchSse>,
): Promise<{ messages: MessageEventLike[]; error?: Error }> =>
    new Promise((resolve) => {
        const messages: MessageEventLike[] = [];
        obs.subscribe({
            next: (m) => messages.push(m),
            error: (error: Error) => resolve({ messages, error }),
            complete: () => resolve({ messages }),
        });
    });

const dataOf = (messages: MessageEventLike[]): unknown[] =>
    messages.map((m) => m.data);

async function* events(
    ...evs: StitchEvent[]
): AsyncGenerator<StitchEvent, void> {
    for (const e of evs) yield e;
}

describe('streamStitchSse', () => {
    it('forwards delta chunks as messages and completes at stream end', async () => {
        const { messages, error } = await collect(
            streamStitchSse(
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
        expect(dataOf(messages)).toEqual(['a', 'b']); // control events not forwarded
    });

    it('accepts a { stream() } source (the core StitchEventSource intake)', async () => {
        const source = {
            stream: () => events({ type: 'delta', chunk: 'a', at: 0 }),
        };
        const { messages, error } = await collect(streamStitchSse(source));
        expect(error).toBeUndefined();
        expect(dataOf(messages)).toEqual(['a']);
    });

    it('by default errors the observable with the generic token, withholding the raw upstream message', async () => {
        const { messages, error } = await collect(
            streamStitchSse(
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
        expect(dataOf(messages)).toEqual(['a']); // prior deltas are still delivered
        // Nest renders an errored observable's `message` to the client, so it must be the
        // generic token — the same default `data: error` the express/hono helpers write.
        expect(error?.message).toBe('error');
        expect(error?.message).not.toContain('payments.internal.corp');
        // …but the raw failure is preserved server-side as the error's `cause`.
        expect(
            (error?.cause as { message?: string } | undefined)?.message,
        ).toBe('getaddrinfo ENOTFOUND payments.internal.corp');
    });

    it('errorData shapes the client-facing error frame (raw message opt-in)', async () => {
        const raw = await collect(
            streamStitchSse(
                events({
                    type: 'error',
                    name: 'StitchError',
                    message: 'upstream blew up',
                    attempts: 1,
                    at: 0,
                }),
                { errorData: (e) => e.message },
            ),
        );
        expect(raw.error?.message).toBe('upstream blew up');

        const curated = await collect(
            streamStitchSse(
                events({
                    type: 'error',
                    name: 'StitchError',
                    message: 'boom',
                    status: 503,
                    attempts: 1,
                    at: 0,
                }),
                { errorData: (e) => `upstream ${e.status ?? '???'}` },
            ),
        );
        expect(curated.error?.message).toBe('upstream 503');
    });

    it('onError observes the real failure server-side without shaping the client frame', async () => {
        const seen: unknown[] = [];
        const { error } = await collect(
            streamStitchSse(
                events({
                    type: 'error',
                    name: 'StitchError',
                    message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                    attempts: 1,
                    at: 0,
                }),
                { onError: (err) => seen.push(err) },
            ),
        );
        expect(seen).toHaveLength(1);
        expect((seen[0] as Error).message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
        // The client frame stays generic — onError is observation only.
        expect(error?.message).toBe('error');
    });

    it('by default withholds the raw message on a thrown error too, preserving it as cause and reporting via onError', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('getaddrinfo ENOTFOUND payments.internal.corp');
        }
        const seen: unknown[] = [];
        const { messages, error } = await collect(
            streamStitchSse(boom(), { onError: (err) => seen.push(err) }),
        );
        expect(dataOf(messages)).toEqual(['a']);
        expect(error?.message).toBe('error');
        expect(error?.message).not.toContain('payments.internal.corp');
        expect((error?.cause as Error | undefined)?.message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
        expect((seen[0] as Error).message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
    });

    it('applies the data mapper to each chunk; the default JSON-stringifies non-strings', async () => {
        const mapped = await collect(
            streamStitchSse(
                events({ type: 'delta', chunk: { text: 'hi' }, at: 0 }),
                { data: (c) => (c as { text: string }).text },
            ),
        );
        expect(dataOf(mapped.messages)).toEqual(['hi']);

        const stringified = await collect(
            streamStitchSse(
                events({ type: 'delta', chunk: { text: 'hi' }, at: 0 }),
            ),
        );
        expect(dataOf(stringified.messages)).toEqual(['{"text":"hi"}']);
    });

    it('event names each message and id stamps the (chunk, index) last-event id', async () => {
        const { messages } = await collect(
            streamStitchSse(
                events(
                    { type: 'delta', chunk: 'a', at: 0 },
                    { type: 'delta', chunk: 'b', at: 0 },
                ),
                { event: 'token', id: (_chunk, index) => `#${index}` },
            ),
        );
        expect(messages).toEqual([
            { data: 'a', type: 'token', id: '#0' },
            { data: 'b', type: 'token', id: '#1' },
        ]);
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
        const sub = streamStitchSse(gen).subscribe({ next: () => {} });
        sub.unsubscribe();
        expect(returned).toBe(true); // teardown called iterator.return()
    });
});
