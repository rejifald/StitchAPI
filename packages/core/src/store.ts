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
            data.set(key, { value, expires: ttlMs ? now() + ttlMs : 0 });
        },
        async incr(key, ttlMs) {
            const e = data.get(key);
            const n = (live(e) ? (e!.value as number) : 0) + 1;
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
 * Store-backed throttle. Rate is enforced as a fixed-window counter held in the store, so a
 * SHARED store paces calls across processes; concurrency stays in-process (a distributed
 * semaphore needs leases — out of scope here).
 */
export function createStoreThrottle(
    opts: ThrottleOptions | undefined,
    store: StitchStore,
): Throttle {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const local = new Map<
        string,
        { inFlight: number; waiters: (() => void)[] }
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
            // At most rate.count grants per rate.perMs window. If we land over the limit,
            // wait for the next window boundary and re-check.
            for (;;) {
                const windowStart = Math.floor(now() / rate.perMs) * rate.perMs;
                const count = await store.incr(
                    `rl:${key}:${windowStart}`,
                    rate.perMs + 100,
                );
                if (count <= rate.count) break;
                const waitMs = windowStart + rate.perMs - now();
                if (waitMs > 0) {
                    await sleep(waitMs);
                    waitedMs += waitMs;
                }
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
    }

    return { acquire, release };
}
