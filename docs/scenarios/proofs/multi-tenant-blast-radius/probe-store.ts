// A `StitchStore` that records every key the ENGINE touches, over a real `memoryStore`.
//
// This is the scenario's most load-bearing instrument. Whether a resource is shared or isolated
// per tenant is not a matter of which objects were constructed — C2 and C5 both measure
// constructions that look isolated and are not — it is a matter of WHAT STRING the engine keyed
// the state on. The breaker lives at `circuit:<key>` (resilience.ts:353) and the rate counter at
// `rl:<key>:<window>` (store.ts:204), so reading the key set off the store answers "is this one
// budget or N" directly, rather than by inference from behaviour.
import { memoryStore } from '../../../../packages/core/src/index';
import type { StitchStore } from '../../../../packages/core/src/types';

export interface ProbeStore extends StitchStore {
    /** Every key touched, in order, with duplicates — `keys('circuit:')` is the usual read. */
    readonly touched: string[];
    /** The distinct keys touched under a prefix, in first-touch order. */
    keys(prefix?: string): string[];
    /** Keys currently HOLDING a value (a `set(key, undefined)` deletes) — the residency measurement. */
    live(prefix?: string): string[];
}

export function probeStore(inner: StitchStore = memoryStore()): ProbeStore {
    const touched: string[] = [];
    const resident = new Set<string>();
    const record = (key: string): void => {
        touched.push(key);
    };
    return {
        touched,
        keys(prefix = '') {
            return [...new Set(touched.filter((k) => k.startsWith(prefix)))];
        },
        live(prefix = '') {
            return [...resident].filter((k) => k.startsWith(prefix));
        },
        get(key) {
            record(key);
            return inner.get(key);
        },
        async set(key, value, ttl) {
            record(key);
            // `set(key, undefined)` is the store's delete (store.ts:39-42) — the throttle uses it
            // to drop a rolled-over window, so residency has to honour it.
            if (value === undefined) resident.delete(key);
            else resident.add(key);
            return inner.set(key, value, ttl);
        },
        async increment(key, ttl) {
            record(key);
            resident.add(key);
            return inner.increment(key, ttl);
        },
        close: () => inner.close?.() ?? Promise.resolve(),
    };
}
