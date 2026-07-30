// @stitchapi/query-core behaviour. Driven by FAKE stitches (plain callables that
// return a `StitchResult`-shaped value) — no engine, no network. We exercise the
// unary lifecycle, cancel/refetch, and the streaming `delta` accumulation.
import {
    createStitchQuery,
    deriveQueryKey,
    keyInputFor,
    nameOf,
    stitchQueryOptions,
} from '../src';
import type { StitchCallResult, StitchLike } from '../src';

import { registerSecretKey } from 'stitchapi';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test, vi } from 'vitest';

// --- fakes -----------------------------------------------------------------

/** A unary stitch: resolves (or rejects) after a tick, ignoring streaming. */
function unaryStitch<T>(settle: (input: unknown) => Promise<T>): StitchLike<T> {
    return (input?: unknown): StitchCallResult<T> => {
        const promise = settle(input);
        return {
            then: (onf, onr) => promise.then(onf, onr),
            // A unary fake never streams; the store only calls this when `streaming`.
            stream() {
                async function* gen(): AsyncGenerator<StitchEvent<T>> {
                    const value = await promise;
                    yield {
                        type: 'result',
                        data: value,
                        status: 200,
                        attempts: 1,
                        at: 0,
                    };
                }
                return gen();
            },
        };
    };
}

/** A streaming stitch: emits the given events from `.stream()`; `await` resolves
 * to the terminal `result` value (mirrors core's `StitchResult`). */
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
                async function* gen(): AsyncGenerator<StitchEvent<T>> {
                    for (const e of events) {
                        // Yield on a microtask so listeners observe each delta.
                        await Promise.resolve();
                        yield e;
                    }
                }
                return gen();
            },
        };
    };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- unary lifecycle -------------------------------------------------------

describe('unary query lifecycle', () => {
    test('idle never fires when enabled (default): starts pending → success', async () => {
        const stitch = unaryStitch(async () => ({ id: 1 }));
        const q = createStitchQuery(stitch, undefined);

        expect(q.getSnapshot().status).toBe('pending');
        expect(q.getSnapshot().isPending).toBe(true);

        await tick();

        const s = q.getSnapshot();
        expect(s.status).toBe('success');
        expect(s.isSuccess).toBe(true);
        expect(s.isPending).toBe(false);
        expect(s.data).toEqual({ id: 1 });
        expect(s.error).toBeUndefined();
    });

    test('enabled: false stays idle until refetch()', async () => {
        const stitch = unaryStitch(async () => 'hi');
        const q = createStitchQuery(stitch, undefined, { enabled: false });

        expect(q.getSnapshot().status).toBe('idle');
        q.refetch();
        expect(q.getSnapshot().status).toBe('pending');
        await tick();
        expect(q.getSnapshot().status).toBe('success');
        expect(q.getSnapshot().data).toBe('hi');
    });

    test('a rejecting stitch lands on error with the thrown reason', async () => {
        const boom = new Error('boom');
        const stitch = unaryStitch(async () => {
            throw boom;
        });
        const q = createStitchQuery(stitch, undefined);

        await tick();
        const s = q.getSnapshot();
        expect(s.status).toBe('error');
        expect(s.isError).toBe(true);
        expect(s.error).toBe(boom);
        expect(s.data).toBeUndefined();
    });

    test('subscribe is notified on every transition; unsubscribe stops it', async () => {
        const stitch = unaryStitch(async () => 42);
        const q = createStitchQuery(stitch, undefined, { enabled: false });

        const listener = vi.fn();
        const off = q.subscribe(listener);

        q.refetch(); // pending
        await tick(); // success
        expect(listener).toHaveBeenCalled();
        const callsWhileSubscribed = listener.mock.calls.length;

        off();
        q.refetch();
        await tick();
        expect(listener.mock.calls.length).toBe(callsWhileSubscribed);
    });

    test('the input argument is forwarded to the call', async () => {
        const seen: unknown[] = [];
        const stitch = unaryStitch(async (input) => {
            seen.push(input);
            return 'ok';
        });
        createStitchQuery(stitch, { body: { name: 'a' } });
        await tick();
        expect(seen).toEqual([{ body: { name: 'a' } }]);
    });
});

// --- snapshot identity -----------------------------------------------------

describe('snapshot identity', () => {
    test('getSnapshot returns a stable reference between real changes', async () => {
        const stitch = unaryStitch(async () => 1);
        const q = createStitchQuery(stitch, undefined);
        const a = q.getSnapshot();
        const b = q.getSnapshot();
        expect(a).toBe(b); // identical until the next transition
        await tick();
        const c = q.getSnapshot();
        expect(c).not.toBe(a);
        expect(q.getSnapshot()).toBe(c); // stable again
    });
});

// --- cancel ----------------------------------------------------------------

describe('cancel()', () => {
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
        const q = createStitchQuery(stitch, undefined);
        expect(q.getSnapshot().status).toBe('pending');

        q.cancel();
        // Now resolve the underlying promise — it must be ignored.
        resolveIt('late');
        await tick();
        expect(q.getSnapshot().status).toBe('pending'); // never advanced to success
        expect(q.getSnapshot().data).toBeUndefined();
    });

    test('cancel passes an AbortController signal that the call can observe', async () => {
        // The store aborts its controller on cancel; a real stitch reads it via
        // its own signal. We can at least assert the run was invalidated.
        const stitch = unaryStitch(async () => 'v');
        const q = createStitchQuery(stitch, undefined, { enabled: false });
        q.refetch();
        q.cancel();
        await tick();
        // The cancelled run never reaches success.
        expect(q.getSnapshot().status).toBe('pending');
    });
});

// --- refetch ---------------------------------------------------------------

describe('refetch()', () => {
    test('refetch re-runs the call', async () => {
        let n = 0;
        const stitch = unaryStitch(async () => ++n);
        const q = createStitchQuery(stitch, undefined);
        await tick();
        expect(q.getSnapshot().data).toBe(1);

        q.refetch();
        expect(q.getSnapshot().status).toBe('pending');
        await tick();
        expect(q.getSnapshot().data).toBe(2);
    });

    test('a fast refetch supersedes an in-flight slow run (no stale overwrite)', async () => {
        const resolvers: Array<(v: number) => void> = [];
        const stitch: StitchLike<number> = () => {
            const promise = new Promise<number>((res) => resolvers.push(res));
            return {
                then: (onf, onr) => promise.then(onf, onr),
                stream() {
                    return (async function* () {})() as never;
                },
            };
        };
        const q = createStitchQuery(stitch, undefined); // run #1
        q.refetch(); // run #2

        // Resolve the FIRST (now-superseded) run last — it must not publish.
        resolvers[1]?.(2);
        await tick();
        expect(q.getSnapshot().data).toBe(2);
        resolvers[0]?.(1);
        await tick();
        expect(q.getSnapshot().data).toBe(2); // run #1's late value ignored
    });
});

// --- streaming -------------------------------------------------------------

describe('streaming query', () => {
    const deltas = (n: number[]): StitchEvent<number[]>[] =>
        n.map((chunk) => ({ type: 'delta', chunk, at: 0 }));

    test('append mode accumulates chunks and ends on the result value', async () => {
        const events: StitchEvent<number[]>[] = [
            ...deltas([1, 2, 3]),
            {
                type: 'result',
                data: [1, 2, 3],
                status: 200,
                attempts: 1,
                at: 0,
            },
            { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
        ];
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
        });

        const seen: number[][] = [];
        q.subscribe(() => {
            const d = q.getSnapshot().data;
            if (Array.isArray(d)) seen.push(d as number[]);
        });

        // Drain all microtasks/macrotasks.
        await new Promise((r) => setTimeout(r, 10));

        const s = q.getSnapshot();
        expect(s.status).toBe('success');
        expect(s.data).toEqual([1, 2, 3]);
        expect(s.chunks).toEqual([1, 2, 3]);
        // We re-rendered as chunks arrived (the streaming differentiator).
        expect(seen).toContainEqual([1]);
        expect(seen).toContainEqual([1, 2]);
        expect(seen).toContainEqual([1, 2, 3]);
    });

    test('replace mode keeps only the latest chunk as data', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 10, at: 0 },
            { type: 'delta', chunk: 20, at: 0 },
            { type: 'result', data: 20, status: 200, attempts: 1, at: 0 },
        ];
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
            mode: 'replace',
        });
        await new Promise((r) => setTimeout(r, 10));
        const s = q.getSnapshot();
        expect(s.data).toBe(20);
        expect(s.chunks).toEqual([]);
        expect(s.status).toBe('success');
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
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
        });
        await new Promise((r) => setTimeout(r, 10));
        const s = q.getSnapshot();
        expect(s.status).toBe('error');
        expect((s.error as Error).message).toBe('mid-stream failure');
    });

    test('streaming passes through status streaming before success', async () => {
        const events: StitchEvent<number>[] = [
            { type: 'delta', chunk: 1, at: 0 },
            { type: 'result', data: 99, status: 200, attempts: 1, at: 0 },
        ];
        const statuses: string[] = [];
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
            mode: 'replace',
        });
        q.subscribe(() => statuses.push(q.getSnapshot().status));
        await new Promise((r) => setTimeout(r, 10));
        expect(statuses).toContain('streaming');
        expect(q.getSnapshot().status).toBe('success');
    });
});

// --- destroy ---------------------------------------------------------------

describe('destroy()', () => {
    test('destroy drops listeners and ignores a late resolution', async () => {
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
        const q = createStitchQuery(stitch, undefined);
        const listener = vi.fn();
        q.subscribe(listener);
        q.destroy();
        resolveIt('late');
        await tick();
        expect(listener).not.toHaveBeenCalled();
    });
});

// --- lifecycle callbacks ---------------------------------------------------

describe('onSuccess / onError callbacks', () => {
    test('unary onSuccess fires once with the resolved value', async () => {
        const onSuccess = vi.fn();
        const q = createStitchQuery(
            unaryStitch(async () => ({ id: 1 })),
            undefined,
            { onSuccess },
        );
        await tick();
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledWith({ id: 1 });
        q.destroy();
    });

    test('unary onError fires with the thrown reason', async () => {
        const onError = vi.fn();
        const boom = new Error('nope');
        const q = createStitchQuery(
            unaryStitch(async () => {
                throw boom;
            }),
            undefined,
            { onError },
        );
        await tick();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(boom);
        q.destroy();
    });

    test('streaming onSuccess fires with the terminal result value', async () => {
        const onSuccess = vi.fn();
        const events: StitchEvent<string>[] = [
            { type: 'delta', chunk: 'a', at: 0 },
            { type: 'result', data: 'final', status: 200, attempts: 1, at: 0 },
        ];
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
            onSuccess,
        });
        await tick();
        expect(onSuccess).toHaveBeenCalledWith('final');
        q.destroy();
    });

    test('streaming onError fires with an Error carrying the event message', async () => {
        const onError = vi.fn();
        const events: StitchEvent<string>[] = [
            { type: 'delta', chunk: 'a', at: 0 },
            {
                type: 'error',
                name: 'StitchError',
                message: 'stream failed',
                attempts: 1,
                at: 0,
            },
        ];
        const q = createStitchQuery(streamStitch(events), undefined, {
            streaming: true,
            onError,
        });
        await tick();
        expect(onError).toHaveBeenCalledTimes(1);
        const reason = onError.mock.calls[0]?.[0];
        expect(reason).toBeInstanceOf(Error);
        expect((reason as Error).message).toBe('stream failed');
        q.destroy();
    });

    test('a cancelled run does not fire onSuccess (the run-token guard covers callbacks)', async () => {
        const onSuccess = vi.fn();
        const q = createStitchQuery(
            unaryStitch(async () => ({ id: 1 })),
            undefined,
            { onSuccess },
        );
        q.cancel(); // invalidate before the microtask resolves
        await tick();
        expect(onSuccess).not.toHaveBeenCalled();
        q.destroy();
    });
});

// --- key derivation (the one shared implementation behind every binding) ----

describe('nameOf()', () => {
    const withConfig = (cfg: Record<string, unknown>): StitchLike<string> =>
        Object.assign(
            unaryStitch<string>(async () => 'x'),
            { __config: cfg },
        );

    test('prefers name, then path, then url, then the literal fallback', () => {
        expect(nameOf(withConfig({ name: 'getUser', path: '/u/{id}' }))).toBe(
            'getUser',
        );
        expect(nameOf(withConfig({ path: '/users/{id}' }))).toBe('/users/{id}');
        expect(nameOf(withConfig({ url: 'https://x.dev/feed' }))).toBe(
            'https://x.dev/feed',
        );
        expect(nameOf(withConfig({}))).toBe('stitch');
    });

    test('a bare callable without __config falls back to the literal', () => {
        expect(nameOf(unaryStitch(async () => 1))).toBe('stitch');
    });
});

describe('keyInputFor()', () => {
    test('null / undefined stay null; primitives pass through', () => {
        expect(keyInputFor(null)).toBeNull();
        expect(keyInputFor(undefined)).toBeNull();
        expect(keyInputFor(7)).toBe(7);
        expect(keyInputFor('q')).toBe('q');
    });

    test('drops runtime-only signal / onProgress, keeps everything else', () => {
        const out = keyInputFor({
            params: { id: '1' },
            signal: new AbortController().signal,
            onProgress: () => {},
        });
        expect(out).toEqual({ params: { id: '1' } });
    });

    test('redacts secret header VALUES but keeps benign headers varying the key', () => {
        const out = keyInputFor({
            headers: {
                Authorization: 'Bearer tok',
                'x-csrf-token': 'abc',
                'x-goog-api-key': 'k',
                'accept-language': 'uk',
            },
        }) as { headers: Record<string, unknown> };
        expect(out.headers['Authorization']).toBe('[redacted]');
        expect(out.headers['x-csrf-token']).toBe('[redacted]');
        expect(out.headers['x-goog-api-key']).toBe('[redacted]');
        expect(out.headers['accept-language']).toBe('uk');
    });

    test("reuses core's isSecretKey: registerSecretKey widens header redaction", () => {
        registerSecretKey('x-querycore-spec-credential');
        const out = keyInputFor({
            headers: { 'x-querycore-spec-credential': 'v' },
        }) as { headers: Record<string, unknown> };
        expect(out.headers['x-querycore-spec-credential']).toBe('[redacted]');
    });
});

describe('deriveQueryKey() / stitchQueryOptions()', () => {
    test('the key is [name, sanitised input]', () => {
        const stitch = Object.assign(
            unaryStitch<string>(async () => 'x'),
            { __config: { path: '/users/{id}' } },
        );
        expect(
            deriveQueryKey(stitch, {
                params: { id: '1' },
                headers: { authorization: 'Bearer t' },
            }),
        ).toEqual([
            '/users/{id}',
            { params: { id: '1' }, headers: { authorization: '[redacted]' } },
        ]);
    });

    test('stitchQueryOptions returns the derived key and an awaiting queryFn', async () => {
        const stitch = Object.assign(
            unaryStitch(async (input) => ({ echoed: input })),
            { __config: { name: 'echo' } },
        );
        const options = stitchQueryOptions(stitch, { body: { a: 1 } });
        expect(options.queryKey).toEqual(['echo', { body: { a: 1 } }]);
        await expect(options.queryFn()).resolves.toEqual({
            echoed: { body: { a: 1 } },
        });
    });
});
