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
        // The GCRA pacing cursor (ADR 0024). Atomic for free: one JS thread, and nothing is
        // awaited between the read and the write. Note the TTL is REFRESHED here, the opposite of
        // `increment` above — a window must not slide, a cursor must not lapse mid-pace.
        async reserve(key, spacing, at, ttl) {
            const e = data.get(key);
            // `e &&` narrows for the compiler where `live(e)` alone cannot (the check is behind a
            // helper), which keeps this off the non-null-assertion suppression budget.
            const cell = e && live(e) ? (e.value as number) : 0;
            const grantAt = Math.max(at, cell);
            sweepExpired();
            data.set(key, {
                value: grantAt + spacing,
                expires: ttl ? now() + ttl : 0,
            });
            return grantAt;
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
    // Forward the optional pacing cursor only when the backend has one, so the view reports the
    // backend's real capability: a lens that always exposed `reserve` would make every store look
    // GCRA-capable and silently break the fallback the absence is meant to select.
    const reserve = store.reserve?.bind(store);
    if (reserve)
        view.reserve = (key, spacing, at, ttl) =>
            reserve(prefix + key, spacing, at, ttl);
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
 * the store: the Nth grant in a window is scheduled at `windowStart + (N-1)·(per/count)` — the
 * same cadence as the in-process limiter ({@link createThrottle}), so attaching a store no longer
 * silently switches pacing to bursty fixed-window (the spacing even carries across the window
 * boundary). A SHARED store paces calls across the whole fleet; concurrency stays in-process (a
 * distributed semaphore needs leases — out of scope here).
 *
 * That slot schedule is a **floor**, applied on top of a per-key local pacing cursor — the same one
 * {@link createThrottle} keeps. Without the cursor a process joining mid-window would claim slots
 * whose scheduled times have already elapsed and grant them all at once (see `acquire`), which is
 * why two rates declaring one spacing (`'2/s'`, `'120/m'`) are the same limiter here as well as
 * in-process. Each grant is `max(now, cursor, slot)`.
 *
 * **All of that is the fallback.** When the store implements {@link StitchStore.reserve} — the GCRA
 * cell of ADR 0024, one atomic read-compute-write over a shared pacing cursor — the counter, the
 * window and the local cursor are all bypassed, and the fleet paces on one continuous schedule:
 * exact `spacing` between grants across every process, wherever in a window they start. `reserve`
 * is implemented by `memoryStore`, `@stitchapi/redis` and `@stitchapi/deno-kv`.
 *
 * Without it, the local cursor bounds a burst PER PROCESS and that is the whole of what it buys: a
 * slot already in the past paces nobody, so N workers that all start mid-window emit at N× the
 * declared rate until the slots catch up with the clock. Starting at a window boundary (or once
 * caught up) the slots are in the future and the fleet paces on one shared budget. The counter is
 * also per-window, so under SUSTAINED overload pacing is approximate at window edges: backlog
 * scheduled on one window's counter can overlap the next window's fresh counter. Both residues are
 * pinned in `store.spec.ts` against a store with `reserve` deliberately withheld, so the fallback
 * stays a decision on the record rather than a surprise — and both are what the cell removes.
 *
 * The fallback is not deprecated and is not going away: an eventually-consistent backend
 * (Cloudflare KV) has no atomic read-compute-write to build a cell from, so this path is the only
 * one it can take.
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
            nextGrantAt?: number; // earliest THIS process may take another rate grant
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
            const spacing = rate.per / rate.count; // ms between grants
            if (store.reserve) {
                // The GCRA cell (ADR 0024). One atomic read-compute-write over a shared cursor
                // gives the fleet what neither half of the fallback below can: the cursor carries
                // continuously (so no window boundary to restart at) and it is shared (so a worker
                // joining mid-window paces against every other worker, not just itself). Every
                // process reads one line of state, so there is no origin to agree on and no stale
                // slot to inherit — the two shapes the counter-based schedule kept tripping over.
                // TTL is a full window past the last reservation: `per >= spacing` always, so it
                // outlives any gap short enough to still need pacing, and a key idle longer than
                // that should restart from the present anyway.
                const at = await store.reserve(
                    `rl:${key}`,
                    spacing,
                    clock.now(),
                    rate.per + 100,
                );
                const wait = at - clock.now();
                if (wait > 0) {
                    await clock.sleep(wait);
                    waited += wait;
                }
                return { waited };
            }
            // Fallback for a store with no `reserve` — an eventually-consistent backend, or any
            // implementation predating ADR 0024. Correct per process and bounded, but a fleet
            // drifts to N× mid-window; the comments below are the full account of why.
            //
            // Even-spaced pacing over the shared counter (mirrors createThrottle's `spacing`):
            // the atomic increment hands each caller a unique slot N in the window, and slot N is
            // scheduled at windowStart + (N-1)·spacing. Slot count+1 lands exactly at the next
            // windowStart, so grants stay one `spacing` apart across the boundary — no fixed-window
            // burst. No re-check loop: each caller owns a distinct, non-colliding slot.
            const windowStart = Math.floor(clock.now() / rate.per) * rate.per;
            // Track the window we minted a key for; when it rolls over, DELETE the previous
            // window's `rl:` key eagerly instead of waiting for its TTL to expire (the store's
            // own sweep is opportunistic). Without this, a long-lived rate-limited seam leaves a
            // dead key per window in the backend until something else happens to evict it.
            const s = stateFor(key);
            if (s.lastWindow !== undefined && s.lastWindow < windowStart)
                await store.set(`rl:${key}:${s.lastWindow}`, undefined);
            s.lastWindow = windowStart;
            const n = await store.increment(
                `rl:${key}:${windowStart}`,
                rate.per + 100,
            );
            // The slot is a FLOOR on the grant, not the grant time itself. A process that joins
            // mid-window finds every slot up to `n` already scheduled in the PAST, and granting
            // each of those the moment it is claimed drains them in one tick — a burst of up to
            // `count-1` calls with no spacing at all, scaling with the window length: `'2/s'` and
            // `'120/m'` declare the same 500ms spacing, but one leaves a single elapsed slot to
            // drain and the other leaves 119. That is a cold start (a rolling deploy, a new
            // worker, a lambda), not the sustained-overload edge described above.
            // So pace on the same local cursor the in-process limiter keeps and take the LATER of
            // the two: the shared counter still allocates slots across the fleet, while no single
            // process ever grants two calls closer than `spacing`. The bound is PER-PROCESS, and
            // that is the whole of what it buys — a stale slot paces nobody, so while the stale
            // prefix lasts only each process's own cursor holds the line and N workers emit at N×
            // the declared rate. At a window boundary the slots are in the future and the fleet
            // does pace on one budget. That residue is what `store.reserve` closes above, which is
            // why this path runs only when the backend cannot offer the cell.
            const at = Math.max(
                clock.now(),
                s.nextGrantAt ?? 0,
                windowStart + (n - 1) * spacing,
            );
            s.nextGrantAt = at + spacing;
            const wait = at - clock.now();
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
        // which a rate-paced key needs to clean up its `rl:` key on the next rollover. That
        // condition also keeps the pacing cursor (`nextGrantAt`) alive for the life of a
        // rate-paced key — dropping one mid-pace would reset it and let the next acquire burst,
        // the same trap `createThrottle.release` guards against explicitly.
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
