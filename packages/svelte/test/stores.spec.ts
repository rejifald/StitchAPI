// @stitchapi/svelte store behaviour, driven by FAKE stitches in node env (no DOM):
// we subscribe to the readable store and assert the emitted state transitions —
// exactly how Svelte's `$store` / `subscribe` would observe them at runtime.
import {
    queryOptions,
    stitchQueryOptions,
    stitchStore,
    stitchStreamStore,
    useStitch,
    useStitchStream,
} from '../src';

import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test, vi } from 'vitest';

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
            terminal && terminal.type === 'result'
                ? terminal.data
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

// Subscribe to a store and record every emitted state; returns the live log plus
// the unsubscribe. Subscribing is what triggers the deferred fetch.
function collect<T>(store: {
    subscribe: (run: (v: T) => void) => () => void;
}): { states: T[]; unsubscribe: () => void } {
    const states: T[] = [];
    const unsubscribe = store.subscribe((v) => states.push(v));
    return { states, unsubscribe };
}

// A microtask flush sufficient for the fakes' `await`s to settle. The streaming
// fake yields after an `await Promise.resolve()` per event, so we drain plenty.
const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

// --- stitchStore (unary) ---------------------------------------------------

describe('stitchStore', () => {
    test('emits idle/pending → success on subscribe', async () => {
        const store = stitchStore(
            unaryStitch(async () => ({ name: 'Ada' })),
            {
                params: { id: '1' },
            },
        );

        const { states, unsubscribe } = collect(store);
        // The fetch is deferred to first subscription, so subscribing drives the
        // store from its idle seed through pending. (Svelte's `readable` runs the
        // start callback eagerly on subscribe, so `pending` may already be the
        // first value the subscriber observes — what matters is that the run did
        // not start before subscription and that we transit through pending.)
        expect(states.some((s) => s.status === 'pending')).toBe(true);

        await flush();
        const last = states[states.length - 1];
        expect(last?.status).toBe('success');
        expect(last?.isSuccess).toBe(true);
        expect(last?.data).toEqual({ name: 'Ada' });
        unsubscribe();
    });

    test('emits error on rejection', async () => {
        const store = stitchStore(
            unaryStitch<{ name: string }>(async () => {
                throw new Error('nope');
            }),
            {},
        );
        const { states, unsubscribe } = collect(store);
        await flush();
        const last = states[states.length - 1];
        expect(last?.status).toBe('error');
        expect(last?.isError).toBe(true);
        expect((last?.error as Error).message).toBe('nope');
        unsubscribe();
    });

    test('refetch re-runs the call', async () => {
        let n = 0;
        const store = stitchStore(
            unaryStitch(async () => ({ name: `v${++n}` })),
            {},
        );
        const { states, unsubscribe } = collect(store);
        await flush();
        expect(states[states.length - 1]?.data).toEqual({ name: 'v1' });

        store.refetch();
        await flush();
        expect(states[states.length - 1]?.data).toEqual({ name: 'v2' });
        unsubscribe();
    });

    test('does not fetch until subscribed; aborts on last unsubscribe', async () => {
        const settle = vi.fn(async () => ({ ok: true }));
        const store = stitchStore(unaryStitch(settle), {});
        // No subscriber yet → no run.
        await flush();
        expect(settle).not.toHaveBeenCalled();

        const { unsubscribe } = collect(store);
        await flush();
        expect(settle).toHaveBeenCalledTimes(1);

        // Last unsubscribe destroys the query; a subsequent refetch must not
        // publish (the store is torn down).
        unsubscribe();
        store.refetch();
        await flush();
        expect(settle).toHaveBeenCalledTimes(1);
    });

    test('enabled:false starts idle and does not fetch on subscribe', async () => {
        const settle = vi.fn(async () => 1);
        const store = stitchStore(unaryStitch(settle), {}, { enabled: false });
        const { states, unsubscribe } = collect(store);
        await flush();
        expect(settle).not.toHaveBeenCalled();
        expect(states.every((s) => s.status === 'idle')).toBe(true);

        store.refetch();
        await flush();
        expect(settle).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    test('useStitch is an alias of stitchStore', () => {
        expect(useStitch).toBe(stitchStore);
    });

    test('forwards onSuccess to the underlying query (fires on success after subscribe)', async () => {
        let received: unknown;
        const store = stitchStore(
            unaryStitch(async () => ({ id: 7 })),
            {},
            {
                onSuccess: (d) => {
                    received = d;
                },
            },
        );
        const { unsubscribe } = collect(store); // first subscriber starts the run
        await flush();
        expect(received).toEqual({ id: 7 });
        unsubscribe();
    });

    test('forwards onError to the underlying query', async () => {
        let received: unknown;
        const boom = new Error('nope');
        const store = stitchStore<{ id: number }>(
            unaryStitch(async () => {
                throw boom;
            }),
            {},
            {
                onError: (e) => {
                    received = e;
                },
            },
        );
        const { unsubscribe } = collect(store);
        await flush();
        expect(received).toBe(boom);
        unsubscribe();
    });
});

// --- stitchStreamStore (streaming) -----------------------------------------

describe('stitchStreamStore', () => {
    test('emits streaming states per delta then settles success', async () => {
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
        const store = stitchStreamStore(streamStitch(events), undefined);
        const { states, unsubscribe } = collect(store);
        await flush();

        // Saw a streaming state with the first chunk only.
        expect(
            states.some(
                (s) =>
                    s.status === 'streaming' &&
                    (s.chunks as number[]).length === 1,
            ),
        ).toBe(true);

        const last = states[states.length - 1];
        expect(last?.status).toBe('success');
        expect(last?.chunks).toEqual([1, 2, 3]);
        unsubscribe();
    });

    test('replace mode keeps only the latest chunk on data', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', data: 20, status: 200, attempts: 1, at: 0 },
        ];
        const store = stitchStreamStore(streamStitch(events), undefined, {
            mode: 'replace',
        });
        const { states, unsubscribe } = collect(store);
        await flush();
        const last = states[states.length - 1];
        expect(last?.data).toBe(20);
        expect(last?.chunks).toEqual([]);
        unsubscribe();
    });

    test('useStitchStream is an alias of stitchStreamStore', () => {
        expect(useStitchStream).toBe(stitchStreamStore);
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

    test('falls back to "stitch" only when name, path AND url are all absent', () => {
        const stitch = unaryStitch(async () => 1);
        const opts = stitchQueryOptions(stitch, null);
        expect(opts.queryKey[0]).toBe('stitch');
    });

    test('a plain (non-secret) input is carried into the key unchanged', () => {
        const stitch = unaryStitch(async () => 1, { name: 'getThing' });
        const opts = stitchQueryOptions(stitch, { params: { id: '7' } });
        expect(opts.queryKey[1]).toEqual({ params: { id: '7' } });
    });
});

describe('queryOptions (deprecated alias)', () => {
    test('queryOptions stays a deprecated alias of stitchQueryOptions (ADR 0012)', () => {
        expect(queryOptions).toBe(stitchQueryOptions);
    });
});

// --- stitchQueryOptions: cache-key derivation regressions ------------------
// The `queryKey` derivation shared the same three bugs @stitchapi/react fixed in
// #406 (nameless-collision, secret-header leak, refetch storm). Each of these
// FAILED before the port. Kept in lock-step with `packages/react/test/hooks.spec.tsx`.

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
    // Bug 3 (reliability): `signal`/`onProgress` are runtime-only (never
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
