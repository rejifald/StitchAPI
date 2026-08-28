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
// Compliance with the store contract is proven against `conformance.store` from
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
 * `increment(key, ttl)` MUST be atomic and, when `ttl` is given, set the key's
 * expiry **only when it creates the counter** (the first increment), never
 * extending it afterwards — otherwise a busy rate window would slide forever
 * and never reset. An absent `ttl` means **no window**: a plain atomic `INCR`,
 * the counter never expires. {@link fromIoredis} / {@link fromNodeRedis}
 * guarantee this with a Lua `EVAL`; a custom driver must do the same.
 */
export interface RedisDriver {
    /** `GET key` — the raw stored string, or `null` when absent. */
    get(key: string): Promise<string | null>;
    /** `SET key value` (no TTL) or `SET key value PX ttl` when `ttl` is set. */
    set(key: string, value: string, ttl?: number): Promise<void>;
    /** `DEL key`. */
    delete(key: string): Promise<void>;
    /**
     * Atomic `INCR key`; resolves to the new count. When `ttl` (ms) is set, a
     * first-time `PEXPIRE key ttl` is bound to the creating increment; absent
     * `ttl` = no expiry.
     */
    increment(key: string, ttl?: number): Promise<number>;
    /**
     * Atomically advance a pacing cursor and resolve to the instant reserved — the GCRA cell
     * backing {@link StitchStore.reserve} (ADR 0024). `at = max(now, cell); cell = at + spacing`,
     * in ONE server-side step; `ttl` (ms) refreshes on every call, unlike `increment`'s.
     *
     * Optional: the three bundled adapters implement it with a Lua `EVAL`, and a custom driver
     * that omits it still satisfies this interface — `redisStore` then exposes no `reserve`, and
     * the throttle takes its per-process fallback.
     */
    reserve?(
        key: string,
        spacing: number,
        now: number,
        ttl?: number,
    ): Promise<number>;
    /**
     * Atomically take or renew one slot of a `limit`-slot counting semaphore, expiring `ttl` ms
     * from `now` — the fleet-wide half of `throttle.concurrency` ({@link StitchStore.lease},
     * ADR 0025). Resolves `true` when the caller holds a slot. Paired with
     * {@link RedisDriver.releaseLease}: implement both or neither.
     */
    lease?(
        key: string,
        token: string,
        limit: number,
        ttl: number,
        now: number,
    ): Promise<boolean>;
    /**
     * Give back the slot {@link RedisDriver.lease} took for `token`; idempotent. Named for the
     * lease rather than bare `release`, because this interface's `close` already owns the
     * connection-lifecycle meaning of that word.
     */
    releaseLease?(key: string, token: string): Promise<void>;
    /** Release the connection (optional — `redisStore().close()` delegates here). */
    close?(): Promise<void>;
}

// Atomic counter-with-optional-window. INCR is atomic on its own; the EXPIRE is
// bound to it in one server-side script so the TTL is set exactly once — on the
// increment that creates the window (`v == 1`) — and a crash can never leave an
// immortal counter. ARGV[1] = 0 encodes an absent `ttl` (a deliberate no-window
// counter: plain INCR, no expiry — the adapters send `ttl ?? 0`). Redis caches
// the script body after the first EVAL, so re-sending it is cheap; EVALSHA would
// shave the bytes but isn't worth the dialect surface here.
const INCR_SCRIPT = `local v = redis.call('INCR', KEYS[1])
local ttl = tonumber(ARGV[1]) or 0
if v == 1 and ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return v`;

// The GCRA pacing cursor (ADR 0024) as one server-side script, which is what makes it atomic
// across the whole fleet: read the cell, take the later of it and the caller's `now`, write the
// next free instant back. Two differences from INCR_SCRIPT above, both deliberate:
//
//   • the PEXPIRE is UNconditional — a window must not slide (hence `v == 1` there), but a cursor
//     must not lapse mid-pace, so every reservation refreshes it;
//   • it returns a STRING. Lua numbers are doubles, but the RESP integer reply truncates, and a
//     spacing of `per/count` is routinely fractional (`'3/s'` is 333.33ms). Returning `tostring`
//     and parsing with `Number` keeps the fraction, so a fleet does not drift a millisecond per
//     grant against the in-process limiter.
//
// `GET` on a missing key is Lua `false`, and `tonumber(false)` is nil, so `or 0` seeds a cold cell.
const RESERVE_SCRIPT = `local spacing = tonumber(ARGV[1])
local at = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3]) or 0
local cell = tonumber(redis.call('GET', KEYS[1])) or 0
if cell > at then at = cell end
redis.call('SET', KEYS[1], at + spacing)
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return tostring(at)`;

// The counting semaphore (ADR 0025) as a SORTED SET: member = token, score = expiry. The store
// contract specifies behaviour, not storage, and here that pays — `ZREMRANGEBYSCORE` prunes every
// lapsed holder in one command and `ZCARD` counts what is left, where the map-shaped stores have
// to walk their entries. Redis drops an emptied zset by itself, so a fully-released semaphore
// leaves no key behind.
//
// The prune runs BEFORE the decision and is therefore persisted even when the answer is "full" —
// the contract requires that, so a failed attempt never leaves dead holders for the next caller.
// `ZSCORE` non-nil means this token already holds a slot, which makes the call a renewal: `ZADD`
// then just moves its score, never adding a second member. The key outlives its longest lease
// (`ttl * 2`) so a full semaphore cannot evaporate under its own holders.
const LEASE_SCRIPT = `local token = ARGV[1]
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local at = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', at)
if redis.call('ZSCORE', KEYS[1], token) or redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], at + ttl, token)
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return 1
end
return 0`;

// Giving a slot back is one atomic command on its own; it rides EVAL only so the driver needs no
// new client surface. `ZREM` on an absent member is a no-op, which is exactly the idempotence the
// contract asks for — releasing a lease that already lapsed must not be an error.
const RELEASE_SCRIPT = `redis.call('ZREM', KEYS[1], ARGV[1])
return 1`;

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
        async delete(key) {
            await client.del(key);
        },
        async increment(key, ttl) {
            // ioredis: eval(script, numKeys, ...keysThenArgs). 0 = no window.
            return Number(await client.eval(INCR_SCRIPT, 1, key, ttl ?? 0));
        },
        async reserve(key, spacing, at, ttl) {
            return Number(
                await client.eval(
                    RESERVE_SCRIPT,
                    1,
                    key,
                    spacing,
                    at,
                    ttl ?? 0,
                ),
            );
        },
        async lease(key, token, limit, ttl, at) {
            return (
                Number(
                    await client.eval(
                        LEASE_SCRIPT,
                        1,
                        key,
                        token,
                        limit,
                        ttl,
                        at,
                    ),
                ) === 1
            );
        },
        async releaseLease(key, token) {
            await client.eval(RELEASE_SCRIPT, 1, key, token);
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
        async delete(key) {
            await client.del(key);
        },
        async increment(key, ttl) {
            // node-redis: eval(script, { keys, arguments }); ARGV are strings.
            // '0' = no window.
            return Number(
                await client.eval(INCR_SCRIPT, {
                    keys: [key],
                    arguments: [String(ttl ?? 0)],
                }),
            );
        },
        async reserve(key, spacing, at, ttl) {
            return Number(
                await client.eval(RESERVE_SCRIPT, {
                    keys: [key],
                    arguments: [String(spacing), String(at), String(ttl ?? 0)],
                }),
            );
        },
        async lease(key, token, limit, ttl, at) {
            return (
                Number(
                    await client.eval(LEASE_SCRIPT, {
                        keys: [key],
                        arguments: [
                            token,
                            String(limit),
                            String(ttl),
                            String(at),
                        ],
                    }),
                ) === 1
            );
        },
        async releaseLease(key, token) {
            await client.eval(RELEASE_SCRIPT, {
                keys: [key],
                arguments: [token],
            });
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
            // Upstash auto-deserializes JSON replies, so a value written as a JSON
            // envelope (or a JSON-parseable string) can come back already parsed.
            // Re-serialize EVERY non-null reply so `redisStore.get`'s `JSON.parse`
            // round-trips exactly — including JSON-parseable strings ("null",
            // "123", '{"x":1}'), which Upstash peels one layer off (the store
            // wrote '"null"', we get the string `null` back), and bare INCR
            // counters (Upstash returns 1 -> "1" -> parse -> 1). Passing strings
            // through untouched would let those cases parse a second time.
            const v = await client.get(key);
            return v == null ? null : JSON.stringify(v);
        },
        async set(key, value, ttl) {
            if (ttl == null) await client.set(key, value);
            else await client.set(key, value, { px: ttl });
        },
        async delete(key) {
            await client.del(key);
        },
        async increment(key, ttl) {
            // Upstash: eval(script, keys[], args[]); ARGV are strings. '0' = no window.
            return Number(
                await client.eval(INCR_SCRIPT, [key], [String(ttl ?? 0)]),
            );
        },
        async reserve(key, spacing, at, ttl) {
            return Number(
                await client.eval(
                    RESERVE_SCRIPT,
                    [key],
                    [String(spacing), String(at), String(ttl ?? 0)],
                ),
            );
        },
        async lease(key, token, limit, ttl, at) {
            return (
                Number(
                    await client.eval(
                        LEASE_SCRIPT,
                        [key],
                        [token, String(limit), String(ttl), String(at)],
                    ),
                ) === 1
            );
        },
        async releaseLease(key, token) {
            await client.eval(RELEASE_SCRIPT, [key], [token]);
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
 * the driver's native `increment`. The store owns no connection — `close()` delegates
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
                await driver.delete(k(key));
                return;
            }
            await driver.set(k(key), JSON.stringify(value), ttl);
        },
        increment(key, ttl) {
            return driver.increment(k(key), ttl);
        },
    };
    // Only when the driver actually has the cell — a custom driver predating ADR 0024 must report
    // its real capability, so the throttle selects the per-process fallback rather than calling a
    // method that is not there.
    if (driver.reserve) {
        const reserve = driver.reserve.bind(driver);
        store.reserve = (key, spacing, at, ttl) =>
            reserve(k(key), spacing, at, ttl);
    }
    // The semaphore pair, forwarded only when the driver has BOTH — half a lease API would let a
    // slot be taken and never given back.
    const lease = driver.lease?.bind(driver);
    const releaseLease = driver.releaseLease?.bind(driver);
    if (lease && releaseLease) {
        store.lease = (key, token, limit, ttl, at) =>
            lease(k(key), token, limit, ttl, at);
        store.release = (key, token) => releaseLease(k(key), token);
    }
    if (driver.close) {
        const close = driver.close.bind(driver);
        store.close = async (): Promise<void> => {
            await close();
        };
    }
    return store;
}
