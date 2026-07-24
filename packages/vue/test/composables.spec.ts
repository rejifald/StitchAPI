// @stitchapi/vue composable behaviour, driven inside a manual `effectScope` —
// no component mount, no jsdom. The composables read core through a `shallowRef`,
// and the core publishes synchronously on each transition, so a `flush()` (one
// awaited microtask) is enough to settle the fake stitch's resolved promises.
// Driven by FAKE stitches — no engine, no network.
import { stitchQueryOptions, useStitch, useStitchStream } from '../src';

import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';
import { type EffectScope, effectScope, ref } from 'vue';

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

// Run `body` inside a disposable reactive scope so `onScopeDispose` fires on
// teardown, exactly as a component unmount would drive it.
function withScope<R>(body: () => R): { result: R; scope: EffectScope } {
    const scope = effectScope();
    const result = scope.run(body) as R;
    return { result, scope };
}

// Let queued microtasks (the fake's resolved promises + the store's sync
// publishes) drain. A handful of turns covers an async generator's per-yield
// awaits.
async function flush(turns = 6): Promise<void> {
    for (let i = 0; i < turns; i++) await Promise.resolve();
}

// --- useStitch -------------------------------------------------------------

describe('useStitch', () => {
    test('transitions pending → success', async () => {
        const stitch = unaryStitch(async () => ({ name: 'Ada' }));
        const { result, scope } = withScope(() =>
            useStitch(stitch, { params: { id: '1' } }),
        );

        // The store starts a run synchronously on creation.
        expect(result.isPending.value).toBe(true);
        expect(result.data.value).toBeUndefined();

        await flush();
        expect(result.isSuccess.value).toBe(true);
        expect(result.data.value).toEqual({ name: 'Ada' });
        scope.stop();
    });

    test('transitions to error on rejection', async () => {
        const stitch = unaryStitch<{ name: string }>(async () => {
            throw new Error('nope');
        });
        const { result, scope } = withScope(() => useStitch(stitch, {}));

        await flush();
        expect(result.isError.value).toBe(true);
        expect((result.error.value as Error).message).toBe('nope');
        scope.stop();
    });

    test('refetch re-runs the call', async () => {
        let n = 0;
        const stitch = unaryStitch(async () => ({ name: `v${++n}` }));
        const { result, scope } = withScope(() => useStitch(stitch, {}));

        await flush();
        expect(result.data.value).toEqual({ name: 'v1' });

        result.refetch();
        await flush();
        expect(result.data.value).toEqual({ name: 'v2' });
        scope.stop();
    });

    test('changing input (reactive) re-fetches on a new structural key', async () => {
        const stitch = unaryStitch(async (input) => ({
            name: `id-${(input as { params: { id: string } }).params.id}`,
        }));
        const id = ref('1');
        const { result, scope } = withScope(() =>
            // Getter input so the `watch` on the structural key picks up changes.
            useStitch(stitch, () => ({ params: { id: id.value } })),
        );

        await flush();
        expect(result.data.value).toEqual({ name: 'id-1' });

        id.value = '2';
        await flush(); // let the `watch` callback rebuild + the new run settle
        expect(result.data.value).toEqual({ name: 'id-2' });
        scope.stop();
    });

    test('enabled:false starts idle and only runs on refetch', async () => {
        const stitch = unaryStitch(async () => ({ name: 'lazy' }));
        const { result, scope } = withScope(() =>
            useStitch(stitch, {}, { enabled: false }),
        );

        await flush();
        expect(result.status.value).toBe('idle');
        expect(result.data.value).toBeUndefined();

        result.refetch();
        await flush();
        expect(result.isSuccess.value).toBe(true);
        expect(result.data.value).toEqual({ name: 'lazy' });
        scope.stop();
    });

    test('onScopeDispose tears down: no publish after scope.stop()', async () => {
        // A never-resolving stitch: if teardown leaks, a late resolve would flip
        // state. We stop the scope mid-flight and assert state is frozen.
        let release: (v: { name: string }) => void = () => {};
        const stitch = unaryStitch<{ name: string }>(
            () => new Promise((res) => (release = res)),
        );
        const { result, scope } = withScope(() => useStitch(stitch, {}));

        expect(result.isPending.value).toBe(true);
        scope.stop(); // fires onScopeDispose → destroy()
        release({ name: 'too-late' });
        await flush();
        // destroy() invalidates the run token, so the resolution can't publish.
        expect(result.isPending.value).toBe(true);
        expect(result.data.value).toBeUndefined();
    });

    test('forwards onSuccess to the underlying query', async () => {
        let received: unknown;
        const { scope } = withScope(() =>
            useStitch(
                unaryStitch(async () => ({ id: 7 })),
                {},
                {
                    onSuccess: (d) => {
                        received = d;
                    },
                },
            ),
        );

        await flush();
        expect(received).toEqual({ id: 7 });
        scope.stop();
    });

    test('forwards onError to the underlying query', async () => {
        let received: unknown;
        const boom = new Error('nope');
        const { scope } = withScope(() =>
            useStitch<{ id: number }>(
                unaryStitch(async () => {
                    throw boom;
                }),
                {},
                {
                    onError: (e) => {
                        received = e;
                    },
                },
            ),
        );

        await flush();
        expect(received).toBe(boom);
        scope.stop();
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
        const { result, scope } = withScope(() =>
            useStitchStream(streamStitch(events), undefined),
        );

        // First chunk lands → streaming with [1].
        await flush(2);
        expect(result.isStreaming.value).toBe(true);
        expect(result.chunks.value).toEqual([1]);

        // All chunks accumulate and the stream settles to success. The generator
        // awaits a microtask per yield, so drain generously.
        await flush(12);
        expect(result.chunks.value).toEqual([1, 2, 3]);
        expect(result.isSuccess.value).toBe(true);
        scope.stop();
    });

    test('replace mode keeps only the latest chunk on data', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', data: 20, status: 200, attempts: 1, at: 0 },
        ];
        const { result, scope } = withScope(() =>
            useStitchStream(streamStitch(events), undefined, {
                mode: 'replace',
            }),
        );

        await flush(12);
        expect(result.data.value).toBe(20);
        expect(result.chunks.value).toEqual([]);
        scope.stop();
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
