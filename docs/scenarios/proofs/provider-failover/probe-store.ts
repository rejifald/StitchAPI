// A `StitchStore` that records every key the ENGINE touches, over a real `memoryStore`.
//
// C7 asks whether a circuit breaker can be scoped to just the hedge, and that is not a question
// about which objects were constructed — it is a question about WHAT STRING the engine keyed the
// breaker on. The breaker lives at `circuit:<key>` (resilience.ts:353) where the key defaults to
// `cfg.name ?? cfg.path ?? 'stitch'` (engine.ts:140,265-274,860), so reading the key set off the
// store answers "are these two providers sharing one breaker" directly, rather than by inference.
import { memoryStore } from '../../../../packages/core/src/index';
import type { StitchStore } from '../../../../packages/core/src/types';

export interface ProbeStore extends StitchStore {
    /** Every key touched, in order, with duplicates — `keys('circuit:')` is the usual read. */
    readonly touched: string[];
    /** The distinct keys touched under a prefix, in first-touch order. */
    keys(prefix?: string): string[];
}

export function probeStore(inner: StitchStore = memoryStore()): ProbeStore {
    const touched: string[] = [];
    return {
        touched,
        keys(prefix = '') {
            return [...new Set(touched.filter((k) => k.startsWith(prefix)))];
        },
        get(key) {
            touched.push(key);
            return inner.get(key);
        },
        async set(key, value, ttl) {
            touched.push(key);
            return inner.set(key, value, ttl);
        },
        async increment(key, ttl) {
            touched.push(key);
            return inner.increment(key, ttl);
        },
        close: () => inner.close?.() ?? Promise.resolve(),
    };
}
