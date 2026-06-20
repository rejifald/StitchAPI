// Targeted behaviour tests for @stitchapi/deno-kv that the conformance proof
// (`conformance.spec.ts`) does not pin down: the sliding-window TTL rule (the
// counter's expiry is set only when it is CREATED, never extended on later
// incrs), the compare-and-set retry EXHAUSTION error, the array-key shape (flat
// vs prefixed), the cache-delete (`set(k, undefined)`), and `close()` delegation.
// Driven by a recording fake KV that captures every write's `expireIn` and can be
// forced to lose every atomic commit.
import { denoKvStore } from '../src';
import type {
    DenoAtomicCheck,
    DenoAtomicCommitResult,
    DenoAtomicOperation,
    DenoKvEntryMaybe,
    DenoKvKey,
    DenoKvLike,
} from '../src';

import { describe, expect, test } from 'vitest';

interface Recording {
    kv: DenoKvLike;
    sets: { key: DenoKvKey; expireIn: number | undefined }[];
    atomicSets: { key: DenoKvKey; expireIn: number | undefined }[];
    deletes: DenoKvKey[];
    closed: () => boolean;
}

function recordingKv(opts: { failAtomic?: boolean } = {}): Recording {
    const data = new Map<string, { value: unknown; versionstamp: string }>();
    const sets: { key: DenoKvKey; expireIn: number | undefined }[] = [];
    const atomicSets: { key: DenoKvKey; expireIn: number | undefined }[] = [];
    const deletes: DenoKvKey[] = [];
    let seq = 0;
    let closedFlag = false;
    const id = (key: DenoKvKey): string => JSON.stringify(key);

    const kv: DenoKvLike = {
        async get(key): Promise<DenoKvEntryMaybe> {
            const e = data.get(id(key));
            return e
                ? { value: e.value, versionstamp: e.versionstamp }
                : { value: null, versionstamp: null };
        },
        async set(key, value, options): Promise<unknown> {
            sets.push({ key, expireIn: options?.expireIn });
            const versionstamp = String(++seq);
            data.set(id(key), { value, versionstamp });
            return { ok: true, versionstamp };
        },
        async delete(key): Promise<void> {
            deletes.push(key);
            data.delete(id(key));
        },
        atomic(): DenoAtomicOperation {
            const checks: DenoAtomicCheck[] = [];
            let write:
                | {
                      key: DenoKvKey;
                      value: unknown;
                      expireIn: number | undefined;
                  }
                | undefined;
            const op: DenoAtomicOperation = {
                check(...c): DenoAtomicOperation {
                    checks.push(...c);
                    return op;
                },
                set(key, value, options): DenoAtomicOperation {
                    write = { key, value, expireIn: options?.expireIn };
                    return op;
                },
                async commit(): Promise<DenoAtomicCommitResult> {
                    if (opts.failAtomic) return { ok: false };
                    for (const c of checks) {
                        const e = data.get(id(c.key));
                        const live = e ? e.versionstamp : null;
                        if (live !== c.versionstamp) return { ok: false };
                    }
                    if (write) {
                        atomicSets.push({
                            key: write.key,
                            expireIn: write.expireIn,
                        });
                        const versionstamp = String(++seq);
                        data.set(id(write.key), {
                            value: write.value,
                            versionstamp,
                        });
                        return { ok: true, versionstamp };
                    }
                    return { ok: true, versionstamp: '' };
                },
            };
            return op;
        },
        close(): void {
            closedFlag = true;
        },
    };
    return { kv, sets, atomicSets, deletes, closed: () => closedFlag };
}

describe('denoKvStore — incr TTL window', () => {
    test('sets the counter TTL only on creation, never extending it on later incrs', async () => {
        const rec = recordingKv();
        const store = denoKvStore(rec.kv);

        expect(await store.incr('rate', 1000)).toBe(1);
        expect(await store.incr('rate', 1000)).toBe(2);
        expect(await store.incr('rate', 1000)).toBe(3);

        // expireIn only on the first (creating) commit — a busy window must reset,
        // not slide forever (matches redis's "PEXPIRE only when v == 1" rule).
        expect(rec.atomicSets.map((s) => s.expireIn)).toEqual([
            1000,
            undefined,
            undefined,
        ]);
    });

    test('throws after exhausting maxIncrRetries lost compare-and-set races', async () => {
        const rec = recordingKv({ failAtomic: true });
        const store = denoKvStore(rec.kv, { maxIncrRetries: 3 });
        await expect(store.incr('x', 1000)).rejects.toThrow(
            /lost 4 compare-and-set races/,
        );
    });
});

describe('denoKvStore — keys & lifecycle', () => {
    test('maps a string key to a flat one-segment array key by default', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv).set('k', 'v');
        expect(rec.sets[0]?.key).toEqual(['k']);
    });

    test('keyPrefix maps a string key to a two-segment array key', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv, { keyPrefix: 'app' }).set('k', 'v');
        expect(rec.sets[0]?.key).toEqual(['app', 'k']);
    });

    test('set(key, undefined) deletes the key (cache delete) and writes nothing', async () => {
        const rec = recordingKv();
        await denoKvStore(rec.kv).set('k', undefined);
        expect(rec.deletes).toEqual([['k']]);
        expect(rec.sets).toHaveLength(0);
    });

    test('close() delegates to the underlying handle', async () => {
        const rec = recordingKv();
        const store = denoKvStore(rec.kv);
        expect(typeof store.close).toBe('function');
        await store.close?.();
        expect(rec.closed()).toBe(true);
    });
});
