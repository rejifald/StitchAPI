// @stitchapi/angular behaviour, driven inside Angular's TestBed injection context
// in a jsdom env. Driven by FAKE stitches — no engine, no network. Each binding is
// created in `TestBed.runInInjectionContext`, and the module is reset between tests
// to exercise context teardown.
import { injectStitch, injectStitchStream, queryOptions } from '../src';

import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { StitchCallResult, StitchLike } from '@stitchapi/query-core';
import type { StitchEvent } from 'stitchapi';
import { afterEach, describe, expect, test } from 'vitest';

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
                        await Promise.resolve();
                        yield e;
                    }
                })();
            },
        };
    };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

/** Run a factory in the TestBed injection context. */
function run<T>(fn: () => T): T {
    return TestBed.runInInjectionContext(fn);
}

/** Flush Angular's effect queue (so a signal-driven `toObservable` re-emits). */
function flush(): void {
    TestBed.inject(ApplicationRef).tick();
}

afterEach(() => {
    TestBed.resetTestingModule();
});

// --- injectStitch (unary) --------------------------------------------------

describe('injectStitch', () => {
    test('moves pending → success across the signals', async () => {
        const stitch = unaryStitch(async () => ({ name: 'Ada' }));
        const result = run(() => injectStitch(stitch, { params: { id: '1' } }));

        expect(result.status()).toBe('pending');
        expect(result.isPending()).toBe(true);

        await tick();
        expect(result.status()).toBe('success');
        expect(result.isSuccess()).toBe(true);
        expect(result.data()).toEqual({ name: 'Ada' });
    });

    test('lands on error with the thrown reason', async () => {
        const boom = new Error('nope');
        const stitch = unaryStitch<{ name: string }>(async () => {
            throw boom;
        });
        const result = run(() => injectStitch(stitch, {}));

        await tick();
        expect(result.status()).toBe('error');
        expect(result.isError()).toBe(true);
        expect(result.error()).toBe(boom);
    });

    test('refetch re-runs the call', async () => {
        let n = 0;
        const stitch = unaryStitch(async () => ({ name: `v${++n}` }));
        const result = run(() => injectStitch(stitch, {}));

        await tick();
        expect(result.data()).toEqual({ name: 'v1' });

        result.refetch();
        expect(result.status()).toBe('pending');
        await tick();
        expect(result.data()).toEqual({ name: 'v2' });
    });

    test('a reactive signal input recreates the handle and re-fetches', async () => {
        const stitch = unaryStitch(async (input) => ({
            name: `id-${(input as { params: { id: string } }).params.id}`,
        }));
        const id = signal('1');
        const result = run(() =>
            injectStitch(stitch, () => ({ params: { id: id() } })),
        );

        await tick();
        expect(result.data()).toEqual({ name: 'id-1' });

        id.set('2');
        flush(); // let the input signal's toObservable re-emit
        await tick();
        expect(result.data()).toEqual({ name: 'id-2' });
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
        const result = run(() => injectStitch(stitch, undefined));
        expect(result.status()).toBe('pending');

        result.cancel();
        resolveIt('late');
        await tick();
        expect(result.status()).toBe('pending'); // never advanced
        expect(result.data()).toBeUndefined();
    });

    test('enabled:false starts idle and only runs on refetch', async () => {
        const stitch = unaryStitch(async () => ({ name: 'lazy' }));
        const result = run(() => injectStitch(stitch, {}, { enabled: false }));

        await tick();
        expect(result.status()).toBe('idle');
        expect(result.data()).toBeUndefined();

        result.refetch();
        await tick();
        expect(result.isSuccess()).toBe(true);
        expect(result.data()).toEqual({ name: 'lazy' });
    });

    test('forwards onSuccess to the underlying query', async () => {
        let received: unknown;
        run(() =>
            injectStitch(
                unaryStitch(async () => ({ id: 7 })),
                {},
                {
                    onSuccess: (d) => {
                        received = d;
                    },
                },
            ),
        );

        await tick();
        expect(received).toEqual({ id: 7 });
    });

    test('forwards onError to the underlying query', async () => {
        let received: unknown;
        const boom = new Error('nope');
        run(() =>
            injectStitch<{ id: number }>(
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

        await tick();
        expect(received).toBe(boom);
    });
});

// --- injectStitchStream ----------------------------------------------------

describe('injectStitchStream', () => {
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
        const result = run(() =>
            injectStitchStream(streamStitch(events), undefined),
        );

        await drain();
        expect(result.status()).toBe('success');
        expect(result.chunks()).toEqual([1, 2, 3]);
        expect(result.data()).toEqual([1, 2, 3]);
    });

    test('replace mode keeps only the latest chunk as data', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', value: 20, status: 200, attempts: 1, at: 0 },
        ];
        const result = run(() =>
            injectStitchStream(streamStitch(events), undefined, {
                mode: 'replace',
            }),
        );
        await drain();
        expect(result.data()).toBe(20);
        expect(result.chunks()).toEqual([]);
        expect(result.status()).toBe('success');
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
        const result = run(() =>
            injectStitchStream(streamStitch(events), undefined),
        );
        await drain();
        expect(result.status()).toBe('error');
        expect((result.error() as Error).message).toBe('mid-stream failure');
    });
});

// --- the observable surface ------------------------------------------------

describe('state$', () => {
    test('emits the same snapshots as the signals (one shared execution)', async () => {
        const stitch = unaryStitch(async () => ({ ok: true }));
        const result = run(() => injectStitch(stitch, {}));

        const statuses: string[] = [];
        const sub = result.state$.subscribe((s) => statuses.push(s.status));

        await tick();
        expect(statuses).toContain('success');
        // The observable mirrors the signal — same terminal state.
        expect(result.isSuccess()).toBe(true);
        sub.unsubscribe();
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
