// C4 — does `cache` survive a BigInt body?
//
// The capture predicts: "A store that `JSON.stringify`s will throw `Do not know how to serialize a
// BigInt`. Test `memoryStore` and a JSON-backed store." Both are tested here, and the prediction
// splits cleanly:
//
//   memoryStore  — survives. It holds the value by reference; nothing serialises.
//   JSON store   — throws, with exactly the predicted message, on the WRITE.
//
// The measurement that is NOT in the capture, and is the more interesting one: the cache KEY
// encoder handles bigint deliberately (`cache.ts:43` — a `bigint:` type tag chosen so `42n` cannot
// collide with the string `'42n'`). So the failure is confined to the value-persistence layer, and
// a store that serialises with a bigint-aware replacer works end to end.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c4-cache.ts
import { memoryStore, stitch } from '../../../../packages/core/src/index';
import type { StitchStore } from '../../../../packages/core/src/types';
import { check, checkDigits, checkStr, finish, heading, note } from './harness';
import {
    BASE,
    ONE_ID_TEXT,
    SNOWFLAKE,
    bigintAdapter,
    wireAdapter,
} from './wire';

/**
 * A store that persists through JSON, the way a Redis/file/localStorage adapter does. This is the
 * shape the capture predicts will throw, built literally: `set` stringifies, `get` parses.
 */
function jsonStore(opts: { bigintSafe?: boolean } = {}): StitchStore & {
    lastError(): string;
} {
    const data = new Map<string, string>();
    let lastError = '';
    const replacer = opts.bigintSafe
        ? (_k: string, v: unknown) =>
              typeof v === 'bigint' ? `${v.toString()}n` : v
        : undefined;
    const store = {
        async get(key: string) {
            const s = data.get(key);
            return s === undefined ? undefined : (JSON.parse(s) as unknown);
        },
        async set(key: string, value: unknown) {
            try {
                data.set(key, JSON.stringify(value, replacer));
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                throw e;
            }
        },
        async increment(key: string) {
            const n = Number(data.get(key) ?? '0') + 1;
            data.set(key, String(n));
            return n;
        },
        lastError: () => lastError,
    };
    return store as StitchStore & { lastError(): string };
}

/** Run a cached stitch twice and report both outcomes plus the transport call count. */
async function twice(
    adapter: ReturnType<typeof wireAdapter>,
    store: StitchStore,
): Promise<{
    first: { ok: boolean; data: unknown; message: string };
    second: { ok: boolean; data: unknown; message: string };
    calls: number;
}> {
    const call = stitch({
        name: 'getThing',
        baseUrl: BASE,
        path: '/v1/things/1',
        adapter,
        store,
        cache: { ttl: '60s' },
    });
    const a = await call.safe();
    const b = await call.safe();
    return {
        first: { ok: a.ok, data: a.data, message: a.error?.message ?? '' },
        second: { ok: b.ok, data: b.data, message: b.error?.message ?? '' },
        calls: adapter.count(),
    };
}

async function main(): Promise<void> {
    heading('C4 (a) — the control: a plain (corrupted) body caches fine');
    {
        const r = await twice(wireAdapter(ONE_ID_TEXT), memoryStore());
        check('first call ok', r.first.ok, true);
        check('second call ok', r.second.ok, true);
        check('transport calls (2 = no cache, 1 = a hit)', r.calls, 1);
        checkDigits(
            'the cached value — corrupted, and cached that way',
            (r.second.data as { id: unknown }).id,
            '1234567890123456768',
        );
        note(
            'so the cache faithfully preserves the wrong number. Worth stating: caching does not add a corruption and does not remove one',
            '',
        );
    }

    heading('C4 (b) — `memoryStore` with a BigInt body: SURVIVES');
    {
        const r = await twice(bigintAdapter(ONE_ID_TEXT), memoryStore());
        check('first call ok', r.first.ok, true);
        check('second call ok', r.second.ok, true);
        check('transport calls', r.calls, 1);
        checkDigits(
            'and the value came back off the cache as a BigInt',
            (r.second.data as { id: unknown }).id,
            `${SNOWFLAKE}n`,
        );
        check(
            'typeof the cached value',
            typeof (r.second.data as { id: unknown }).id,
            'bigint',
        );
        note(
            '`memoryStore` keeps `{ value, expires }` in a Map — the value is held by reference, never encoded. So the default store is BigInt-clean',
            '',
        );
    }

    heading('C4 (c) — a JSON-serialising store with a BigInt body: THROWS');
    {
        const store = jsonStore();
        const adapter = bigintAdapter(ONE_ID_TEXT);
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter,
            store,
            cache: { ttl: '60s' },
        });
        const first = await call.safe();
        checkStr(
            'the exact error the store threw',
            store.lastError(),
            'Do not know how to serialize a BigInt',
        );
        note(
            'and what the CALLER saw — ok=' +
                String(first.ok) +
                ', message=' +
                JSON.stringify(first.error?.message ?? ''),
            '',
        );
        check('the call FAILED because the cache WRITE threw', first.ok, false);
        note(
            'the corrupted-body control through the same store, for contrast',
            '',
        );
        const control = jsonStore();
        const ok = await twice(wireAdapter(ONE_ID_TEXT), control);
        check('control: first ok', ok.first.ok, true);
        check('control: second ok', ok.second.ok, true);
        checkStr('control: store error', control.lastError(), '');
    }

    heading('C4 (d) — the same JSON store WITH a bigint-aware replacer');
    {
        // The repair to the repair. It works, and it is lossy in a new way: the value comes back
        // as the string "…n", not as a BigInt, unless the store also revives it.
        const store = jsonStore({ bigintSafe: true });
        const r = await twice(bigintAdapter(ONE_ID_TEXT), store);
        check('first call ok', r.first.ok, true);
        check('second call ok', r.second.ok, true);
        check('transport calls', r.calls, 1);
        checkStr('store error', store.lastError(), '');
        note(
            'what came back off the cache',
            (r.second.data as { id: unknown }).id,
        );
        check(
            'typeof the value after a cache round-trip',
            typeof (r.second.data as { id: unknown }).id,
            'string',
        );
        check(
            'so a cache HIT and a cache MISS now return different TYPES',
            typeof (r.first.data as { id: unknown }).id !==
                typeof (r.second.data as { id: unknown }).id,
            true,
        );
        note(
            '→ this is the sharpest edge in C4. The digits survive, but `typeof data.id` is `bigint` on a miss and `string` on a hit, so the bug moves from "wrong number" to "type depends on cache state" — which a test suite with a cold cache will never see',
            '',
        );
    }

    heading('C4 (e) — the cache KEY encoder already knows about bigint');
    {
        // Not in the capture, and it is the reason (c) fails on the VALUE rather than on the KEY.
        // `cache.ts:43` renders a bigint as the tagged token `bigint:<digits>` — chosen, per its
        // comment, so `42n` cannot collide with the string `'42n'`. Measured through a `query`,
        // which is part of the cache key.
        const adapter = bigintAdapter(ONE_ID_TEXT);
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter,
            store: memoryStore(),
            cache: { ttl: '60s' },
        });
        await call.safe({ query: { since: BigInt(SNOWFLAKE) } });
        await call.safe({ query: { since: BigInt(SNOWFLAKE) } });
        check(
            'two identical bigint queries → one transport call',
            adapter.count(),
            1,
        );
        await call.safe({ query: { since: `${SNOWFLAKE}n` } });
        check(
            'and the STRING "…n" is a different key, not a collision',
            adapter.count(),
            2,
        );
        note(
            '→ a bigint in a cache key is handled deliberately and does not collide with its own string spelling. The cache breaks on VALUE persistence only',
            '',
        );
    }

    finish(
        'C4',
        'CONFIRMED, and narrower than the capture drew it. `memoryStore` SURVIVES a BigInt body completely — it holds `{ value, expires }` in a Map by reference and never encodes, so a cache hit returns 1234567890123456789n unchanged. A JSON-serialising store THROWS on the write with exactly the predicted string, "Do not know how to serialize a BigInt", and the throw is FATAL to the call (ok=false), not a silent cache miss. Adding a bigint-aware replacer to that store fixes the throw and introduces a subtler bug, measured: the value survives as the string "1234567890123456789n", so `typeof data.id` is `bigint` on a cache MISS and `string` on a cache HIT — a type that depends on cache state, which a cold-cache test suite never sees. And the part the capture did not predict: the cache KEY encoder already handles bigint on purpose (`cache.ts:43`, a `bigint:` type tag chosen so `42n` cannot collide with the string `"42n"`) — two identical bigint queries coalesced to one transport call and the string spelling was correctly a different key. The cache breaks on value persistence only',
    );
}

void main();
