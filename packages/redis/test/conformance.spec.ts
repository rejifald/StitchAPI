// Conformance proof for @stitchapi/redis. All three driver adapters
// (`fromIoredis`, `fromNodeRedis`, `fromUpstash`) must pass `verifyStoreContract`
// from `stitchapi/testing`.
//
// The default run is hermetic and offline: a tiny in-repo Redis engine (a Map
// with PX expiry + the atomic INCR/PEXPIRE the store's Lua performs) wrapped in
// an ioredis-shaped, a node-redis-shaped and an Upstash-shaped facade, so each
// adapter's dialect translation is exercised without a server. Single-threaded JS
// makes the engine atomic, which is exactly what the real `EVAL` guarantees — so
// the contract's "20 concurrent increments net +20" rule holds here, on real Redis,
// and on Upstash's edge HTTP Redis alike.
//
// Set REDIS_URL to additionally run the SAME verifier against a live Redis via a
// real ioredis client, proving the atomic INCR+EXPIRE end to end.
import { fromIoredis, fromNodeRedis, fromUpstash, redisStore } from '../src';
import type { IoredisLike, NodeRedisLike, UpstashLike } from '../src';

import { assertConformance, verifyStoreContract } from 'stitchapi/testing';
import { describe, expect, test } from 'vitest';

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
    // Mirrors the Lua exactly: ARGV[1] = 0 means no window — the counter is
    // created without an expiry (the adapters send `ttl ?? 0`).
    incrScript(key: string, ttlMs: number): number {
        const e = this.live(key);
        if (!e) {
            this.data.set(key, {
                value: '1',
                expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Infinity,
            });
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
            return engine.incrScript(String(key), Number(ttlMs));
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
            return engine.incrScript(key, ttlMs);
        },
        async quit() {
            return 'OK';
        },
    };
}

// Upstash quirks faithfully reproduced: `set` takes `{ px }` (lowercase), `eval`
// is `(script, keys[], args[])`, and replies are JSON-auto-deserialized — so a
// stored JSON envelope comes back already parsed, exercising `fromUpstash.get`'s
// re-serialize path. There is no `quit` (HTTP, stateless).
function upstashFacade(engine: FakeRedisEngine): UpstashLike {
    return {
        async get(key) {
            const raw = engine.get(key);
            if (raw == null) return null;
            // Mimic Upstash's automatic deserialization of JSON string replies.
            try {
                return JSON.parse(raw) as unknown;
            } catch {
                return raw;
            }
        },
        async set(key, value, options) {
            engine.set(key, value, options?.px);
            return 'OK';
        },
        async del(key) {
            engine.del(key);
            return 1;
        },
        async eval(_script, keys, args) {
            const key = keys[0] ?? '';
            const ttlMs = Number(args[0]);
            return engine.incrScript(key, ttlMs);
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

    test('redisStore(fromUpstash(...)) passes the store contract', async () => {
        assertConformance(
            await verifyStoreContract(() =>
                redisStore(fromUpstash(upstashFacade(new FakeRedisEngine()))),
            ),
        );
    });
});

// --- no-window increment (absent ttl) -------------------------------------------
//
// `StitchStore.increment(key)` without a ttl means "no window": the counter never
// expires. The adapters encode the absent ttl as ARGV[1] = 0 and the script
// skips the PEXPIRE; the fake engine mirrors that (0 → no expiry), so this
// pins each dialect's translation of the sentinel end to end.

describe('increment without a ttl never expires (no window)', () => {
    const stores = [
        [
            'fromIoredis',
            (): ReturnType<typeof redisStore> =>
                redisStore(fromIoredis(ioredisFacade(new FakeRedisEngine()))),
        ],
        [
            'fromNodeRedis',
            (): ReturnType<typeof redisStore> =>
                redisStore(
                    fromNodeRedis(nodeRedisFacade(new FakeRedisEngine())),
                ),
        ],
        [
            'fromUpstash',
            (): ReturnType<typeof redisStore> =>
                redisStore(fromUpstash(upstashFacade(new FakeRedisEngine()))),
        ],
    ] as const;

    test.each(stores)('%s', async (_name, makeStore) => {
        const store = makeStore();
        // A windowed counter alongside proves the wait outlives a real window.
        await store.increment('windowed', 40);
        expect(await store.increment('unwindowed')).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 90));
        expect(await store.increment('windowed', 40)).toBe(1); // window expired → restart
        expect(await store.increment('unwindowed')).toBe(2); // no window → still counting
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

    test('increment without a ttl never expires (the real Lua skips PEXPIRE on 0)', async () => {
        const mod = (await import('ioredis')) as unknown as {
            default: new (url: string) => IoredisLike & {
                quit(): Promise<unknown>;
            };
        };
        const client = new mod.default(REDIS_URL as string);
        const store = redisStore(fromIoredis(client));
        const key = `stitch-conformance:no-window-${Date.now().toString(36)}`;
        try {
            await store.increment(key);
            await new Promise((resolve) => setTimeout(resolve, 90));
            expect(await store.increment(key)).toBe(2); // no window → still counting
        } finally {
            await store.set(key, undefined); // drop the immortal counter
            await client.quit();
        }
    });
});
