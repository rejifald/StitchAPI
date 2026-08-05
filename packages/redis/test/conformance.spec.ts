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
    // Sorted sets live beside the string keyspace, as they do in Redis. Member → score; the
    // lease scripts are the only users, and they never need ordering, just prune + count.
    private readonly zsets = new Map<
        string,
        { members: Map<string, number>; expiresAt: number }
    >();

    private liveZ(key: string): Map<string, number> | undefined {
        const z = this.zsets.get(key);
        if (!z) return undefined;
        if (z.expiresAt <= Date.now()) {
            this.zsets.delete(key);
            return undefined;
        }
        return z.members;
    }

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

    // The GCRA pacing-cursor script (ADR 0024), same atomicity argument as `incrScript`: no
    // await between the read and the write, so nothing can interleave — as on the server.
    // Mirrors the Lua in two details that matter:
    //   • the expiry is REWRITTEN every call (the Lua's PEXPIRE is unconditional), where the
    //     counter above preserves the creating increment's — a window must not slide, a cursor
    //     must not lapse;
    //   • it returns a STRING, because the real script does `tostring` to keep a fractional
    //     spacing off the RESP integer reply's truncation.
    reserveScript(
        key: string,
        spacing: number,
        at: number,
        ttlMs: number,
    ): string {
        const e = this.live(key);
        const cell = e ? Number(e.value) : 0;
        const grantAt = Math.max(at, cell);
        this.data.set(key, {
            value: String(grantAt + spacing),
            expiresAt: ttlMs > 0 ? Date.now() + ttlMs : Infinity,
        });
        return String(grantAt);
    }

    // The semaphore script (ADR 0025), mirroring the Lua's sorted-set commands: prune every
    // member scored at or below `at` (ZREMRANGEBYSCORE), then take a slot if this token already
    // holds one (ZSCORE — a renewal) or there is room (ZCARD < limit). Same atomicity argument as
    // the two above. Redis drops an emptied zset, so an all-released semaphore leaves no key.
    leaseScript(
        key: string,
        token: string,
        limit: number,
        ttl: number,
        at: number,
    ): number {
        const members = this.liveZ(key) ?? new Map<string, number>();
        for (const [t, score] of members) if (score <= at) members.delete(t);
        const got = members.has(token) || members.size < limit;
        if (got) {
            members.set(token, at + ttl);
            this.zsets.set(key, {
                members,
                expiresAt: Date.now() + ttl * 2,
            });
        } else if (members.size === 0) this.zsets.delete(key);
        else
            this.zsets.set(key, {
                members,
                expiresAt: this.zsets.get(key)?.expiresAt ?? Infinity,
            });
        return got ? 1 : 0;
    }

    // ZREM; absent member is a no-op, and an emptied set drops its key.
    releaseScript(key: string, token: string): number {
        const members = this.liveZ(key);
        if (!members) return 1;
        members.delete(token);
        if (members.size === 0) this.zsets.delete(key);
        return 1;
    }
}

// Which script the caller sent. The facades below take the script TEXT, exactly as a real client
// does, so the fake routes on it rather than assuming every `eval` is the counter — which is what
// it used to do, and why a second script silently read as an increment.
//
// Order matters: `ZREMRANGEBYSCORE` CONTAINS `ZREM`, so the lease script has to be recognised
// before the release script or every lease would read as a release.
type ScriptKind = 'incr' | 'reserve' | 'lease' | 'release';
const scriptKind = (script: unknown): ScriptKind => {
    const s = String(script);
    if (s.includes('ZREMRANGEBYSCORE')) return 'lease';
    if (s.includes('ZREM')) return 'release';
    if (s.includes('INCR')) return 'incr';
    return 'reserve';
};

// One dispatcher, shared by all three client facades: they differ only in how the client spells
// `eval`, never in what the scripts mean.
const runScript = (
    engine: FakeRedisEngine,
    script: unknown,
    key: string,
    args: unknown[],
): unknown => {
    const n = (i: number): number => Number(args[i]);
    switch (scriptKind(script)) {
        case 'incr':
            return engine.incrScript(key, n(0));
        case 'reserve':
            return engine.reserveScript(key, n(0), n(1), n(2));
        case 'lease':
            return engine.leaseScript(key, String(args[0]), n(1), n(2), n(3));
        case 'release':
            return engine.releaseScript(key, String(args[0]));
    }
};

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
        async eval(script, _numKeys, ...args) {
            const [key, ...rest] = args;
            return runScript(engine, script, String(key), rest);
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
        async eval(script, options) {
            return runScript(
                engine,
                script,
                options.keys[0] ?? '',
                options.arguments,
            );
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
        async eval(script, keys, args) {
            return runScript(engine, script, keys[0] ?? '', args);
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
