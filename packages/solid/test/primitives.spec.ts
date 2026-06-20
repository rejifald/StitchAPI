// @stitchapi/solid primitive behaviour, driven inside Solid's reactive scope in a
// node env (no DOM). Driven by FAKE stitches — no engine, no network. We wrap each
// assertion run in `createRoot` so the effects/cleanups have an owner, and dispose
// it to exercise teardown.
import {
    type StitchStore,
    createStitch,
    createStitchStream,
    queryOptions,
} from '../src';

import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import { createEffect, createRoot, createSignal } from 'solid-js';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';

// --- fakes -----------------------------------------------------------------

/** A unary stitch: resolves (or rejects) after a tick, ignoring streaming. */
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

/** A streaming stitch: emits the given events from `.stream()`; `await` resolves
 * to the terminal `result` value (mirrors core's `StitchResult`). */
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
                        // Yield on a microtask so listeners observe each delta.
                        await Promise.resolve();
                        yield e;
                    }
                })();
            },
        };
    };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** Run `fn` inside a Solid root and return a `dispose` to tear it down. */
function root<T>(fn: () => T): { value: T; dispose: () => void } {
    let value!: T;
    let dispose!: () => void;
    createRoot((d) => {
        dispose = d;
        value = fn();
    });
    return { value, dispose };
}

// --- createStitch (unary) --------------------------------------------------

describe('createStitch', () => {
    test('reconciles pending → success into the store', async () => {
        const stitch = unaryStitch(async () => ({ name: 'Ada' }));
        const { value: store, dispose } = root(() =>
            createStitch(stitch, { params: { id: '1' } }),
        );

        expect(store.state.status).toBe('pending');
        expect(store.state.isPending).toBe(true);

        await tick();
        expect(store.state.status).toBe('success');
        expect(store.state.isSuccess).toBe(true);
        expect(store.state.data).toEqual({ name: 'Ada' });
        dispose();
    });

    test('lands on error with the thrown reason', async () => {
        const boom = new Error('nope');
        const stitch = unaryStitch<{ name: string }>(async () => {
            throw boom;
        });
        const { value: store, dispose } = root(() => createStitch(stitch, {}));

        await tick();
        expect(store.state.status).toBe('error');
        expect(store.state.isError).toBe(true);
        expect(store.state.error).toBe(boom);
        dispose();
    });

    test('refetch re-runs the call', async () => {
        let n = 0;
        const stitch = unaryStitch(async () => ({ name: `v${++n}` }));
        const { value: store, dispose } = root(() => createStitch(stitch, {}));

        await tick();
        expect(store.state.data).toEqual({ name: 'v1' });

        store.refetch();
        expect(store.state.status).toBe('pending');
        await tick();
        expect(store.state.data).toEqual({ name: 'v2' });
        dispose();
    });

    test('a reactive input accessor recreates the handle and re-fetches', async () => {
        const stitch = unaryStitch(async (input) => ({
            name: `id-${(input as { params: { id: string } }).params.id}`,
        }));

        let store!: StitchStore<{ name: string }>;
        let setId!: (v: string) => void;
        const dispose = createRoot((d) => {
            const [id, set] = createSignal('1');
            setId = set;
            store = createStitch(stitch, () => ({ params: { id: id() } }));
            return d;
        });

        await tick();
        expect(store.state.data).toEqual({ name: 'id-1' });

        setId('2');
        await tick();
        expect(store.state.data).toEqual({ name: 'id-2' });
        dispose();
    });

    test('cancel aborts the run: a late resolution does not publish success', async () => {
        let resolveIt: (v: string) => void = () => {};
        const stitch: StitchLike<string> = () => {
            const promise = new Promise<string>((res) => {
                resolveIt = res;
            });
            return {
                then: (onf, onr) => promise.then(onf, onr),
                stream() {
                    return (async function* () {})() as never;
                },
            };
        };
        const { value: store, dispose } = root(() =>
            createStitch(stitch, undefined),
        );
        expect(store.state.status).toBe('pending');

        store.cancel();
        resolveIt('late');
        await tick();
        expect(store.state.status).toBe('pending'); // never advanced
        expect(store.state.data).toBeUndefined();
        dispose();
    });

    test('disposing the root tears down the run (no publish after dispose)', async () => {
        let resolveIt: (v: string) => void = () => {};
        const stitch: StitchLike<string> = () => {
            const promise = new Promise<string>((res) => {
                resolveIt = res;
            });
            return {
                then: (onf, onr) => promise.then(onf, onr),
                stream() {
                    return (async function* () {})() as never;
                },
            };
        };
        const { value: store, dispose } = root(() =>
            createStitch(stitch, undefined),
        );
        dispose();
        resolveIt('late');
        await tick();
        // The destroyed handle's late resolution is dropped — still pending.
        expect(store.state.status).toBe('pending');
        expect(store.state.data).toBeUndefined();
    });
});

// --- createStitchStream ----------------------------------------------------

describe('createStitchStream', () => {
    test('reconciles delta chunks as they arrive, then settles success', async () => {
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
        const { value: store, dispose } = root(() =>
            createStitchStream(streamStitch(events), undefined),
        );

        await drain();
        expect(store.state.status).toBe('success');
        expect(store.state.chunks).toEqual([1, 2, 3]);
        expect(store.state.data).toEqual([1, 2, 3]);
        dispose();
    });

    test('passes through streaming before success', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 1, at: 0 },
            { type: 'result', value: 99, status: 200, attempts: 1, at: 0 },
        ];
        const statuses: string[] = [];
        const dispose = createRoot((d) => {
            const store = createStitchStream(streamStitch(events), undefined, {
                mode: 'replace',
            });
            // Track the status reactively: an effect re-runs on each reconcile.
            createEffect(() => statuses.push(store.state.status));
            return d;
        });
        await drain();
        expect(statuses).toContain('streaming');
        expect(statuses).toContain('success');
        dispose();
    });

    test('replace mode keeps only the latest chunk as data', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', value: 20, status: 200, attempts: 1, at: 0 },
        ];
        const { value: store, dispose } = root(() =>
            createStitchStream(streamStitch(events), undefined, {
                mode: 'replace',
            }),
        );
        await drain();
        expect(store.state.data).toBe(20);
        expect(store.state.chunks).toEqual([]);
        expect(store.state.status).toBe('success');
        dispose();
    });

    test('a streamed error event lands on error status', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 1, at: 0 },
            {
                type: 'error',
                name: 'StitchError',
                message: 'mid-stream failure',
                attempts: 1,
                at: 0,
            },
        ];
        const { value: store, dispose } = root(() =>
            createStitchStream(streamStitch(events), undefined),
        );
        await drain();
        expect(store.state.status).toBe('error');
        expect((store.state.error as Error).message).toBe('mid-stream failure');
        dispose();
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
