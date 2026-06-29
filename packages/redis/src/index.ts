// Redis-backed StitchStore for StitchAPI (DESIGN.md §13).
//
// Attaching a shared store turns two of the engine's process-local pieces into
// fleet-wide ones with NO change to the call site: the throttle's rate counters
// (cross-process rate limiting) and the auth vault's cookie jar / token cache
// (sessions & tokens shared across workers, surviving restarts). This package is
// the first-party Redis implementation of that seam.
//
// Bring your own driver. The store never imports a Redis client — it talks to a
// tiny normalized {@link RedisDriver} surface, and {@link fromIoredis} /
// {@link fromNodeRedis} / {@link fromUpstash} adapt the popular clients to it
// (each is the same store; only the client dialect differs). Anything that
// satisfies `RedisDriver` works, so another client, a cluster proxy, or a test
// double is a drop-in. `ioredis`, `redis` and `@upstash/redis` are all OPTIONAL
// peer dependencies — install whichever you already use. This mirrors core's
// "contract, not dependency" stance (DESIGN §10, like the BYO axios adapter).
//
// `@upstash/redis` is the edge path: a serverless HTTP Redis with the same
// command vocabulary (including atomic `INCR` and `EVAL`), so it slots straight
// into the driver seam and lets the store run from Vercel/Cloudflare edge
// functions with zero TCP socket.
//
// Compliance with the store contract is proven against `verifyStoreContract` from
// `stitchapi/testing` (see test/conformance.spec.ts).
import type { StitchStore } from 'stitchapi';

// ---------------------------------------------------------------------------
// driver contract
// ---------------------------------------------------------------------------

/**
 * The minimal Redis surface {@link redisStore} runs on — string-valued
 * primitives only. `redisStore` layers the JSON envelope and key prefixing on
 * top; a driver only moves opaque strings and one atomic counter.
 *
 * `incr(key, ttl)` MUST be atomic and set the key's expiry **only when it
 * creates the counter** (the first increment), never extending it afterwards —
 * otherwise a busy rate window would slide forever and never reset. {@link
 * fromIoredis} / {@link fromNodeRedis} guarantee this with a Lua `EVAL`; a custom
 * driver must do the same.
 */
export interface RedisDriver {
    /** `GET key` — the raw stored string, or `null` when absent. */
    get(key: string): Promise<string | null>;
    /** `SET key value` (no TTL) or `SET key value PX ttl` when `ttl` is set. */
    set(key: string, value: string, ttl?: number): Promise<void>;
    /** `DEL key`. */
    del(key: string): Promise<void>;
    /** Atomic `INCR key` + first-time `PEXPIRE key ttl`; resolves to the new count. */
    incr(key: string, ttl: number): Promise<number>;
    /** Release the connection (optional — `redisStore().close()` delegates here). */
    close?(): Promise<void>;
}

// Atomic counter-with-window. INCR is atomic on its own; the EXPIRE is bound to
// it in one server-side script so the TTL is set exactly once — on the increment
// that creates the window (`v == 1`) — and a crash can never leave an immortal
// counter. Redis caches the script body after the first EVAL, so re-sending it is
// cheap; EVALSHA would shave the bytes but isn't worth the dialect surface here.
const INCR_WITH_TTL = `local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return v`;

// ---------------------------------------------------------------------------
// driver adapters (ioredis / node-redis)
// ---------------------------------------------------------------------------

/**
 * The slice of an [`ioredis`](https://github.com/redis/ioredis) client {@link
 * fromIoredis} uses. A real `Redis` (or `Cluster`) instance satisfies it
 * structurally — you never implement this yourself.
 */
export interface IoredisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    set(
        key: string,
        value: string,
        expiryMode: 'PX',
        ttl: number,
    ): Promise<unknown>;
    del(key: string): Promise<unknown>;
    eval(
        script: string,
        numKeys: number,
        ...args: (string | number)[]
    ): Promise<unknown>;
    quit?(): Promise<unknown>;
}

/**
 * The slice of a [`node-redis`](https://github.com/redis/node-redis) v4/v5 client
 * {@link fromNodeRedis} uses. A connected `createClient()` instance satisfies it
 * structurally.
 */
export interface NodeRedisLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { PX: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    eval(
        script: string,
        options: { keys: string[]; arguments: string[] },
    ): Promise<unknown>;
    quit?(): Promise<unknown>;
}

/**
 * The slice of an [`@upstash/redis`](https://github.com/upstash/redis-js) client
 * {@link fromUpstash} uses. A `new Redis({ url, token })` (or `Redis.fromEnv()`)
 * instance satisfies it structurally — you never implement this yourself.
 *
 * Upstash speaks Redis over HTTP, so there's no connection to open or `quit`
 * (each call is a stateless request); that's why this surface has no `quit`.
 * `eval` takes `(script, keys[], args[])` — the same shape as `redis-cli EVAL`,
 * unlike node-redis's options bag — and Upstash JSON-decodes string replies, so
 * `get` can hand back a parsed value; {@link redisStore} stores JSON strings and
 * tolerates either.
 */
export interface UpstashLike {
    get(key: string): Promise<unknown>;
    set(key: string, value: string, options?: { px: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Adapt an `ioredis` client to a {@link RedisDriver}:
 *
 * ```ts
 * import Redis from 'ioredis';
 * import { redisStore, fromIoredis } from '@stitchapi/redis';
 *
 * const store = redisStore(fromIoredis(new Redis(process.env.REDIS_URL!)));
 * ```
 */
export function fromIoredis(client: IoredisLike): RedisDriver {
    return {
        async get(key) {
            return client.get(key);
        },
        async set(key, value, ttl) {
            if (ttl == null) await client.set(key, value);
            else await client.set(key, value, 'PX', ttl);
        },
        async del(key) {
            await client.del(key);
        },
        async incr(key, ttl) {
            // ioredis: eval(script, numKeys, ...keysThenArgs).
            return Number(await client.eval(INCR_WITH_TTL, 1, key, ttl));
        },
        async close() {
            await client.quit?.();
        },
    };
}

/**
 * Adapt a connected `node-redis` (v4/v5) client to a {@link RedisDriver}:
 *
 * ```ts
 * import { createClient } from 'redis';
 * import { redisStore, fromNodeRedis } from '@stitchapi/redis';
 *
 * const client = await createClient({ url: process.env.REDIS_URL }).connect();
 * const store = redisStore(fromNodeRedis(client));
 * ```
 */
export function fromNodeRedis(client: NodeRedisLike): RedisDriver {
    return {
        async get(key) {
            return client.get(key);
        },
        async set(key, value, ttl) {
            if (ttl == null) await client.set(key, value);
            else await client.set(key, value, { PX: ttl });
        },
        async del(key) {
            await client.del(key);
        },
        async incr(key, ttl) {
            // node-redis: eval(script, { keys, arguments }); ARGV are strings.
            return Number(
                await client.eval(INCR_WITH_TTL, {
                    keys: [key],
                    arguments: [String(ttl)],
                }),
            );
        },
        async close() {
            await client.quit?.();
        },
    };
}

/**
 * Adapt an [`@upstash/redis`](https://github.com/upstash/redis-js) client to a
 * {@link RedisDriver} — the edge/serverless path (HTTP Redis, no socket):
 *
 * ```ts
 * import { Redis } from '@upstash/redis';
 * import { redisStore, fromUpstash } from '@stitchapi/redis';
 *
 * const store = redisStore(fromUpstash(Redis.fromEnv()));
 * ```
 *
 * Same store, same atomic INCR+EXPIRE Lua as the TCP adapters — only the dialect
 * differs: Upstash's `set` takes `{ px }` (lowercase) and `eval(script, keys[],
 * args[])` with positional array arguments (args stringified). There's no
 * connection to release, so the driver omits `close()`.
 */
export function fromUpstash(client: UpstashLike): RedisDriver {
    return {
        async get(key) {
            // The driver contract is "return the raw stored string or null".
            // Upstash auto-deserializes JSON replies, so a value we wrote as a
            // JSON envelope can come back already parsed into an object/number;
            // re-serialize those so `redisStore.get`'s `JSON.parse` round-trips,
            // and pass strings through untouched (bare counters stay strings).
            const v = await client.get(key);
            if (v == null) return null;
            return typeof v === 'string' ? v : JSON.stringify(v);
        },
        async set(key, value, ttl) {
            if (ttl == null) await client.set(key, value);
            else await client.set(key, value, { px: ttl });
        },
        async del(key) {
            await client.del(key);
        },
        async incr(key, ttl) {
            // Upstash: eval(script, keys[], args[]); ARGV are strings.
            return Number(
                await client.eval(INCR_WITH_TTL, [key], [String(ttl)]),
            );
        },
    };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/** Options for {@link redisStore}. */
export interface RedisStoreOptions {
    /**
     * Prefix applied to every key, for sharing one Redis with other apps/data.
     * Applied on both read and write, so the store stays self-consistent. Default
     * `''` (no prefix — matches `memoryStore`'s flat keyspace).
     */
    keyPrefix?: string;
}

/**
 * A {@link StitchStore} backed by Redis. Pass a {@link RedisDriver} — typically
 * `fromIoredis(client)` or `fromNodeRedis(client)`:
 *
 * ```ts
 * import { seam } from 'stitchapi';
 * import { redisStore, fromIoredis } from '@stitchapi/redis';
 * import Redis from 'ioredis';
 *
 * const api = seam({ store: redisStore(fromIoredis(new Redis())) });
 * ```
 *
 * Values round-trip through a JSON envelope; the throttle's atomic counters use
 * the driver's native `incr`. The store owns no connection — `close()` delegates
 * to the driver, so the caller decides when the client shuts down.
 */
export function redisStore(
    driver: RedisDriver,
    opts: RedisStoreOptions = {},
): StitchStore {
    const prefix = opts.keyPrefix ?? '';
    const k = (key: string): string => prefix + key;

    const store: StitchStore = {
        async get(key) {
            const raw = await driver.get(k(key));
            if (raw == null) return undefined;
            try {
                return JSON.parse(raw) as unknown;
            } catch {
                // Not written via `set` (e.g. a bare counter) — hand it back raw.
                return raw;
            }
        },
        async set(key, value, ttl) {
            // `set(key, undefined)` is the cache's delete (ADR 0003 §8) — drop the key.
            if (value === undefined) {
                await driver.del(k(key));
                return;
            }
            await driver.set(k(key), JSON.stringify(value), ttl);
        },
        incr(key, ttl) {
            return driver.incr(k(key), ttl);
        },
    };
    if (driver.close) {
        const close = driver.close.bind(driver);
        store.close = async (): Promise<void> => {
            await close();
        };
    }
    return store;
}
