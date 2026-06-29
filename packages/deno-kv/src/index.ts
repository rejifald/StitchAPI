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
import type { StitchStore } from 'stitchapi';

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
    | { ok: true; versionstamp: string }
    | { ok: false };

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
// the store
// ---------------------------------------------------------------------------

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
     * How many times {@link StitchStore.incr} retries a lost compare-and-set race
     * before giving up. Each retry re-reads the current value, so the loop only
     * spins under genuine contention. With N callers racing one counter, the
     * unluckiest needs up to N−1 retries (each round exactly one commit wins, so
     * contention drains one caller at a time); the default `100` therefore
     * comfortably covers any realistic per-key concurrency on a single window.
     */
    maxIncrRetries?: number;
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
 * compare-and-set loop (see {@link StitchStore.incr}). The store owns no
 * connection — `close()` delegates to the handle, so the caller decides when KV
 * shuts down.
 */
export function denoKvStore(
    kv: DenoKvLike,
    opts: DenoKvStoreOptions = {},
): StitchStore {
    const prefix = opts.keyPrefix;
    const maxRetries = opts.maxIncrRetries ?? 100;
    // String key → Deno KV array key. With a prefix it's a two-segment key so the
    // namespace is a real KV sub-range; without, a flat one-segment key.
    const k = (key: string): DenoKvKey =>
        prefix === undefined ? [key] : [prefix, key];

    const store: StitchStore = {
        async get(key) {
            const { value } = await kv.get(k(key));
            if (value == null) return undefined;
            // We always write a JSON string; anything else (e.g. a bare counter
            // written by `incr`) is handed back as-is.
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
        async incr(key, ttl) {
            // Atomic counter-with-window via compare-and-set. Read the current
            // value + its versionstamp, then commit `next` guarded by a `check`
            // on that versionstamp: if another isolate raced us, the versionstamp
            // moved, the commit returns `ok: false`, and we re-read and retry —
            // so N concurrent incrs net exactly +N (the contract's rule).
            //
            // The TTL is set ONLY on the increment that creates the counter (when
            // the prior versionstamp is `null`), never extending it afterwards —
            // otherwise a busy rate window would slide forever and never reset,
            // matching the redis adapter's "PEXPIRE only when v == 1" semantics.
            const kk = k(key);
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                const entry = await kv.get(kk);
                const current =
                    typeof entry.value === 'number' ? entry.value : 0;
                const next = current + 1;
                const options =
                    entry.versionstamp === null && ttl > 0
                        ? { expireIn: ttl }
                        : undefined;
                const res = await kv
                    .atomic()
                    .check({ key: kk, versionstamp: entry.versionstamp })
                    .set(kk, next, options)
                    .commit();
                if (res.ok) return next;
            }
            throw new Error(
                `@stitchapi/deno-kv: incr(${key}) lost ${maxRetries + 1} compare-and-set races`,
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
