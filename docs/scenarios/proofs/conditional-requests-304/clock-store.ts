// A `StitchStore` whose TTL is driven by an INJECTED clock, so `cache.ttl` expiry is virtual time.
//
// This exists because the default `memoryStore()` reads `now()` — `Date.now()` (store.ts:16,45 via
// util.ts:4) — and therefore ignores a stitch's `clock` entirely. C5 measures that directly: a
// `cache: { ttl: '1s' }` stitch on a `manualClock()` advanced by a virtual HOUR still serves the
// cached entry. Every claim here that needs an expiring cache injects this instead, so the
// staleness numbers in C8 are exact rather than timing-dependent.
//
// It is a faithful copy of `memoryStore`'s semantics with `now()` swapped for `clock.now()`: the
// `expires === 0` sentinel means "no TTL", `set(key, undefined)` deletes, and `increment` keeps the
// first window's expiry. The opportunistic sweep is omitted — a proof run stores a handful of keys.
import type { Clock, StitchStore } from '../../../../packages/core/src/types';

export function clockStore(clock: Clock): StitchStore {
    const data = new Map<string, { value: unknown; expires: number }>();
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
        async close() {
            data.clear();
        },
    };
}
