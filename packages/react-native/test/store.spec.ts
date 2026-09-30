// asyncStorageStore conformance + the AsyncStorage-specific behaviours (TTL via a
// JSON envelope, serialized atomic increment) the generic contract can't express
// deterministically.
//
// Time is driven through the store's `clock` seam with core's own `manualClock()` —
// the same object that drives a stitch's retry backoff. That is the point of the
// seam being a `Clock` rather than a bare `now()` thunk: one fake, one spelling, and
// `advance(ms)` moves the store's TTL the way it moves everything else.
import { asyncStorageStore } from '../src/store';
import type { AsyncStorageLike } from '../src/store';

import { conformance, manualClock } from 'stitchapi/testing';
import { describe, expect, test } from 'vitest';

// A Map-backed AsyncStorage double with async resolution, so concurrent `increment`
// calls genuinely interleave at await points — exercising the store's serializer.
function fakeAsyncStorage(): AsyncStorageLike {
    const map = new Map<string, string>();
    return {
        async getItem(key) {
            const v = map.get(key);
            return v === undefined ? null : v;
        },
        async setItem(key, value) {
            map.set(key, value);
        },
        async removeItem(key) {
            map.delete(key);
        },
    };
}

describe('asyncStorageStore', () => {
    test('satisfies the StitchStore contract', async () => {
        conformance.assert(
            await conformance.store(() =>
                asyncStorageStore(fakeAsyncStorage()),
            ),
        );
    });

    test('a manualClock drives TTL expiry through the `clock` seam', async () => {
        const clock = manualClock(1000);
        const store = asyncStorageStore(fakeAsyncStorage(), { clock });
        await store.set('k', 'v', 100);
        expect(await store.get('k')).toBe('v');
        // Virtual time only — no real waiting, and the wall clock is never read.
        await clock.advance(101);
        expect(await store.get('k')).toBeUndefined();
        // Expiry is evaluated lazily on READ, not armed as a timer: the store asks the
        // clock for `now()` and never calls `setTimer`, so nothing leaks on the fake.
        expect(clock.pending()).toBe(0);
    });

    test('a non-TTL entry never expires', async () => {
        const clock = manualClock();
        const store = asyncStorageStore(fakeAsyncStorage(), { clock });
        await store.set('k', 'v');
        await clock.advance(10_000_000);
        expect(await store.get('k')).toBe('v');
    });

    test('increment without a ttl never expires (no window)', async () => {
        const clock = manualClock();
        const store = asyncStorageStore(fakeAsyncStorage(), { clock });
        expect(await store.increment('c')).toBe(1);
        await clock.advance(10_000_000);
        expect(await store.increment('c')).toBe(2);
    });

    test('increment resets to 1 once its TTL window lapses', async () => {
        const clock = manualClock();
        const store = asyncStorageStore(fakeAsyncStorage(), { clock });
        expect(await store.increment('c', 100)).toBe(1);
        expect(await store.increment('c', 100)).toBe(2);
        await clock.advance(200); // window lapsed
        expect(await store.increment('c', 100)).toBe(1);
    });

    test('the retired `now` thunk is gone — the seam is `clock` (compile-time)', () => {
        // P1: `now` on this contract means an epoch-ms NUMBER (the envelope's expiry is
        // compared against it), so it cannot also name a function. Pinned here because a
        // back-compat alias would make every test above pass while the divergence returns.
        // @ts-expect-error — `now: () => number` was replaced by `clock: Clock`
        void asyncStorageStore(fakeAsyncStorage(), { now: () => 0 });
        expect(true).toBe(true);
    });

    test('concurrent increment stays atomic', async () => {
        const store = asyncStorageStore(fakeAsyncStorage());
        const results = await Promise.all(
            Array.from({ length: 20 }, () => store.increment('n', 60_000)),
        );
        expect(results.sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, i) => i + 1),
        );
    });

    test('honours a custom keyPrefix', async () => {
        const raw = new Map<string, string>();
        const storage: AsyncStorageLike = {
            async getItem(key) {
                const v = raw.get(key);
                return v === undefined ? null : v;
            },
            async setItem(key, value) {
                raw.set(key, value);
            },
            async removeItem(key) {
                raw.delete(key);
            },
        };
        const store = asyncStorageStore(storage, { keyPrefix: 'app/' });
        await store.set('token', 'abc');
        expect([...raw.keys()]).toEqual(['app/token']);
    });
});
