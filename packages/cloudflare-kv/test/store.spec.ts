// Behaviour proof for @stitchapi/cloudflare-kv.
//
// `cloudflareKvStore` is a get/set-only store (#882): Workers KV has no atomic
// read-modify-write, so it implements none of the contract's optional capabilities
// (`increment`, `reserve`, `lease`/`release`). It runs `conformance.store` from
// `stitchapi/testing`, which checks the capabilities a store HAS — here the base
// group (get/set/delete/TTL/isolation) — against a faithful in-memory
// KVNamespace. Then it pins what the absence means end to end: bulk cache
// invalidation still works, and a throttle says once that it is per-process.
import { cloudflareKvStore } from '../src';
import type { KVNamespaceLike } from '../src';

import { stitch } from 'stitchapi';
import type { Adapter, StitchEvent } from 'stitchapi';
import { conformance } from 'stitchapi/testing';
import { describe, expect, test } from 'vitest';

// --- a faithful in-memory Workers KV namespace ----------------------------

interface Entry {
    value: string;
    /** Epoch ms at which the key expires; `Infinity` = no expiry. */
    expiresAt: number;
}

/**
 * The slice of `KVNamespace` the store touches, in memory. Mirrors the real
 * runtime: `expirationTtl` is in **seconds** and rejected below 60s, and reads of
 * an expired key see `null`.
 *
 * `msPerSecond` is how long one KV second lasts here — 1000 by default (real
 * time). The conformance run compresses it to 1 so the kit's real-timer TTL rules
 * can watch a 60-"second" floor lapse in 60ms; every unit conversion the store
 * does is unchanged, only the fake's clock runs fast.
 */
class FakeKvNamespace implements KVNamespaceLike {
    private readonly data = new Map<string, Entry>();

    constructor(private readonly msPerSecond = 1000) {}

    private live(key: string): Entry | undefined {
        const e = this.data.get(key);
        if (!e) return undefined;
        if (e.expiresAt <= Date.now()) {
            this.data.delete(key);
            return undefined;
        }
        return e;
    }

    async get(key: string): Promise<string | null> {
        return this.live(key)?.value ?? null;
    }

    async put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
    ): Promise<void> {
        const ttl = options?.expirationTtl;
        if (ttl != null && ttl < 60) {
            throw new Error(`KV PUT: expirationTtl must be >= 60s, got ${ttl}`);
        }
        this.data.set(key, {
            value,
            expiresAt:
                ttl == null ? Infinity : Date.now() + ttl * this.msPerSecond,
        });
    }

    async delete(key: string): Promise<void> {
        this.data.delete(key);
    }

    /** Test-only peek at the raw stored TTL window. */
    rawExpiresAt(key: string): number | undefined {
        return this.data.get(key)?.expiresAt;
    }
}

// --- get / set / delete ----------------------------------------------------

describe('@stitchapi/cloudflare-kv get/set/delete', () => {
    test('round-trips JSON values', async () => {
        const store = cloudflareKvStore(new FakeKvNamespace());

        await store.set('a', { n: 1, s: 'x', nested: [true, null] });
        expect(await store.get('a')).toEqual({
            n: 1,
            s: 'x',
            nested: [true, null],
        });

        // primitives survive the JSON envelope too
        await store.set('b', 42);
        expect(await store.get('b')).toBe(42);
        await store.set('c', 'plain');
        expect(await store.get('c')).toBe('plain');
    });

    test('missing key reads as undefined', async () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        expect(await store.get('nope')).toBeUndefined();
    });

    test('set(key, undefined) deletes the key', async () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        await store.set('k', 'v');
        expect(await store.get('k')).toBe('v');

        await store.set('k', undefined);
        expect(await store.get('k')).toBeUndefined();
    });

    test('non-JSON raw value is handed back as-is', async () => {
        const kv = new FakeKvNamespace();
        await kv.put('seeded', 'not json{');
        const store = cloudflareKvStore(kv);
        expect(await store.get('seeded')).toBe('not json{');
    });
});

// --- TTL conversion (ms -> seconds, floored to KV's 60s minimum) -----------

describe('@stitchapi/cloudflare-kv TTL', () => {
    test('no ttl => no expiry', async () => {
        const kv = new FakeKvNamespace();
        const store = cloudflareKvStore(kv);
        await store.set('k', 'v');
        expect(kv.rawExpiresAt('k')).toBe(Infinity);
    });

    test('sub-60s ttl is floored to the 60s KV minimum', async () => {
        const kv = new FakeKvNamespace();
        const store = cloudflareKvStore(kv);
        const before = Date.now();
        // 5s requested -> must become 60s, or the fake KV would reject the put.
        await store.set('k', 'v', 5_000);
        const at = kv.rawExpiresAt('k');
        expect(at).toBeGreaterThanOrEqual(before + 60_000);
        expect(await store.get('k')).toBe('v');
    });

    test('ttl above the floor is converted ms -> ceil(seconds)', async () => {
        const kv = new FakeKvNamespace();
        const store = cloudflareKvStore(kv);
        const before = Date.now();
        // 90_500ms -> ceil = 91s
        await store.set('k', 'v', 90_500);
        const at = kv.rawExpiresAt('k') ?? 0;
        expect(at).toBeGreaterThanOrEqual(before + 91_000);
        expect(at).toBeLessThan(before + 92_000);
    });

    test('expired key reads as undefined', async () => {
        const kv = new FakeKvNamespace();
        const store = cloudflareKvStore(kv);
        await store.set('k', 'v', 60_000);
        // fast-forward past the window
        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 61_000;
            expect(await store.get('k')).toBeUndefined();
        } finally {
            Date.now = realNow;
        }
    });
});

// --- keyPrefix -------------------------------------------------------------

describe('@stitchapi/cloudflare-kv keyPrefix', () => {
    test('prefixes every key consistently on read and write', async () => {
        const kv = new FakeKvNamespace();
        const store = cloudflareKvStore(kv, { keyPrefix: 'app:' });

        await store.set('k', 'v');
        // stored under the prefixed key...
        expect(await kv.get('app:k')).toBe(JSON.stringify('v'));
        // ...and the unprefixed slot is untouched.
        expect(await kv.get('k')).toBeNull();
        // round-trips through the store's own prefixed view.
        expect(await store.get('k')).toBe('v');
    });
});

// --- conformance: the capabilities the store has --------------------------

describe('@stitchapi/cloudflare-kv conformance', () => {
    test('passes conformance.store — the base group, the only one it claims', async () => {
        const report = await conformance.store(() =>
            cloudflareKvStore(new FakeKvNamespace(1)),
        );
        conformance.assert(report);
        expect(report.passed).toContain('set: a ttl entry expires');
        // No capability group ran, because the store claims none.
        expect(
            report.passed.filter((r) =>
                /^(increment|reserve|lease|release):/.test(r),
            ),
        ).toEqual([]);
    });

    test('implements only get/set — no counter, no pacing cell, no lease, no close', () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        expect(Object.keys(store).sort()).toEqual(['get', 'set']);
    });
});

// --- what the absence means, end to end -----------------------------------

function counting(): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        return { status: 200, headers: {}, body: { n: calls } };
    };
    return { adapter, calls: () => calls };
}

describe('@stitchapi/cloudflare-kv features without the optional verbs', () => {
    test('bulk cache invalidation works — a generation bump is a plain set', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: 'https://api.test/r',
            adapter,
            trace: false,
            store: cloudflareKvStore(new FakeKvNamespace()),
            cache: { ttl: '5m', tenancy: 'app' },
        });
        await s();
        await s();
        expect(calls()).toBe(1);
        await s.cache.invalidate();
        await s();
        expect(calls()).toBe(2);
    });

    test('a throttle paces per process and says so once (throttle.per-process)', async () => {
        const { adapter } = counting();
        const s = stitch({
            url: 'https://api.test/r',
            adapter,
            trace: false,
            store: cloudflareKvStore(new FakeKvNamespace()),
            throttle: { rate: '1000/s', concurrency: 4 },
        });
        const infos: StitchEvent[] = [];
        for (let i = 0; i < 3; i++)
            for await (const e of s.stream())
                if (e.type === 'info' && e.topic === 'throttle.per-process')
                    infos.push(e);
        expect(infos).toHaveLength(1);
        expect(infos[0]).toMatchObject({
            detail:
                'rate: the store has no reserve or increment; ' +
                'concurrency: the store has no lease/release',
        });
    });

    test('cloudflareKvStore has no close() (it owns no connection)', () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        expect(store.close).toBeUndefined();
    });
});
