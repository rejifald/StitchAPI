// Behaviour proof for @stitchapi/cloudflare-kv.
//
// We deliberately do NOT run `verifyStoreContract` from `stitchapi/testing`: that
// kit asserts the atomic-incr rule ("20 concurrent incrs net +20"), and Workers KV
// has no atomic counter, so `incr` throws by design (see src/index.ts). The
// contract would fail — correctly — so instead we prove the half KV *does* support
// (get/set/delete/TTL) against a faithful in-memory KVNamespace, and assert that
// `incr` rejects with the documented Durable-Object pointer.
import { cloudflareKvStore } from '../src';
import type { KVNamespaceLike } from '../src';

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
 */
class FakeKvNamespace implements KVNamespaceLike {
    private readonly data = new Map<string, Entry>();

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
            expiresAt: ttl == null ? Infinity : Date.now() + ttl * 1000,
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

// --- the atomic-incr gap ---------------------------------------------------

describe('@stitchapi/cloudflare-kv incr is unsupported', () => {
    test('incr rejects with a documented Durable-Object pointer', async () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        await expect(store.incr('rate', 1_000)).rejects.toThrow(
            /Durable Object/i,
        );
        await expect(store.incr('rate', 1_000)).rejects.toThrow(
            /not supported on Cloudflare Workers KV/i,
        );
        // `ttl` is optional on `incr` (StitchStore contract) — the no-window
        // call shape must typecheck, and still fails loud on KV.
        await expect(store.incr('rate')).rejects.toThrow(/Durable Object/i);
    });

    test('cloudflareKvStore has no close() (it owns no connection)', () => {
        const store = cloudflareKvStore(new FakeKvNamespace());
        expect(store.close).toBeUndefined();
    });
});
