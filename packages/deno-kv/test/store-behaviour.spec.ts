// Targeted behaviour tests for @stitchapi/deno-kv that the conformance proof
// (`conformance.spec.ts`) does not pin down: the FIXED-window TTL rule (the
// counter's window has an absolute deadline pinned at creation — later increments in
// the same window neither extend nor clear it, and a fresh window restarts at 1),
// the NO-window rule (an increment without a ttl — or with ttl <= 0 — never expires),
// the compare-and-set retry EXHAUSTION error, the array-key shape (flat vs
// prefixed), the cache-delete (`set(k, undefined)`), and `close()` delegation.
// Driven by two fakes: a recording KV that captures every write's `expireIn`, and
// a time-travel KV that faithfully models Deno KV expiry so a window's reset is
// observable (the recording fake never expires anything and so can't see it).
import { denoKvStore } from '../src';
import type {
    DenoAtomicCheck,
    DenoAtomicCommitResult,
    DenoAtomicOperation,
    DenoKvEntryMaybe,
    DenoKvKey,
    DenoKvLike,
} from '../src';

import { afterEach, describe, expect, test, vi } from 'vitest';

interface Recording {
    kv: DenoKvLike;
    sets: { key: DenoKvKey; expireIn: number | undefined }[];
    atomicSets: { key: DenoKvKey; expireIn: number | undefined }[];
    deletes: DenoKvKey[];
    closed: () => boolean;
}

function recordingKv(opts: { failAtomic?: boolean } = {}): Recording {
    const data = new Map<string, { value: unknown; versionstamp: string }>();
    const sets: { key: DenoKvKey; expireIn: number | undefined }[] = [];
    const atomicSets: { key: DenoKvKey; expireIn: number | undefined }[] = [];
    const deletes: DenoKvKey[] = [];
    let seq = 0;
    let closedFlag = false;
    const id = (key: DenoKvKey): string => JSON.stringify(key);

    const kv: DenoKvLike = {
        async get(key): Promise<DenoKvEntryMaybe> {
            const e = data.get(id(key));
            return e
                ? { value: e.value, versionstamp: e.versionstamp }
                : { value: null, versionstamp: null };
        },
        async set(key, value, options): Promise<unknown> {
            sets.push({ key, expireIn: options?.expireIn });
            const versionstamp = String(++seq);
            data.set(id(key), { value, versionstamp });
            return { ok: true, versionstamp };
        },
        async delete(key): Promise<void> {
            deletes.push(key);
            data.delete(id(key));
        },
        atomic(): DenoAtomicOperation {
            const checks: DenoAtomicCheck[] = [];
            let write:
                | {
                      key: DenoKvKey;
                      value: unknown;
                      expireIn: number | undefined;
                  }
                | undefined;
            const op: DenoAtomicOperation = {
                check(...c): DenoAtomicOperation {
                    checks.push(...c);
                    return op;
                },
                set(key, value, options): DenoAtomicOperation {
                    write = { key, value, expireIn: options?.expireIn };
                    return op;
                },
                async commit(): Promise<DenoAtomicCommitResult> {
                    if (opts.failAtomic) return { ok: false };
                    for (const c of checks) {
                        const e = data.get(id(c.key));
                        const live = e ? e.versionstamp : null;
                        if (live !== c.versionstamp) return { ok: false };
                    }
                    if (write) {
                        atomicSets.push({
                            key: write.key,
                            expireIn: write.expireIn,
                        });
                        const versionstamp = String(++seq);
                        data.set(id(write.key), {
                            value: write.value,
                            versionstamp,
                        });
                        return { ok: true, versionstamp };
                    }
                    return { ok: true, versionstamp: '' };
                },
            };
            return op;
        },
        close(): void {
            closedFlag = true;
        },
    };
    return { kv, sets, atomicSets, deletes, closed: () => closedFlag };
}

// A faithful, time-travellable Deno KV double. Unlike `recordingKv` it models
// *expiry* exactly the way Deno KV does — which is the whole point of this file:
//   • `set(key, value, { expireIn })` stamps an absolute `expiresAt`; a `set`
//     WITHOUT `expireIn` means the key NEVER expires (`expiresAt = Infinity`).
//     This is the trap: on real Deno KV a bare `set` REPLACES the entry, so it
//     also clears any expiry the entry had — unlike Redis INCR, which keeps it.
//   • a key read at/after `expiresAt` comes back as `{ value: null,
//     versionstamp: null }` (absent), so the next increment sees a fresh window.
//   • `atomic().check(versionstamp).set(...).commit()` is real optimistic CAS.
// Virtual time is driven by vitest's fake timers (`vi.setSystemTime`), so the
// tests never sleep.
function expiryKv(): DenoKvLike {
    interface Cell {
        value: unknown;
        versionstamp: string;
        expiresAt: number;
    }
    const data = new Map<string, Cell>();
    let seq = 0;
    const id = (key: DenoKvKey): string => JSON.stringify(key);
    // Read-through expiry: a cell past its deadline is indistinguishable from an
    // absent key (and is dropped), exactly like Deno KV.
    const live = (key: DenoKvKey): Cell | undefined => {
        const c = data.get(id(key));
        if (!c) return undefined;
        if (c.expiresAt <= Date.now()) {
            data.delete(id(key));
            return undefined;
        }
        return c;
    };
    const write = (
        key: DenoKvKey,
        value: unknown,
        expireIn?: number,
    ): string => {
        const versionstamp = String(++seq);
        // A bare set (no expireIn) => Infinity: the entry is rewritten whole and
        // any prior expiry is gone. This is the behaviour the bug tripped over.
        data.set(id(key), {
            value,
            versionstamp,
            expiresAt: expireIn == null ? Infinity : Date.now() + expireIn,
        });
        return versionstamp;
    };
    return {
        async get(key): Promise<DenoKvEntryMaybe> {
            const c = live(key);
            return c
                ? { value: c.value, versionstamp: c.versionstamp }
                : { value: null, versionstamp: null };
        },
        async set(key, value, options): Promise<unknown> {
            return {
                ok: true,
                versionstamp: write(key, value, options?.expireIn),
            };
        },
        async delete(key): Promise<void> {
            data.delete(id(key));
        },
        atomic(): DenoAtomicOperation {
            const checks: DenoAtomicCheck[] = [];
            let pending:
                | {
                      key: DenoKvKey;
                      value: unknown;
                      expireIn: number | undefined;
                  }
                | undefined;
            const op: DenoAtomicOperation = {
                check(...c): DenoAtomicOperation {
                    checks.push(...c);
                    return op;
                },
                set(key, value, options): DenoAtomicOperation {
                    pending = { key, value, expireIn: options?.expireIn };
                    return op;
                },
                async commit(): Promise<DenoAtomicCommitResult> {
                    for (const c of checks) {
                        const cur = live(c.key)?.versionstamp ?? null;
                        if (cur !== c.versionstamp) return { ok: false };
                    }
                    if (!pending) return { ok: true, versionstamp: '' };
                    const versionstamp = write(
                        pending.key,
                        pending.value,
                        pending.expireIn,
                    );
                    return { ok: true, versionstamp };
                },
            };
            return op;
        },
    };
}

describe('denoKvStore — increment TTL window', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('a fixed window RESETS: after the ttl elapses the next increment restarts at 1', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const store = denoKvStore(expiryKv());
        const ttl = 200;

        // Two increments inside one window — the counter must not be permanent.
        expect(await store.increment('rate', ttl)).toBe(1);
        expect(await store.increment('rate', ttl)).toBe(2);

        // Advance past the window's absolute deadline (pinned at the FIRST increment).
        vi.setSystemTime(ttl + 1);

        // The window expired, so the counter starts over. Under the TTL-clearing
        // bug the 2nd increment wiped the expiry, the key never expired, and this
        // returned 3 (an ever-growing permanent counter — the rate limit never
        // reset). It must be 1.
        expect(await store.increment('rate', ttl)).toBe(1);
    });

    test('within one window increments accumulate (1, 2, 3) without any early reset', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const store = denoKvStore(expiryKv());
        const ttl = 1000;

        expect(await store.increment('rate', ttl)).toBe(1);
        // Time advances but stays INSIDE the window — no reset, no extension.
        vi.setSystemTime(400);
        expect(await store.increment('rate', ttl)).toBe(2);
        vi.setSystemTime(900);
        expect(await store.increment('rate', ttl)).toBe(3);
    });

    test('the window deadline is FIXED, not sliding: later increments never push it out', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const store = denoKvStore(expiryKv());
        const ttl = 200;

        expect(await store.increment('rate', ttl)).toBe(1); // deadline pinned at 200
        vi.setSystemTime(150);
        expect(await store.increment('rate', ttl)).toBe(2); // must NOT reset to t=350
        // Cross the ORIGINAL deadline. A sliding window would still be alive here
        // (150 + 200 = 350); a fixed window has already expired at 200.
        vi.setSystemTime(210);
        expect(await store.increment('rate', ttl)).toBe(1);
    });

    test('every commit carries a positive expireIn so the window can always expire', async () => {
        // The TTL-clearing bug attached `expireIn` only to the creating commit and
        // left every later commit with `undefined` (no expiry). Assert instead
        // that EVERY commit expires the key — the window is never left permanent.
        const rec = recordingKv();
        const store = denoKvStore(rec.kv);

        expect(await store.increment('rate', 1000)).toBe(1);
        expect(await store.increment('rate', 1000)).toBe(2);
        expect(await store.increment('rate', 1000)).toBe(3);

        // No `undefined` — the entry never loses its expiry on a later write.
        for (const s of rec.atomicSets) {
            expect(s.expireIn).toBeTypeOf('number');
            expect(s.expireIn as number).toBeGreaterThan(0);
        }
        expect(rec.atomicSets).toHaveLength(3);
    });

    test('a legacy bare-number counter (pre-upgrade value) self-heals into a fresh window', async () => {
        // On a deploy transition an old value could be a bare number with no
        // window envelope. The store must treat it as a fresh window rather than
        // crash or read NaN — increment returns 1 and the value is now well-formed.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const kv = expiryKv();
        await kv.set(['legacy'], 7); // an old bare counter, no deadline
        const store = denoKvStore(kv);

        expect(await store.increment('legacy', 200)).toBe(1);
        expect(await store.increment('legacy', 200)).toBe(2);
    });

    test('throws after exhausting retry.attempts lost compare-and-set races', async () => {
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, { retry: { attempts: 3 } });
        // `attempts` is the TOTAL including the first, so 3 means 3 reads, not 4.
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 3 compare-and-set races/,
        );
    });

    test('a bare number is the attempts shorthand (retry: 3 ≡ { attempts: 3 })', async () => {
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, { retry: 3 });
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 3 compare-and-set races/,
        );
    });

    test('the default budget is 100 attempts', async () => {
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv);
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 100 compare-and-set races/,
        );
    });

    test('no backoff by default: the loop re-reads with no timer in between', async () => {
        // With a curve unset the retry path must never touch `setTimeout` — a hot
        // re-read is the tightest path to a win when contention is brief, and it is
        // what keeps this loop usable under fake timers.
        const spy = vi.spyOn(globalThis, 'setTimeout');
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, { retry: 4 });
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 4 compare-and-set races/,
        );
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('a fixed curve sleeps baseDelay between attempts, but not after the last', async () => {
        const delays: number[] = [];
        const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
            fn: () => void,
            ms?: number,
        ) => {
            delays.push(ms ?? 0);
            fn();
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout);
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, {
            retry: { attempts: 4, backoff: 'fixed', baseDelay: '20ms' },
        });
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 4 compare-and-set races/,
        );
        // 4 attempts → 3 gaps; the delay after the final loss would only stall the throw.
        expect(delays).toEqual([20, 20, 20]);
        spy.mockRestore();
    });

    test('an expo curve doubles and clamps at maxDelay', async () => {
        const delays: number[] = [];
        const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
            fn: () => void,
            ms?: number,
        ) => {
            delays.push(ms ?? 0);
            fn();
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout);
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, {
            retry: {
                attempts: 5,
                backoff: 'expo',
                baseDelay: 10,
                maxDelay: 30,
            },
        });
        await expect(store.increment('x', 1000)).rejects.toThrow(
            /lost 5 compare-and-set races/,
        );
        expect(delays).toEqual([10, 20, 30, 30]);
        spy.mockRestore();
    });

    test('the empty object is a compile error (P20), the envelope needs a field', () => {
        // @ts-expect-error `{}` must not satisfy AtLeastOne<DenoKvRetryOptions>
        denoKvStore(recordingKv().kv, { retry: {} });
    });
});

describe('denoKvStore — increment without a window', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('absent ttl = no window: the counter accumulates and never expires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const store = denoKvStore(expiryKv());

        expect(await store.increment('count')).toBe(1);
        // Arbitrarily far in the future — a windowless counter never resets.
        vi.setSystemTime(1_000_000_000);
        expect(await store.increment('count')).toBe(2);
        expect(await store.increment('count')).toBe(3);
        // `get` unwraps the envelope to the plain count, windowed or not.
        expect(await store.get('count')).toBe(3);
    });

    test('ttl <= 0 unifies with absent: no window, and no commit carries an expireIn', async () => {
        const rec = recordingKv();
        const store = denoKvStore(rec.kv);

        expect(await store.increment('count')).toBe(1);
        expect(await store.increment('count', 0)).toBe(2);
        expect(await store.increment('count', -5)).toBe(3);

        // A windowless counter is written WITHOUT an expiry, matching `set`'s
        // no-TTL path — the key must never silently gain a window.
        expect(rec.atomicSets).toHaveLength(3);
        for (const s of rec.atomicSets) expect(s.expireIn).toBeUndefined();
    });

    test('a live windowless counter keeps counting even when a later increment passes a ttl', async () => {
        // Mirrors memoryStore: a LIVE counter keeps its original (absent) window;
        // a later ttl neither expires it nor resets the count.
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const store = denoKvStore(expiryKv());

        expect(await store.increment('count')).toBe(1); // windowless
        expect(await store.increment('count', 200)).toBe(2); // ttl ignored — still live
        vi.setSystemTime(500); // past the ttl that was ignored
        expect(await store.increment('count')).toBe(3);
    });
});

describe('denoKvStore — keys & lifecycle', () => {
    test('maps a string key to a flat one-segment array key by default', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv).set('k', 'v');
        expect(rec.sets[0]?.key).toEqual(['k']);
    });

    test('keyPrefix maps a string key to a two-segment array key', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv, { keyPrefix: 'app' }).set('k', 'v');
        expect(rec.sets[0]?.key).toEqual(['app', 'k']);
    });

    test('set(key, undefined) deletes the key (cache delete) and writes nothing', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv).set('k', undefined);
        expect(rec.deletes).toEqual([['k']]);
        expect(rec.sets).toHaveLength(0);
    });

    test('close() delegates to the underlying handle', async () => {
        const rec = recordingKv();
        const store = denoKvStore(rec.kv);
        expect(typeof store.close).toBe('function');
        await store.close?.();
        expect(rec.closed()).toBe(true);
    });
});
