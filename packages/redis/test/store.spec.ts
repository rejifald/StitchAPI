// redisStore-level behaviour the per-driver conformance proofs don't pin down:
// the keyPrefix mapping (no conformance run uses a prefix), the cache-delete
// (`set(k, undefined)` → DEL), the non-JSON raw-string fallback on get, the
// forwarding of the optional semaphore pair, and close() delegation. Driven by a
// recording RedisDriver that captures every call.
import { redisStore } from '../src';
import type { RedisDriver } from '../src';

import { describe, expect, test } from 'vitest';

function recordingDriver(over: { close?: () => Promise<void> } = {}): {
    driver: RedisDriver;
    calls: unknown[][];
    data: Map<string, string>;
} {
    const calls: unknown[][] = [];
    const data = new Map<string, string>();
    const driver: RedisDriver = {
        async get(key) {
            calls.push(['get', key]);
            return data.get(key) ?? null;
        },
        async set(key, value, ttl) {
            calls.push(['set', key, value, ttl]);
            data.set(key, value);
        },
        async delete(key) {
            calls.push(['delete', key]);
            data.delete(key);
        },
        async increment(key, ttl) {
            calls.push(['increment', key, ttl]);
            return 1;
        },
        ...(over.close ? { close: over.close } : {}),
    };
    return { driver, calls, data };
}

/** The same recording driver plus the optional semaphore pair, recorded the same way. */
function leasing(driver: RedisDriver, calls: unknown[][]): RedisDriver {
    return {
        ...driver,
        async lease(key, token, concurrency, ttl, at) {
            calls.push(['lease', key, token, concurrency, ttl, at]);
            return true;
        },
        async release(key, token) {
            calls.push(['release', key, token]);
        },
    };
}

describe('redisStore — key mapping', () => {
    test('applies keyPrefix to every key on get / set / increment', async () => {
        const { driver, calls } = recordingDriver();
        const store = redisStore(driver, { keyPrefix: 'app:' });

        await store.set('k', 'v', 1000);
        await store.get('k');
        await store.increment('c', 2000);

        expect(calls).toEqual([
            ['set', 'app:k', JSON.stringify('v'), 1000],
            ['get', 'app:k'],
            ['increment', 'app:c', 2000],
        ]);
    });

    test('uses a flat keyspace (no prefix) by default', async () => {
        const { driver, calls } = recordingDriver();
        await redisStore(driver).set('k', 'v');
        expect(calls[0]).toEqual(['set', 'k', JSON.stringify('v'), undefined]);
    });

    test('an absent ttl passes through as absent on set and increment (no expiry / no window)', async () => {
        const { driver, calls } = recordingDriver();
        const store = redisStore(driver);

        await store.set('k', 'v');
        await store.increment('c');

        expect(calls).toEqual([
            ['set', 'k', JSON.stringify('v'), undefined],
            ['increment', 'c', undefined],
        ]);
    });
});

describe('redisStore — values & delete', () => {
    test('hands back a non-JSON raw string unchanged (the parse-fallback branch)', async () => {
        const { driver, data } = recordingDriver();
        // A value not written via set() (e.g. some non-envelope string) must not
        // blow up JSON.parse — it comes back raw.
        data.set('weird', 'not-json');
        expect(await redisStore(driver).get('weird')).toBe('not-json');
    });

    test('set(key, undefined) deletes the prefixed key (cache delete) and writes nothing', async () => {
        const { driver, calls } = recordingDriver();
        await redisStore(driver, { keyPrefix: 'app:' }).set('k', undefined);
        expect(calls).toEqual([['delete', 'app:k']]);
    });
});

describe('redisStore — the semaphore pair', () => {
    // The driver spells this pair `lease` / `release` — the SAME words
    // `StitchStore` uses, per contract P18 (a house contract speaks house
    // vocabulary). It was `lease` / `releaseLease`; a driver written against the
    // house spelling would have been silently ignored below, taking `store.lease`
    // down with it, since the pair is forwarded only when BOTH halves are present.
    test('forwards lease / release, prefixing the key on both', async () => {
        const { driver, calls } = recordingDriver();
        const store = redisStore(leasing(driver, calls), {
            keyPrefix: 'app:',
        });

        expect(await store.lease?.('sem', 'tok', 3, 60_000, 1_000)).toBe(true);
        await store.release?.('sem', 'tok');

        expect(calls).toEqual([
            ['lease', 'app:sem', 'tok', 3, 60_000, 1_000],
            ['release', 'app:sem', 'tok'],
        ]);
    });

    test('half a pair is forwarded as neither (a slot could never be given back)', () => {
        const { driver, calls } = recordingDriver();
        const leaseOnly: RedisDriver = {
            ...driver,
            async lease(key, token, concurrency, ttl, at) {
                calls.push(['lease', key, token, concurrency, ttl, at]);
                return true;
            },
        };
        const store = redisStore(leaseOnly);

        expect(typeof store.lease).toBe('undefined');
        expect(typeof store.release).toBe('undefined');
    });

    test('omits the pair when the driver has neither', () => {
        const { driver } = recordingDriver();
        const store = redisStore(driver);
        expect(typeof store.lease).toBe('undefined');
        expect(typeof store.release).toBe('undefined');
    });
});

describe('redisStore — lifecycle', () => {
    test('close() delegates to the driver', async () => {
        let closed = false;
        const { driver } = recordingDriver({
            close: async () => {
                closed = true;
            },
        });
        const store = redisStore(driver);

        expect(typeof store.close).toBe('function');
        await store.close?.();
        expect(closed).toBe(true);
    });

    test('omits close when the driver has none (e.g. Upstash)', () => {
        const { driver } = recordingDriver();
        expect(typeof redisStore(driver).close).toBe('undefined');
    });
});
