// redisStore-level behaviour the per-driver conformance proofs don't pin down:
// the keyPrefix mapping (no conformance run uses a prefix), the cache-delete
// (`set(k, undefined)` → DEL), the non-JSON raw-string fallback on get, and
// close() delegation. Driven by a recording RedisDriver that captures every call.
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
        async incr(key, ttl) {
            calls.push(['incr', key, ttl]);
            return 1;
        },
        ...(over.close ? { close: over.close } : {}),
    };
    return { driver, calls, data };
}

describe('redisStore — key mapping', () => {
    test('applies keyPrefix to every key on get / set / incr', async () => {
        const { driver, calls } = recordingDriver();
        const store = redisStore(driver, { keyPrefix: 'app:' });

        await store.set('k', 'v', 1000);
        await store.get('k');
        await store.incr('c', 2000);

        expect(calls).toEqual([
            ['set', 'app:k', JSON.stringify('v'), 1000],
            ['get', 'app:k'],
            ['incr', 'app:c', 2000],
        ]);
    });

    test('uses a flat keyspace (no prefix) by default', async () => {
        const { driver, calls } = recordingDriver();
        await redisStore(driver).set('k', 'v');
        expect(calls[0]).toEqual(['set', 'k', JSON.stringify('v'), undefined]);
    });

    test('an absent ttl passes through as absent on set and incr (no expiry / no window)', async () => {
        const { driver, calls } = recordingDriver();
        const store = redisStore(driver);

        await store.set('k', 'v');
        await store.incr('c');

        expect(calls).toEqual([
            ['set', 'k', JSON.stringify('v'), undefined],
            ['incr', 'c', undefined],
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
        expect(redisStore(driver).close).toBeUndefined();
    });
});
