// The default in-memory state store + a store-backed throttle. Swapping the store for a
// Redis/Postgres adapter makes throttle distributed and sessions persistent/shared across
// workers, with no change to the call site (DESIGN.md §13).
import type {
    AcquireOptions,
    Clock,
    StitchStore,
    ThrottleOptions,
} from './types';
import { now, parseRate, systemClock } from './util';

/** Default store: in-memory, single process, with TTL + atomic increment. */
export function memoryStore(): StitchStore {
    const data = new Map<string, { value: unknown; expires: number }>();
    const live = (e?: { expires: number }) =>
        !!e && (e.expires === 0 || e.expires > now());
    // Opportunistic, bounded sweep of expired entries. The store evicts a key lazily on a `get`/
    // `increment` of THAT key, so a throttle that mints a new per-window `rl:` key each window would
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
        async set(key, value, ttl) {
            if (value === undefined) {
                data.delete(key);
                return;
            }
            sweepExpired();
            data.set(key, { value, expires: ttl ? now() + ttl : 0 });
        },
        async increment(key, ttl) {
            const e = data.get(key);
            const n = (live(e) ? (e!.value as number) : 0) + 1;
            sweepExpired();
            data.set(key, {
                value: n,
                // Absent `ttl` = no window: the counter never expires (0 marks "live forever").
                expires: live(e) ? e!.expires : ttl ? now() + ttl : 0,
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
        set: (key, value, ttl) => store.set(prefix + key, value, ttl),
        increment: (key, ttl) => store.increment(prefix + key, ttl),
    };
    // Delegate lifecycle to the backend (bind keeps `this` for stores that need it).
    if (store.close) view.close = store.close.bind(store);
    return view;
}

/**
 * Compose throttles so EVERY gate must pass — the engine acquires/releases the chain as one
 * (ADR 0002 §5, tighten-only). A seam injects `[sharedBucket, stitchLocal]` so a stitch's local
 * throttle STACKS on the shared budget (intersection) and can never escape it. `waited` sums
 * across gates; release unwinds in reverse acquisition order.
 */
export function chainThrottle(throttles: Throttle[]): Throttle {
    return {
        async acquire(key, opts) {
            let waited = 0;
            // Thread the acquire options (e.g. `rateOnly` for streaming) to EVERY gate, so a
            // streaming member skips the concurrency slot on both the seam bucket and its own
            // local throttle while still charging each rate gate (ADR 0005 Decision 12).
            for (const t of throttles)
                waited += (await t.acquire(key, opts)).waited;
            return { waited };
        },
        release(key) {
            // Unwind in reverse acquisition order.
            for (const t of [...throttles].reverse()) t.release(key);
        },
    };
}

export interface Throttle {
    acquire(key: string, opts?: AcquireOptions): Promise<{ waited: number }>;
    release(key: string): void;
}

/**
 * Store-backed throttle. Rate is paced by EVEN-SPACED grants over an atomic per-window counter in
 * the store: the Nth grant is scheduled one `per/count` after the (N-1)th — the same cadence as
 * the in-process limiter ({@link createThrottle}), so attaching a store does not switch pacing to
 * bursty fixed-window. A SHARED store paces calls across the whole fleet; concurrency stays
 * in-process (a distributed semaphore needs leases — out of scope here).
 *
 * Two things keep `per` out of the grant times, so that every spelling of one rate behaves the
 * same way (ADR 0023 — `'2/s'` and `'120/m'` are the same request, and used not to be):
 *
 * - Slots are measured from the window's **first arrival**, published in the store by whichever
 *   caller the atomic increment hands `n === 1`. Anchoring on the epoch-aligned `windowStart`
 *   instead gave a cold key every slot that had already elapsed before anyone called — an opening
 *   burst of `count`, so a long window bursted harder.
 * - The schedule **carries across a rollover**: a new window's origin is `max(now, head)`, where
 *   `head` is the latest grant this process has already placed. Restarting at `now` would run the
 *   new window's slots through grants still pending past the boundary, and the residue scaled with
 *   how often the counter rolled — worst for a SHORT window, the opposite skew to the first defect.
 *
 * `head` is process-local, which is exactly right for the single-process case and safe in a fleet:
 * a process knows only a subset of the fleet's grants, so its head can only lag the true one, and
 * a lagging carry over-admits slightly rather than over-pacing anyone. That residue, and the
 * per-window counter reset behind it, are why this is still not exact continuous GCRA across
 * processes — which needs an atomic read-compute-write of a timestamp (a Lua cell or a new atomic
 * store primitive), a `StitchStore` contract extension that stays deliberately deferred.
 */
export function createStoreThrottle(
    opts: ThrottleOptions | undefined,
    store: StitchStore,
    clock: Clock = systemClock,
): Throttle {
    const limit = opts?.concurrency;
    const rate = opts?.rate ? parseRate(opts.rate) : undefined;
    const local = new Map<
        string,
        {
            inFlight: number;
            waiters: (() => void)[];
            lastWindow?: number; // windowStart of the last `rl:` key this throttle minted
            head?: number; // latest grant time this process has scheduled, + one spacing
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
    ): Promise<{ waited: number }> {
        let waited = 0;
        // A rate-only acquire (a streaming surface — ADR 0005 Decision 12) takes no concurrency
        // slot (and so is never released); it still charges the rate window below.
        if (!acqOpts?.rateOnly) {
            // Only a real concurrency block counts as "waited" — not incidental store or
            // scheduling time — so waited (and the 'throttled' event) is deterministic.
            const blocked = limit != null && stateFor(key).inFlight >= limit;
            const blockStart = clock.now();
            await takeSlot(key);
            if (blocked) waited = clock.now() - blockStart;
        }
        if (rate) {
            // Even-spaced pacing over the shared counter (mirrors createThrottle's `spacing`):
            // the atomic increment hands each caller a unique slot N, and slot N is scheduled one
            // `spacing` after slot N-1. No re-check loop: each caller owns a distinct,
            // non-colliding slot.
            //
            // The slots are measured from the window's FIRST ARRIVAL, not from its epoch-aligned
            // start (ADR 0023). Anchoring on `windowStart` credited a key with every slot that had
            // already elapsed before anyone called: those grants sit in the past, so they all fire
            // at once, and the size of that opening burst is `count` — which scales with `per`. It
            // made two spellings of ONE rate behave differently (`'120/m'` admitted ~10x what
            // `'2/s'` did) and let a cold key emit a full window's budget instantly, the exact
            // fixed-window burst the even spacing exists to prevent. `per` now sets only how often
            // the shared counter rolls over; it is not an input to any grant time.
            const spacing = rate.per / rate.count; // ms between grants
            const windowStart = Math.floor(clock.now() / rate.per) * rate.per;
            const counterKey = `rl:${key}:${windowStart}`;
            const originKey = `${counterKey}:t0`;
            // Track the window we minted a key for; when it rolls over, DELETE the previous
            // window's `rl:` keys eagerly instead of waiting for their TTL to expire (the store's
            // own sweep is opportunistic). Without this, a long-lived rate-limited seam leaves a
            // dead key per window in the backend until something else happens to evict it.
            const s = stateFor(key);
            if (s.lastWindow !== undefined && s.lastWindow < windowStart) {
                const stale = `rl:${key}:${s.lastWindow}`;
                await store.set(stale, undefined);
                await store.set(`${stale}:t0`, undefined);
            }
            s.lastWindow = windowStart;
            const ttl = rate.per + 100;
            const n = await store.increment(counterKey, ttl);
            // Slot 1 IS the first arrival, and the atomic increment makes exactly one caller per
            // window see `n === 1` across the whole fleet — so that caller publishes the origin
            // every other caller in the window measures from. A reader that misses it (it raced
            // the write, or the key lapsed) falls back to its own clock: that can only push a
            // grant LATER than the true schedule, never earlier, so the failure mode is a touch
            // of over-pacing rather than a burst.
            const at = clock.now();
            let origin = at;
            if (n === 1) {
                // Rolling over. The counter resets, but the SCHEDULE must not: grants already
                // placed beyond this boundary are still pending, and restarting from `now` would
                // run the new window's slots straight through them — the residual over-admission
                // that survived anchoring on first arrival (it scales with how often the counter
                // rolls, so it hit a short `per` hardest: `'2/s'` admitted ~3x its budget under
                // overload while `'120/m'`, the same rate, was exact). Carrying this process's own
                // schedule head across the boundary makes a single process exact and, in a fleet,
                // strictly better than not carrying: a process only ever knows a SUBSET of the
                // fleet's grants, so its head can only lag the true one — the residue shrinks
                // toward the shared-counter behaviour instead of over-pacing anyone. A head left
                // over from an idle stretch is already in the past and `max` discards it.
                origin = Math.max(at, s.head ?? at);
                await store.set(originKey, origin, ttl);
            } else {
                const published = await store.get(originKey);
                if (typeof published === 'number') origin = published;
            }
            const grantAt = origin + (n - 1) * spacing;
            s.head = Math.max(s.head ?? 0, grantAt + spacing);
            const wait = grantAt - clock.now();
            if (wait > 0) {
                await clock.sleep(wait);
                waited += wait;
            }
        }
        return { waited };
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
        // which a rate-paced key needs to clean up its `rl:` key on the next rollover, or a
        // schedule head that has not yet lapsed — dropping THAT would forget the grants already
        // placed past the next boundary and let the following window restart on top of them,
        // which is the burst the carry exists to prevent. Same rule the in-process limiter
        // applies to its own `nextGrantAt`: a still-pacing key outlives its last release.
        if (
            s.inFlight === 0 &&
            s.waiters.length === 0 &&
            s.lastWindow === undefined &&
            (s.head ?? 0) <= clock.now()
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
