// The default in-memory state store + a store-backed throttle. Swapping the store for a
// Redis/Postgres adapter makes throttle distributed and sessions persistent/shared across
// workers, with no change to the call site (DESIGN.md §13).
import type {
    AcquireOptions,
    Clock,
    StitchStore,
    ThrottleOptions,
} from './types';
import { hex, now, parseDuration, parseRate, systemClock } from './util';

// How long a fleet-wide concurrency slot is held before it lapses, when `throttle.lease` says
// nothing. Comfortably above a normal buffered call (streaming holds no slot at all — ADR 0005
// Decision 12), and short enough that a crashed worker's slots come back on a human timescale.
const DEFAULT_LEASE_MS = 30_000;
// Ceiling on the wait between attempts when every slot is taken. There is no cross-process
// handoff to wait on, so a blocked caller polls; the actual delay is uniform in [0, this), which
// is full jitter — a fleet queued behind one slot must not retry in lockstep.
const LEASE_POLL_MS = 50;

/** Default store: in-memory, single process, with TTL + atomic increment. */
export function memoryStore(): StitchStore {
    const data = new Map<string, { value: unknown; expires: number }>();
    // Semaphores (ADR 0025) live in their own map, token → expiry, the way Redis keeps them in a
    // sorted set beside its string keyspace. Kept apart from `data` rather than serialised into
    // it because nothing else ever reads them: no JSON envelope, no key-level TTL to reconcile
    // against the per-token expiry that already governs every holder.
    const sems = new Map<string, Map<string, number>>();
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
        // The counting semaphore (ADR 0025). Atomic for free, like the two verbs above: one JS
        // thread, nothing awaited between the read and the write.
        async lease(key, token, limit, ttl, at) {
            let held = sems.get(key);
            if (!held) sems.set(key, (held = new Map<string, number>()));
            // Prune first, ALWAYS — an attempt that goes on to refuse still has to drop the
            // lapsed holders, or every later caller re-walks the same dead entries.
            for (const [t, expiresAt] of held)
                if (expiresAt <= at) held.delete(t);
            // Already holding it ⇒ a renewal, never a second slot.
            const got = held.has(token) || held.size < limit;
            if (got) held.set(token, at + ttl);
            return got;
        },
        async release(key, token) {
            // Idempotent: a token that already lapsed (or was never held) is a no-op.
            const held = sems.get(key);
            if (held?.delete(token) && held.size === 0) sems.delete(key);
        },
        // Lifecycle: drop everything. For the in-memory store this is all the state there is.
        async close() {
            data.clear();
            sems.clear();
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
    // The lease pair travels together or not at all — forwarding one without the other would
    // advertise a semaphore that can be taken and never given back.
    const lease = store.lease?.bind(store);
    const release = store.release?.bind(store);
    if (lease && release) {
        view.lease = (key, token, limit, ttl, at) =>
            lease(prefix + key, token, limit, ttl, at);
        view.release = (key, token) => release(prefix + key, token);
    }
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
 * boundary). A SHARED store paces calls across the whole fleet.
 *
 * **Concurrency is fleet-wide too when the store leases** ({@link StitchStore.lease} /
 * {@link StitchStore.release}, ADR 0025): `concurrency: 10` then means ten calls in flight across
 * every worker on that store rather than ten each, and a worker that crashes holding slots returns
 * them when its leases lapse (`throttle.lease`, default 30s). Two differences from the in-process
 * semaphore are inherent rather than incidental: a blocked caller POLLS, because no worker can be
 * woken by another worker's release, so the FIFO handoff becomes jittered contention; and a
 * release is fire-and-forget, because the lease expiry already covers a lost one. Without the
 * verbs `concurrency` stays per-process exactly as before — pinned both ways in `store.spec.ts`.
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
    // The lease pair is all-or-nothing (ADR 0025); resolved once so the hot path is one check.
    const leases =
        store.lease && store.release
            ? {
                  lease: store.lease.bind(store),
                  free: store.release.bind(store),
              }
            : undefined;
    const leaseTtl = parseDuration(opts?.lease) ?? DEFAULT_LEASE_MS;
    const local = new Map<
        string,
        {
            inFlight: number;
            waiters: (() => void)[];
            lastWindow?: number; // windowStart of the last `rl:` key this throttle minted
            nextGrantAt?: number; // earliest THIS process may take another rate grant
            tokens?: string[]; // fleet-wide leases THIS process is holding, newest last
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
    // Fleet-wide slot (ADR 0025). Where `takeSlot` parks on an in-process queue and is handed the
    // slot by whoever releases it, there is no cross-process handoff to wait for — a worker cannot
    // be woken by another worker's release — so a blocked caller POLLS. The interval is fully
    // jittered so a fleet that piles up behind one slot does not re-collide in lockstep on every
    // retry, the same full-jitter reasoning `expo-jitter` uses for retry backoff.
    const takeLease = async (key: string): Promise<void> => {
        if (limit == null || !leases) return;
        const token = hex(8);
        for (;;) {
            if (await leases.lease(key, token, limit, leaseTtl, clock.now())) {
                // `stateFor` is resolved HERE, not before the loop. A poller that captured the
                // state object up front could be holding an orphan: `release` drops a key's entry
                // once its last token goes, so a caller that was still polling across that moment
                // would push its token onto an object no longer in `local` — and the next
                // `release` would look up the live entry, find nothing, and never free the slot.
                // One leaked slot per occurrence, which under contention is a deadlock.
                (stateFor(key).tokens ??= []).push(token);
                return;
            }
            await clock.sleep(Math.random() * LEASE_POLL_MS);
        }
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
            // scheduling time — so waited (and the 'throttled' event) is deterministic. With
            // leases the store owns the count, so "did I have to wait" is measured rather than
            // predicted: a lease granted on the first attempt blocked nobody.
            const blockStart = clock.now();
            if (leases) {
                await takeLease(key);
                const spent = clock.now() - blockStart;
                if (spent > 0) waited = spent;
            } else {
                const blocked =
                    limit != null && stateFor(key).inFlight >= limit;
                await takeSlot(key);
                if (blocked) waited = clock.now() - blockStart;
            }
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
        if (leases) {
            // Give back the newest lease this process holds. Which one is arbitrary and does not
            // matter — the slots are interchangeable — but LIFO keeps the pairing obvious when
            // reading a trace, and every acquire is matched by exactly one release.
            const token = s.tokens?.pop();
            // Fire-and-forget on purpose, so a caller never pays a store round-trip on its way
            // out. Safe because the lease expires anyway: a release lost to a network blip costs
            // the fleet one slot for at most `lease`, which is the same guarantee that covers a
            // holder crashing mid-call. Awaiting here would buy promptness, not correctness.
            if (token) void leases.free(key, token).catch(() => undefined);
            if (s.tokens?.length === 0) delete s.tokens;
        }
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
            s.lastWindow === undefined &&
            !s.tokens?.length
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
