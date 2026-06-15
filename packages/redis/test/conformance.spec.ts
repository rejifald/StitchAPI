// Conformance proof for @stitchapi/redis. Both driver adapters (`fromIoredis`,
// `fromNodeRedis`) must pass `verifyStoreContract` from `stitchapi/testing`.
//
// The default run is hermetic and offline: a tiny in-repo Redis engine (a Map
// with PX expiry + the atomic INCR/PEXPIRE the store's Lua performs) wrapped in
// an ioredis-shaped and a node-redis-shaped facade, so each adapter's dialect
// translation is exercised without a server. Single-threaded JS makes the engine
// atomic, which is exactly what the real `EVAL` guarantees — so the contract's
// "20 concurrent incrs net +20" rule holds here and on real Redis alike.
//
// Set REDIS_URL to additionally run the SAME verifier against a live Redis via a
// real ioredis client, proving the atomic INCR+EXPIRE end to end.
import { fromIoredis, fromNodeRedis, redisStore } from '../src';
import type { IoredisLike, NodeRedisLike } from '../src';

import { assertConformance, verifyStoreContract } from 'stitchapi/testing';
import { describe, test } from 'vitest';

// --- a faithful in-memory Redis engine ------------------------------------

interface Entry {
    value: string;
    /** Epoch ms at which the key expires; `Infinity` = no expiry. */
    expiresAt: number;
}

/** The handful of Redis operations the store's two adapters depend on. */
class FakeRedisEngine {
    private readonly data = new Map<string, Entry>();

    private live(key: string): Entry | undefined {
        const e = this.data.get(key);
        if (!e) return undefined;
        if (e.expiresAt <= Date.now()) {
            this.data.delete(key);
            return undefined;
        }
        return e;
    }

    get(key: string): string | null {
        return this.live(key)?.value ?? null;
    }

    set(key: string, value: string, pxMs?: number): void {
        this.data.set(key, {
            value,
            expiresAt: pxMs == null ? Infinity : Date.now() + pxMs,
        });
    }

    del(key: string): void {
        this.data.delete(key);
    }

    // The INCR + first-time-PEXPIRE script, run atomically (no await between read
    // and write — the JS event loop can't interleave it, just as Redis can't).
    incrWithTtl(key: string, ttlMs: number): number {
        const e = this.live(key);
        if (!e) {
            this.data.set(key, { value: '1', expiresAt: Date.now() + ttlMs });
            return 1;
        }
        const v = Number(e.value) + 1;
        this.data.set(key, { value: String(v), expiresAt: e.expiresAt });
        return v;
    }
}

// --- client-shaped facades over one engine --------------------------------

function ioredisFacade(engine: FakeRedisEngine): IoredisLike {
    return {
        async get(key) {
            return engine.get(key);
        },
        async set(
            key: string,
            value: string,
            expiryMode?: 'PX',
            ttlMs?: number,
        ) {
            engine.set(key, value, expiryMode === 'PX' ? ttlMs : undefined);
            return 'OK';
        },
        async del(key) {
            engine.del(key);
            return 1;
        },
        async eval(_script, _numKeys, ...args) {
            const [key, ttlMs] = args;
            return engine.incrWithTtl(String(key), Number(ttlMs));
        },
        async quit() {
            return 'OK';
        },
    };
}

function nodeRedisFacade(engine: FakeRedisEngine): NodeRedisLike {
    return {
        async get(key) {
            return engine.get(key);
        },
        async set(key, value, options) {
            engine.set(key, value, options?.PX);
            return 'OK';
        },
        async del(key) {
            engine.del(key);
            return 1;
        },
        async eval(_script, options) {
            const key = options.keys[0] ?? '';
            const ttlMs = Number(options.arguments[0]);
            return engine.incrWithTtl(key, ttlMs);
        },
        async quit() {
            return 'OK';
        },
    };
}

// --- the hermetic contract runs -------------------------------------------

describe('@stitchapi/redis store contract', () => {
    test('redisStore(fromIoredis(...)) passes the store contract', async () => {
        assertConformance(
            await verifyStoreContract(() =>
                redisStore(fromIoredis(ioredisFacade(new FakeRedisEngine()))),
            ),
        );
    });

    test('redisStore(fromNodeRedis(...)) passes the store contract', async () => {
        assertConformance(
            await verifyStoreContract(() =>
                redisStore(
                    fromNodeRedis(nodeRedisFacade(new FakeRedisEngine())),
                ),
            ),
        );
    });
});

// --- opt-in: against a real Redis -----------------------------------------

const REDIS_URL = process.env['REDIS_URL'];

describe.skipIf(!REDIS_URL)('against a real Redis (REDIS_URL)', () => {
    test('redisStore(fromIoredis(real ioredis)) passes the store contract', async () => {
        // Treat ioredis as an opaque constructor producing an IoredisLike, so the
        // typecheck never depends on ioredis's published overloads.
        const mod = (await import('ioredis')) as unknown as {
            default: new (url: string) => IoredisLike & {
                quit(): Promise<unknown>;
            };
        };
        const client = new mod.default(REDIS_URL as string);
        try {
            assertConformance(
                await verifyStoreContract(() =>
                    redisStore(fromIoredis(client)),
                ),
            );
        } finally {
            await client.quit();
        }
    });
});
