// asyncStorageStore conformance + the AsyncStorage-specific behaviours (TTL via a
// JSON envelope, serialized atomic incr) the generic contract can't express
// deterministically.
import { asyncStorageStore } from '../src/store';
import type { AsyncStorageLike } from '../src/store';

import { assertConformance, verifyStoreContract } from 'stitchapi/testing';
import { describe, expect, test } from 'vitest';

// A Map-backed AsyncStorage double with async resolution, so concurrent `incr`
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
        assertConformance(
            await verifyStoreContract(() =>
                asyncStorageStore(fakeAsyncStorage()),
            ),
        );
    });

    test('expires a TTL entry against an injected clock', async () => {
        let t = 1000;
        const store = asyncStorageStore(fakeAsyncStorage(), { now: () => t });
        await store.set('k', 'v', 100);
        expect(await store.get('k')).toBe('v');
        t = 1101; // past expiry
        expect(await store.get('k')).toBeUndefined();
    });

    test('a non-TTL entry never expires', async () => {
        let t = 0;
        const store = asyncStorageStore(fakeAsyncStorage(), { now: () => t });
        await store.set('k', 'v');
        t = 10_000_000;
        expect(await store.get('k')).toBe('v');
    });

    test('incr resets to 1 once its TTL window lapses', async () => {
        let t = 0;
        const store = asyncStorageStore(fakeAsyncStorage(), { now: () => t });
        expect(await store.incr('c', 100)).toBe(1);
        expect(await store.incr('c', 100)).toBe(2);
        t = 200; // window lapsed
        expect(await store.incr('c', 100)).toBe(1);
    });

    test('concurrent incr stays atomic', async () => {
        const store = asyncStorageStore(fakeAsyncStorage());
        const results = await Promise.all(
            Array.from({ length: 20 }, () => store.incr('n', 60_000)),
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
