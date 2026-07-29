// Cloudflare Workers KV-backed StitchStore for StitchAPI (DESIGN.md §13).
//
// Attaching a shared store turns the engine's process-local pieces into fleet-wide
// ones with NO change to the call site. On the edge, Workers KV is the natural
// backend for the read-heavy halves: cached responses and the auth vault's cookie
// jar / token cache, shared across every isolate and surviving cold starts. This
// package is the first-party Workers KV implementation of that seam.
//
// Bring your own namespace. The store never imports the Workers runtime — it talks
// to a tiny structural {@link KVNamespaceLike} surface that a real `KVNamespace`
// binding satisfies as-is. Anything that satisfies it works, so a test double or a
// custom proxy is a drop-in. The package is Web-API only (no `node:*`), so it runs
// in a Worker, in Pages Functions, and in any other edge runtime.
//
// !! THE atomic-increment GAP !! Workers KV has NO atomic increment — only
// last-write-wins `get`/`put`/`delete`. Distributed throttle counters need an
// atomic read-modify-write, which KV cannot provide, so {@link cloudflareKvStore}'s
// `increment` THROWS (see below). Use a Durable Object-backed store for distributed
// throttle; KV remains correct for cache + shared sessions/tokens, which is the
// overwhelmingly common edge need.
import type { StitchStore } from 'stitchapi';

// ---------------------------------------------------------------------------
// namespace contract
// ---------------------------------------------------------------------------

/**
 * The minimal Workers KV surface {@link cloudflareKvStore} runs on. A real
 * `KVNamespace` binding (the `env.MY_KV` your Worker receives) satisfies this
 * structurally — you never implement it yourself; the interface only exists so the
 * package needs no `@cloudflare/workers-types` dependency to typecheck.
 *
 * `cloudflareKvStore` layers the JSON envelope and key prefixing on top; the
 * namespace only moves opaque strings.
 *
 * Note the unit mismatch this store reconciles: the StitchStore contract speaks
 * **milliseconds**, but `put`'s `expirationTtl` is in **seconds** (and Workers KV
 * rejects a TTL below 60s). {@link cloudflareKvStore} converts and floors for you.
 */
export interface KVNamespaceLike {
    /** `GET key` as text — the raw stored string, or `null` when absent. */
    get(key: string): Promise<string | null>;
    /**
     * `PUT key value`, optionally with a relative TTL in **seconds**
     * (`expirationTtl`, minimum 60 on real KV). No TTL = no expiry.
     */
    put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
    ): Promise<void>;
    /** `DELETE key`. */
    delete(key: string): Promise<void>;
}

// Workers KV's smallest accepted TTL. A `put` with a shorter `expirationTtl` is
// rejected by the runtime, so we floor every TTL to this — a key asked to live for
// 5s simply lives for 60s, which is harmless for caches and sessions.
const KV_MIN_TTL_SECONDS = 60;

// Surfaced when `increment` is called: Workers KV has no atomic counter, so honoring it
// would silently undercount under concurrency and break rate limiting. Failing
// loud (and pointing at the fix) is the only safe behavior.
const INCREMENT_UNSUPPORTED =
    'increment() is not supported on Cloudflare Workers KV: KV has no atomic ' +
    'read-modify-write, so a distributed counter would undercount under ' +
    'concurrency and silently break rate limiting. Back the throttle with a ' +
    'Durable Object-based StitchStore instead; KV remains correct for cache ' +
    'and shared sessions/tokens (get/set).';

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/** Options for {@link cloudflareKvStore}. */
export interface CloudflareKvStoreOptions {
    /**
     * Prefix applied to every key, for sharing one namespace with other apps/data.
     * Applied on both read and write, so the store stays self-consistent. Default
     * `''` (no prefix — matches `memoryStore`'s flat keyspace).
     */
    keyPrefix?: string;
}

/**
 * A {@link StitchStore} backed by Cloudflare Workers KV. Pass the KV binding your
 * Worker receives in `env`:
 *
 * ```ts
 * import { seam } from 'stitchapi';
 * import { cloudflareKvStore } from '@stitchapi/cloudflare-kv';
 *
 * export default {
 *     async fetch(req, env) {
 *         const api = seam({ store: cloudflareKvStore(env.MY_KV) });
 *         // ...
 *     },
 * };
 * ```
 *
 * Values round-trip through a JSON envelope. `ttl` is converted to KV's
 * second-resolution `expirationTtl` and floored to KV's 60s minimum. `set(key,
 * undefined)` deletes the key (the cache's delete, ADR 0003 §8).
 *
 * **`increment` is unsupported and throws.** Workers KV offers no atomic increment, so
 * a distributed throttle counter cannot be implemented correctly on it — see the
 * module header. Use a Durable Object-backed store for distributed throttle; KV is
 * the right backend for the read-heavy halves (cache + shared sessions/tokens).
 *
 * The store owns no connection, so there is no `close()`.
 */
export function cloudflareKvStore(
    kv: KVNamespaceLike,
    opts: CloudflareKvStoreOptions = {},
): StitchStore {
    const prefix = opts.keyPrefix ?? '';
    const k = (key: string): string => prefix + key;

    return {
        async get(key) {
            const raw = await kv.get(k(key));
            if (raw == null) return undefined;
            try {
                return JSON.parse(raw) as unknown;
            } catch {
                // Not written via `set` (e.g. a value seeded out of band) — hand
                // it back raw rather than throwing on someone else's data.
                return raw;
            }
        },
        async set(key, value, ttl) {
            // `set(key, undefined)` is the cache's delete (ADR 0003 §8) — drop the key.
            if (value === undefined) {
                await kv.delete(k(key));
                return;
            }
            const body = JSON.stringify(value);
            if (ttl == null) {
                await kv.put(k(key), body);
                return;
            }
            // ms → s, never below KV's 60s floor (and never zero).
            const expirationTtl = Math.max(
                KV_MIN_TTL_SECONDS,
                Math.ceil(ttl / 1000),
            );
            await kv.put(k(key), body, { expirationTtl });
        },
        increment() {
            // Fail loud, not silent: see INCREMENT_UNSUPPORTED.
            return Promise.reject(new Error(INCREMENT_UNSUPPORTED));
        },
    };
}
