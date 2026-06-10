// The default in-memory state store + a store-backed throttle. Swapping the store for a
// Redis/Postgres adapter makes throttle distributed and sessions persistent/shared across
// workers, with no change to the call site (DESIGN.md §13).
import type { StitchStore, ThrottleOptions } from './types';
import { now, parseRate, sleep } from './util';

/** Default store: in-memory, single process, with TTL + atomic incr. */
export function memoryStore(): StitchStore {
    const data = new Map<string, { value: unknown; expires: number }>();
    const live = (e?: { expires: number }) => !!e && (e.expires === 0 || e.expires > now());
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
            data.set(key, { value: n, expires: live(e) ? e!.expires : now() + ttlMs });
            return n;
        },
    };
}

export interface Throttle {
    acquire(key: string): Promise<{ waitedMs: number }>;
    release(key: string): void;
}

/**
 * Store-backed throttle. Rate is enforced as a fixed-window counter held in the store, so a
 * SHARED store paces calls across processes; concurrency stays in-process (a distributed
 * semaphore needs leases — out of scope here).
 */
export function createStoreThrottle(opts: ThrottleOptions | undefined, store: StitchStore): Throttle {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const local = new Map<string, { inFlight: number; waiters: Array<() => void> }>();

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

    async function acquire(key: string): Promise<{ waitedMs: number }> {
        const start = now();
        await takeSlot(key);
        if (rate) {
            // At most rate.count grants per rate.perMs window. If we land over the limit,
            // wait for the next window boundary and re-check.
            for (;;) {
                const windowStart = Math.floor(now() / rate.perMs) * rate.perMs;
                const count = await store.incr(`rl:${key}:${windowStart}`, rate.perMs + 100);
                if (count <= rate.count) break;
                const waitMs = windowStart + rate.perMs - now();
                if (waitMs > 0) await sleep(waitMs);
            }
        }
        return { waitedMs: now() - start };
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
