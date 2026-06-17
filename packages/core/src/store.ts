// The default in-memory state store + a store-backed throttle. Swapping the store for a
// Redis/Postgres adapter makes throttle distributed and sessions persistent/shared across
// workers, with no change to the call site (DESIGN.md §13).
import type { AcquireOptions, StitchStore, ThrottleOptions } from './types';
import { now, parseRate, sleep } from './util';

/** Default store: in-memory, single process, with TTL + atomic incr. */
export function memoryStore(): StitchStore {
    const data = new Map<string, { value: unknown; expires: number }>();
    const live = (e?: { expires: number }) =>
        !!e && (e.expires === 0 || e.expires > now());
    // Opportunistic, bounded sweep of expired entries. The store evicts a key lazily on a `get`/
    // `incr` of THAT key, so a throttle that mints a new per-window `rl:` key each window would
    // otherwise accumulate dead keys forever (no key is ever read again). On a write we scan up to
    // `SWEEP_BUDGET` entries and drop any that have expired — never touching a live key, so
    // observable behaviour is unchanged; it just keeps the Map from growing without bound.
    const SWEEP_BUDGET = 64;
    const sweepExpired = (): void => {
        let scanned = 0;
        for (const [k, e] of data) {
            if (scanned++ >= SWEEP_BUDGET) break;
            if (!live(e)) data.delete(k);
        }
    };
    return {
        async get(key) {
            const e = data.get(key);
            if (!live(e)) {
                data.delete(key);
                return undefined;
            }
            return e!.value;
        },
        async set(key, value, ttlMs) {
            if (value === undefined) {
                data.delete(key);
                return;
            }
            sweepExpired();
            data.set(key, { value, expires: ttlMs ? now() + ttlMs : 0 });
        },
        async incr(key, ttlMs) {
            const e = data.get(key);
            const n = (live(e) ? (e!.value as number) : 0) + 1;
            sweepExpired();
            data.set(key, {
                value: n,
                expires: live(e) ? e!.expires : now() + ttlMs,
            });
            return n;
        },
        // Lifecycle: drop everything. For the in-memory store this is all the state there is.
        async close() {
            data.clear();
        },
    };
}

/**
 * A namespaced view over a store: the seam's **vault** (ADR 0002 §4). It prefixes every key so
 * auth tokens/sessions live in a reserved slice of the backend (the same `StitchStore` by
 * default, or a hardened `secretStore`), kept off `__config` and redacted from traces. It is a
 * thin lens — `close()` delegates to the backend, so callers close the backend, not the view.
 */
export function vaultView(store: StitchStore, prefix = 'vault:'): StitchStore {
    const view: StitchStore = {
        get: (key) => store.get(prefix + key),
        set: (key, value, ttlMs) => store.set(prefix + key, value, ttlMs),
        incr: (key, ttlMs) => store.incr(prefix + key, ttlMs),
    };
    // Delegate lifecycle to the backend (bind keeps `this` for stores that need it).
    if (store.close) view.close = store.close.bind(store);
    return view;
}

/**
 * Compose throttles so EVERY gate must pass — the engine acquires/releases the chain as one
 * (ADR 0002 §5, tighten-only). A seam injects `[sharedBucket, stitchLocal]` so a stitch's local
 * throttle STACKS on the shared budget (intersection) and can never escape it. `waitedMs` sums
 * across gates; release unwinds in reverse acquisition order.
 */
export function chainThrottle(throttles: Throttle[]): Throttle {
    return {
        async acquire(key, opts) {
            let waitedMs = 0;
            // Thread the acquire options (e.g. `rateOnly` for streaming) to EVERY gate, so a
            // streaming member skips the concurrency slot on both the seam bucket and its own
            // local throttle while still charging each rate gate (ADR 0005 Decision 12).
            for (const t of throttles)
                waitedMs += (await t.acquire(key, opts)).waitedMs;
            return { waitedMs };
        },
        release(key) {
            // Unwind in reverse acquisition order.
            for (const t of [...throttles].reverse()) t.release(key);
        },
    };
}

export interface Throttle {
    acquire(key: string, opts?: AcquireOptions): Promise<{ waitedMs: number }>;
    release(key: string): void;
}

/**
 * Store-backed throttle. Rate is paced by EVEN-SPACED grants over an atomic per-window counter in
 * the store: the Nth grant in a window is scheduled at `windowStart + (N-1)·(perMs/count)` — the
 * same cadence as the in-process limiter ({@link createThrottle}), so attaching a store no longer
 * silently switches pacing to bursty fixed-window (the spacing even carries across the window
 * boundary). A SHARED store paces calls across the whole fleet; concurrency stays in-process (a
 * distributed semaphore needs leases — out of scope here).
 *
 * The counter is per-window, so under SUSTAINED overload (offered load above the limit across
 * multiple windows) pacing is approximate at window edges: backlog scheduled on one window's
 * counter can overlap the next window's fresh counter. Exact continuous GCRA across processes would
 * need an atomic read-compute-write of a timestamp (a Lua cell or a new atomic store primitive) — a
 * `StitchStore` contract extension, deliberately deferred.
 */
export function createStoreThrottle(
    opts: ThrottleOptions | undefined,
    store: StitchStore,
): Throttle {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const local = new Map<
        string,
        {
            inFlight: number;
            waiters: (() => void)[];
            lastWindow?: number; // windowStart of the last `rl:` key this throttle minted
        }
    >();

    const stateFor = (key: string) => {
        let s = local.get(key);
        if (!s) {
            s = { inFlight: 0, waiters: [] };
            local.set(key, s);
        }
        return s;
    };
    const takeSlot = (key: string): Promise<void> => {
        if (limit == null) return Promise.resolve();
        const s = stateFor(key);
        if (s.inFlight < limit) {
            s.inFlight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => s.waiters.push(resolve));
    };

    async function acquire(
        key: string,
        acqOpts?: AcquireOptions,
    ): Promise<{ waitedMs: number }> {
        let waitedMs = 0;
        // A rate-only acquire (a streaming surface — ADR 0005 Decision 12) takes no concurrency
        // slot (and so is never released); it still charges the rate window below.
        if (!acqOpts?.rateOnly) {
            // Only a real concurrency block counts as "waited" — not incidental store or
            // scheduling time — so waitedMs (and the 'throttled' event) is deterministic.
            const blocked = limit != null && stateFor(key).inFlight >= limit;
            const blockStart = now();
            await takeSlot(key);
            if (blocked) waitedMs = now() - blockStart;
        }
        if (rate) {
            // Even-spaced pacing over the shared counter (mirrors createThrottle's `spacing`):
            // the atomic incr hands each caller a unique slot N in the window, and slot N is
            // scheduled at windowStart + (N-1)·spacing. Slot count+1 lands exactly at the next
            // windowStart, so grants stay one `spacing` apart across the boundary — no fixed-window
            // burst. No re-check loop: each caller owns a distinct, non-colliding slot.
            const spacing = rate.perMs / rate.count; // ms between grants
            const windowStart = Math.floor(now() / rate.perMs) * rate.perMs;
            // Track the window we minted a key for; when it rolls over, DELETE the previous
            // window's `rl:` key eagerly instead of waiting for its TTL to expire (the store's
            // own sweep is opportunistic). Without this, a long-lived rate-limited seam leaves a
            // dead key per window in the backend until something else happens to evict it.
            const s = stateFor(key);
            if (s.lastWindow !== undefined && s.lastWindow < windowStart)
                await store.set(`rl:${key}:${s.lastWindow}`, undefined);
            s.lastWindow = windowStart;
            const n = await store.incr(
                `rl:${key}:${windowStart}`,
                rate.perMs + 100,
            );
            const grantAt = windowStart + (n - 1) * spacing;
            const wait = grantAt - now();
            if (wait > 0) {
                await sleep(wait);
                waitedMs += wait;
            }
        }
        return { waitedMs };
    }

    function release(key: string): void {
        if (limit == null) return;
        const s = local.get(key);
        if (!s) return;
        const next = s.waiters.shift();
        if (next) next();
        else if (s.inFlight > 0) s.inFlight--;
        // Drop a fully-idle key's state so the `local` Map doesn't accumulate one entry per
        // ever-seen key. Keep it only while it still carries window bookkeeping (`lastWindow`),
        // which a rate-paced key needs to clean up its `rl:` key on the next rollover.
        if (
            s.inFlight === 0 &&
            s.waiters.length === 0 &&
            s.lastWindow === undefined
        )
            local.delete(key);
    }

    const api = { acquire, release };
    // Non-enumerable test probe: the live per-key local-state Map, so the resource-leak suite can
    // assert a concurrency-only key's entry is dropped after its last release. Not public.
    Object.defineProperty(api, THROTTLE_LOCAL, {
        value: local,
        enumerable: false,
    });
    return api;
}

/** Internal: keys the non-enumerable per-key local-state Map probe for the resource-leak suite. */
export const THROTTLE_LOCAL = Symbol('stitch.storeThrottle.local');
