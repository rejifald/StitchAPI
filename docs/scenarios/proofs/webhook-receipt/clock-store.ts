// A `StitchStore` whose TTL is driven by an INJECTED clock, so a dedup entry's expiry is virtual
// time rather than wall time.
//
// This exists because the default `memoryStore()` reads `now()` — `Date.now()` (store.ts:16,45,54
// via util.ts:4) — and therefore ignores a stitch's `clock` entirely. C5 measures that directly: a
// dedup key written with Stripe's 3-day retry window as its TTL is still readable after a
// `manualClock()` has been advanced FOUR virtual days. Testing the TTL boundary of a 3-day window
// against `Date.now()` is not something a test suite can do, so a user who wants that boundary
// covered writes this file — which is why it is here rather than imported.
//
// It is a faithful copy of `memoryStore`'s semantics with `now()` swapped for `clock.now()`: the
// `expires === 0` sentinel means "no TTL", `set(key, undefined)` deletes, and `increment` keeps the
// first window's expiry. The opportunistic sweep is omitted — a proof run stores a handful of keys.
//
// `backing` is optional and is what makes DURABILITY testable: hand the same `Map` to two
// successive stores and the second one is the process that restarted.
import type { Clock, StitchStore } from '../../../../packages/core/src/types';

export function clockStore(
    clock: Clock,
    backing: Map<string, { value: unknown; expires: number }> = new Map(),
): StitchStore {
    const data = backing;
    const live = (e?: { expires: number }): boolean =>
        !!e && (e.expires === 0 || e.expires > clock.now());
    return {
        async get(key) {
            const e = data.get(key);
            if (!live(e)) {
                data.delete(key);
                return undefined;
            }
            return e?.value;
        },
        async set(key, value, ttl) {
            if (value === undefined) {
                data.delete(key);
                return;
            }
            data.set(key, { value, expires: ttl ? clock.now() + ttl : 0 });
        },
        async increment(key, ttl) {
            const e = data.get(key);
            const n = (live(e) ? (e?.value as number) : 0) + 1;
            data.set(key, {
                value: n,
                expires: live(e)
                    ? (e?.expires ?? 0)
                    : ttl
                      ? clock.now() + ttl
                      : 0,
            });
            return n;
        },
        // A durable store's `close()` releases the CONNECTION, not the data — `redisStore` closes a
        // client, it does not FLUSHDB. Only the in-memory default conflates the two, which is the
        // point C5 (e) measures, so this one deliberately leaves `backing` intact.
        async close() {
            /* nothing to release: the data outlives the handle, as a durable store's does */
        },
    };
}
