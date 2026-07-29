// Regression: the Upstash adapter must round-trip JSON-parseable STRING values.
//
// `redisStore.set(value)` writes `JSON.stringify(value)`. The Upstash REST client
// auto-deserializes ONE JSON layer on read. So for a value that is itself a
// JSON-parseable string — "null", "123", '{"x":1}' — the store writes the JSON
// envelope (e.g. '"null"'), Upstash returns the *string* `null` (one layer
// peeled), and unless `fromUpstash.get` re-serializes it, `redisStore.get` then
// `JSON.parse`s that string again and hands back the PARSED value (the real
// `null`) instead of the string the caller stored. This is an Upstash-only
// divergence; the ioredis / node-redis adapters return exact bytes and were
// always correct. The fix re-serializes every non-null reply, so the byte stream
// `redisStore.get` parses matches exactly what `redisStore.set` wrote.
import { fromUpstash, redisStore } from '../src';
import type { UpstashLike } from '../src';

import type { StitchStore } from 'stitchapi';
import { describe, expect, test } from 'vitest';

// A faithful @upstash/redis test double: `set` stores the raw string it is given;
// `get` mimics Upstash's automatic JSON deserialization — it returns
// `JSON.parse(stored)` when the stored string is valid JSON, else the raw string.
// This is precisely the behavior that makes the bug observable.
function fakeUpstash(): UpstashLike & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        async get(key) {
            const raw = store.get(key);
            if (raw == null) return null;
            // Upstash auto-deserializes JSON string replies.
            try {
                return JSON.parse(raw) as unknown;
            } catch {
                return raw;
            }
        },
        async set(key, value) {
            // The real client stores the exact string it is handed.
            store.set(key, value);
            return 'OK';
        },
        async del(key) {
            store.delete(key);
            return 1;
        },
        async eval() {
            // Not exercised by these round-trip assertions.
            return 1;
        },
    };
}

describe('fromUpstash — JSON-parseable string values round-trip', () => {
    // Each of these is a STRING whose contents happen to be valid JSON. The store
    // must hand the identical string back; the bug returned the parsed value.
    test.each([
        ['the string "null"', 'null'],
        ['the string "123"', '123'],
        ['the string "true"', 'true'],
        ['a JSON-object string', '{"x":1}'],
        ['a JSON-array string', '[1,2]'],
    ])('%s survives set → get unchanged', async (_label, value) => {
        const store: StitchStore = redisStore(fromUpstash(fakeUpstash()));
        await store.set('k', value);
        const back = await store.get('k');
        expect(back).toBe(value); // strict: same string, not the parsed value
        expect(typeof back).toBe('string');
    });

    test('a plain object value still round-trips', async () => {
        const store = redisStore(fromUpstash(fakeUpstash()));
        const value = { a: 1, b: ['x', 'y'], c: { d: true } };
        await store.set('obj', value);
        expect(await store.get('obj')).toEqual(value);
    });

    test('a bare INCR counter (Upstash returns a number) round-trips', async () => {
        // A counter is written by `increment`, not `set`, so the stored value is the
        // bare string "1"; Upstash's auto-deserialize turns that reply into the
        // number 1. `fromUpstash.get` must re-serialize it to "1" so
        // `redisStore.get` reads back the number 1, not `undefined`/a throw.
        const client = fakeUpstash();
        client.store.set('c', '1'); // as INCR would leave it (bare counter)
        const store = redisStore(fromUpstash(client));
        expect(await store.get('c')).toBe(1);
    });

    test('an absent key reads back as undefined', async () => {
        const store = redisStore(fromUpstash(fakeUpstash()));
        expect(await store.get('missing')).toBeUndefined();
    });
});
