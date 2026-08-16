// Deno KV-backed StitchStore for StitchAPI (DESIGN.md §13).
//
// Attaching a shared store turns two of the engine's process-local pieces into
// fleet-wide ones with NO change to the call site: the throttle's rate counters
// (cross-process rate limiting) and the auth vault's cookie jar / token cache
// (sessions & tokens shared across isolates, surviving restarts). On Deno Deploy
// the same `Deno.openKv()` handle is replicated globally, so this package makes a
// stitch's state edge-native for free.
//
// Bring your own handle. The store never imports `@deno/kv` or touches the `Deno`
// global — it talks to a tiny structural {@link DenoKvLike} surface that the real
// `Deno.Kv` satisfies as-is. Anything else that satisfies it (a test double, a
// cluster proxy) is a drop-in. This mirrors core's "contract, not dependency"
// stance (DESIGN §10, like the BYO axios adapter), and keeps the package with
// ZERO runtime dependencies — usable from Node, Bun or Deno alike.
//
// Compliance with the store contract is proven against `verifyStoreContract` from
// `stitchapi/testing` (see test/conformance.spec.ts).
import { duration } from 'stitchapi';
import type {
    AtLeastOne,
    BackoffCurve,
    BackoffOptions,
    StitchStore,
} from 'stitchapi';

// ---------------------------------------------------------------------------
// the Deno KV surface
// ---------------------------------------------------------------------------

/** Deno KV array key — we only ever build single- or two-element string keys. */
export type DenoKvKey = readonly (string | number)[];

/** The result of a `get`: the value plus its optimistic-concurrency token. */
export interface DenoKvEntryMaybe {
    /** Stored value, or `null` when the key is absent. */
    value: unknown;
    /** Opaque version token; `null` when the key is absent — used by `check`. */
    versionstamp: string | null;
}

/** A `check` predicate: "the key must still be at this versionstamp to commit". */
export interface DenoAtomicCheck {
    key: DenoKvKey;
    versionstamp: string | null;
}

/** The outcome of an atomic commit. `ok: false` ⇒ a `check` failed; retry. */
export type DenoAtomicCommitResult =
    { ok: true; versionstamp: string } | { ok: false };

/**
 * The fluent atomic builder Deno KV's `atomic()` returns. We use only the slice
 * that powers a compare-and-set counter: assert the read versionstamp with
 * {@link check}, write the next value with {@link set}, then {@link commit}.
 */
export interface DenoAtomicOperation {
    check(...checks: DenoAtomicCheck[]): DenoAtomicOperation;
    set(
        key: DenoKvKey,
        value: unknown,
        options?: { expireIn?: number },
    ): DenoAtomicOperation;
    commit(): Promise<DenoAtomicCommitResult>;
}

/**
 * The minimal `Deno.Kv` surface {@link denoKvStore} runs on. A real handle from
 * `Deno.openKv()` (or the npm `@deno/kv` package) satisfies it structurally — you
 * never implement this yourself in production.
 *
 * Note `expireIn` is **milliseconds** (matching the store contract's `ttl`),
 * which is exactly Deno KV's own unit — no conversion at the seam.
 */
export interface DenoKvLike {
    get(key: DenoKvKey): Promise<DenoKvEntryMaybe>;
    set(
        key: DenoKvKey,
        value: unknown,
        options?: { expireIn?: number },
    ): Promise<unknown>;
    delete(key: DenoKvKey): Promise<void>;
    atomic(): DenoAtomicOperation;
    /** Release the connection (optional — `denoKvStore().close()` delegates here). */
    close?(): void;
}

// ---------------------------------------------------------------------------
// the counter window
// ---------------------------------------------------------------------------

/**
 * What `increment` stores under a counter key: the running count `n` plus the window's
 * absolute `deadline` (epoch ms; `0` = no window — the counter never expires,
 * mirroring `memoryStore`'s "0 marks live forever"). We keep the deadline in the
 * VALUE — rather than relying on the key's `expireIn` alone — because Deno KV's
 * `set` replaces the whole entry (clearing any prior expiry) and `get` never
 * exposes the remaining TTL. Storing the deadline lets each `increment` re-derive the
 * correct `expireIn` on every write, so a fixed window's expiry survives later
 * increments intact.
 */
interface CounterWindow {
    n: number;
    deadline: number;
}

/**
 * Read a stored lease set (ADR 0025) back as a mutable token→expiry record. Anything that is not
 * a record of numbers — an absent key, a legacy value — reads as empty rather than throwing, so
 * one malformed entry can never wedge a semaphore shut.
 */
function asLeases(value: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (value && typeof value === 'object')
        for (const [t, at] of Object.entries(value as Record<string, unknown>))
            if (typeof at === 'number') out[t] = at;
    return out;
}

/** A value is a live {@link CounterWindow} iff it's a `{ n, deadline }` object. */
function asWindow(value: unknown): CounterWindow | null {
    if (value == null || typeof value !== 'object') return null;
    const w = value as { n?: unknown; deadline?: unknown };
    return typeof w.n === 'number' && typeof w.deadline === 'number'
        ? { n: w.n, deadline: w.deadline }
        : null;
}

// Delay before retry #n (1-based) under a backoff curve, clamped to `max`. Mirrors
// core's `RetryOptions` curves: `fixed` holds `base`, `expo` doubles it, and
// `expo-jitter` picks uniformly in `[0, expo]` (full jitter) so a thundering herd of
// isolates doesn't re-collide in lockstep on the same tick.
function backoffDelay(
    curve: 'expo' | 'expo-jitter' | 'fixed',
    n: number,
    base: number,
    max: number,
): number {
    if (curve === 'fixed') return Math.min(base, max);
    const expo = Math.min(base * 2 ** (n - 1), max);
    return curve === 'expo' ? expo : Math.random() * expo;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/**
 * How {@link StitchStore.increment} rides out a lost compare-and-set race. The
 * subset of core's `RetryOptions` that means anything to a CAS loop: there is no
 * `on`, because the loop retries exactly one condition — another isolate committed
 * first — and nothing else.
 */
export interface DenoKvRetryOptions {
    /**
     * Total attempts including the first (default `100`). Each attempt re-reads the
     * current value, so the loop only spins under genuine contention. With N callers
     * racing one counter, the unluckiest needs up to N−1 retries (each round exactly
     * one commit wins, so contention drains one caller at a time); the default
     * comfortably covers any realistic per-key concurrency on a single window.
     */
    attempts?: number;
    /**
     * Delay policy between attempts, the same envelope core's `retry.backoff` uses — a
     * bare curve is the shorthand for `{ curve }`. Omitted (the default) means **no
     * delay**: the loop re-reads immediately, which is the tightest path to a win when
     * contention is brief. Set a curve when many isolates hammer one key and the hot spin
     * costs more KV reads than it saves. `base` defaults to 5ms, `max` to 250ms.
     */
    backoff?: BackoffCurve | AtLeastOne<BackoffOptions>;
}

/** Options for {@link denoKvStore}. */
export interface DenoKvStoreOptions {
    /**
     * Prefix segment prepended to every key, for sharing one KV database with
     * other apps/data: a string key `k` maps to `[keyPrefix, k]` instead of
     * `[k]`. Applied on both read and write, so the store stays self-consistent.
     * Default `undefined` (flat one-segment keys — matches `memoryStore`).
     */
    keyPrefix?: string;
    /**
     * Compare-and-set retry policy for {@link StitchStore.increment}. A bare number
     * is the attempts shorthand (`retry: 20` ≡ `retry: { attempts: 20 }`); the
     * envelope adds a backoff curve. Default `{ attempts: 100 }` with no delay.
     */
    retry?: number | AtLeastOne<DenoKvRetryOptions>;
}

/**
 * A {@link StitchStore} backed by Deno KV. Pass a {@link DenoKvLike} handle —
 * typically the result of `await Deno.openKv()`:
 *
 * ```ts
 * import { seam } from 'stitchapi';
 * import { denoKvStore } from '@stitchapi/deno-kv';
 *
 * const api = seam({ store: denoKvStore(await Deno.openKv()) });
 * ```
 *
 * Values round-trip through a JSON envelope so the store never wrestles with Deno
 * KV's structured-clone edge cases (BigInt, undefined-vs-null) — it persists the
 * exact bytes the contract handed it. The throttle's counter uses an atomic
 * compare-and-set loop (see {@link StitchStore.increment}). The store owns no
 * connection — `close()` delegates to the handle, so the caller decides when KV
 * shuts down.
 */
export function denoKvStore(
    kv: DenoKvLike,
    opts: DenoKvStoreOptions = {},
): StitchStore {
    const prefix = opts.keyPrefix;
    // P12 dominant-field shorthand: a bare number is `{ attempts }`. Normalized once
    // here so the loop below only ever reads the envelope.
    const retry: DenoKvRetryOptions =
        typeof opts.retry === 'number'
            ? { attempts: opts.retry }
            : (opts.retry ?? {});
    const attempts = retry.attempts ?? 100;
    // Same nested fold core does (P12): a bare curve is `{ curve }`.
    const b = retry.backoff;
    const curve: BackoffOptions | undefined =
        typeof b === 'string' ? { curve: b } : b;
    const backoff = curve?.curve ?? (curve ? 'expo-jitter' : undefined);
    const base = duration.parse(curve?.base) ?? 5;
    const max = duration.parse(curve?.max) ?? 250;
    // String key → Deno KV array key. With a prefix it's a two-segment key so the
    // namespace is a real KV sub-range; without, a flat one-segment key.
    const k = (key: string): DenoKvKey =>
        prefix === undefined ? [key] : [prefix, key];

    const store: StitchStore = {
        async get(key) {
            const { value } = await kv.get(k(key));
            if (value == null) return undefined;
            // A counter written by `increment` is a `{ n, deadline }` envelope; the
            // contract's cross-reads of a counter (e.g. core's cache-generation
            // number) expect the plain count, so unwrap it back to `n`. A legacy
            // bare-number counter from before this envelope is returned as-is.
            const window = asWindow(value);
            if (window) return window.n;
            // Everything else is the JSON string `set` wrote (or a bare value a
            // custom writer left behind) — hand it back decoded.
            if (typeof value !== 'string') return value;
            try {
                return JSON.parse(value) as unknown;
            } catch {
                return value;
            }
        },
        async set(key, value, ttl) {
            // `set(key, undefined)` is the cache's delete (ADR 0003 §8) — drop the key.
            if (value === undefined) {
                await kv.delete(k(key));
                return;
            }
            // Deno KV rejects `expireIn` of 0/negative; only attach a positive TTL.
            const options =
                ttl != null && ttl > 0 ? { expireIn: ttl } : undefined;
            await kv.set(k(key), JSON.stringify(value), options);
        },
        async increment(key, ttl) {
            // Atomic FIXED-window counter via compare-and-set. Read the current
            // value + its versionstamp, then commit the next state guarded by a
            // `check` on that versionstamp: if another isolate raced us, the
            // versionstamp moved, the commit returns `ok: false`, and we re-read
            // and retry — so N concurrent increments net exactly +N (the contract).
            //
            // The window is a `{ n, deadline }` envelope, NOT a bare number,
            // because Deno KV's `set` replaces the whole entry — including its
            // expiry. (This is the opposite of Redis's INCR, which PRESERVES the
            // key's TTL, so the redis adapter can set PEXPIRE once at creation.
            // Here a later `set` without `expireIn` would silently CLEAR the
            // window, making the counter permanent and the rate limit never
            // reset.) We store an absolute `deadline`, pinned at the window's
            // FIRST increment and never extended, and re-derive `expireIn` from
            // it on every commit so the fixed window always expires on time.
            const kk = k(key);
            for (let attempt = 1; attempt <= attempts; attempt++) {
                const entry = await kv.get(kk);
                const now = Date.now();
                const prev = asWindow(entry.value);
                // A window past its deadline (or an absent / legacy bare-number
                // value) starts a fresh window at 1; an old bare counter thus
                // self-heals into the envelope on its next increment. A `deadline` of
                // 0 marks a windowless counter — live forever.
                const live =
                    prev != null &&
                    (prev.deadline === 0 || prev.deadline > now);
                // Absent (or non-positive) `ttl` = no window: the counter never
                // expires — `deadline: 0`, the same "live forever" marker
                // `memoryStore` uses. A live counter keeps its original
                // deadline, windowed or not, regardless of this call's `ttl`.
                const windowed = ttl != null && ttl > 0;
                const deadline = live
                    ? prev.deadline
                    : windowed
                      ? now + ttl
                      : 0;
                const n = (live ? prev.n : 0) + 1;
                // Deno KV rejects `expireIn` of 0/negative; keep it ≥ 1 while the
                // deadline is in the future. A windowless counter (deadline 0)
                // writes without an expiry (matching `set`'s no-TTL path).
                const options =
                    deadline > 0
                        ? { expireIn: Math.max(1, deadline - now) }
                        : undefined;
                const res = await kv
                    .atomic()
                    .check({ key: kk, versionstamp: entry.versionstamp })
                    .set(kk, { n, deadline }, options)
                    .commit();
                if (res.ok) return n;
                // Lost the race. Pause only when a curve is configured — the default
                // re-reads immediately — and never after the final attempt, which
                // would just delay the throw.
                if (backoff && attempt < attempts) {
                    await sleep(backoffDelay(backoff, attempt, base, max));
                }
            }
            throw new Error(
                `@stitchapi/deno-kv: increment(${key}) lost ${attempts} compare-and-set races`,
            );
        },
        async reserve(key, spacing, at, ttl) {
            // The GCRA pacing cursor (ADR 0024), on the same compare-and-set loop `increment`
            // uses: read the cell and its versionstamp, commit `max(now, cell) + spacing` guarded
            // by a `check` on that versionstamp, retry if another isolate committed first. That
            // guard is what makes the cell atomic FLEET-wide rather than per-isolate.
            //
            // Simpler than `increment` above, and for the reason that made that one complicated:
            // Deno KV's `set` replaces the whole entry INCLUDING its expiry, which forced the
            // `{ n, deadline }` envelope there to stop a fixed window sliding on every write.
            // A cursor is supposed to slide — its TTL refreshes on every reservation — so the
            // replace-everything behaviour is exactly what is wanted and a bare number suffices.
            const kk = k(key);
            for (let attempt = 1; attempt <= attempts; attempt++) {
                const entry = await kv.get(kk);
                const cell = typeof entry.value === 'number' ? entry.value : 0;
                const grantAt = Math.max(at, cell);
                const options =
                    ttl != null && ttl > 0 ? { expireIn: ttl } : undefined;
                const res = await kv
                    .atomic()
                    .check({ key: kk, versionstamp: entry.versionstamp })
                    .set(kk, grantAt + spacing, options)
                    .commit();
                if (res.ok) return grantAt;
                if (backoff && attempt < attempts) {
                    await sleep(backoffDelay(backoff, attempt, base, max));
                }
            }
            throw new Error(
                `@stitchapi/deno-kv: reserve(${key}) lost ${attempts} compare-and-set races`,
            );
        },
        async lease(key, token, limit, ttl, at) {
            // The counting semaphore (ADR 0025), on the same compare-and-set loop as the two verbs
            // above. Held as a token→expiry record — Redis reaches for a sorted set here, and both
            // satisfy the contract, which specifies behaviour rather than storage.
            const kk = k(key);
            for (let attempt = 1; attempt <= attempts; attempt++) {
                const entry = await kv.get(kk);
                const held = asLeases(entry.value);
                // Prune first and commit the pruning even when the answer is "full", so a failed
                // attempt never leaves lapsed holders for the next caller to re-walk.
                for (const [t, expiresAt] of Object.entries(held))
                    if (expiresAt <= at) delete held[t];
                const got = token in held || Object.keys(held).length < limit;
                if (got) held[token] = at + ttl; // already there ⇒ a renewal, not a second slot
                const res = await kv
                    .atomic()
                    .check({ key: kk, versionstamp: entry.versionstamp })
                    .set(kk, held, { expireIn: ttl * 2 })
                    .commit();
                if (res.ok) return got;
                if (backoff && attempt < attempts) {
                    await sleep(backoffDelay(backoff, attempt, base, max));
                }
            }
            throw new Error(
                `@stitchapi/deno-kv: lease(${key}) lost ${attempts} compare-and-set races`,
            );
        },
        async release(key, token) {
            const kk = k(key);
            for (let attempt = 1; attempt <= attempts; attempt++) {
                const entry = await kv.get(kk);
                const held = asLeases(entry.value);
                // Idempotent: a token that already lapsed (or was never held) is a no-op, and
                // needs no commit at all.
                if (!(token in held)) return;
                delete held[token];
                const res = await kv
                    .atomic()
                    .check({ key: kk, versionstamp: entry.versionstamp })
                    .set(kk, held)
                    .commit();
                if (res.ok) return;
                if (backoff && attempt < attempts) {
                    await sleep(backoffDelay(backoff, attempt, base, max));
                }
            }
            throw new Error(
                `@stitchapi/deno-kv: release(${key}) lost ${attempts} compare-and-set races`,
            );
        },
    };
    if (kv.close) {
        const close = kv.close.bind(kv);
        store.close = async (): Promise<void> => {
            close();
        };
    }
    return store;
}
