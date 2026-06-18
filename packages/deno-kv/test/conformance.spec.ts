// Conformance proof for @stitchapi/deno-kv. `denoKvStore` must pass
// `verifyStoreContract` from `stitchapi/testing`.
//
// The run is hermetic and offline: a faithful in-memory `Deno.Kv` (a Map with
// expiry + a monotonic versionstamp + an atomic builder that fails the commit
// when a checked versionstamp is stale). Single-threaded JS makes the engine's
// read-modify-write atomic, exactly as Deno KV's real `atomic().commit()` does
// against its storage — so the contract's "20 concurrent incrs net +20" rule
// holds here and on real Deno KV alike, including the compare-and-set RETRY path
// (the fake genuinely fails losing commits, so the store must re-read and retry).
import { denoKvStore } from '../src';
import type {
    DenoAtomicCheck,
    DenoAtomicCommitResult,
    DenoAtomicOperation,
    DenoKvEntryMaybe,
    DenoKvKey,
    DenoKvLike,
} from '../src';

import { assertConformance, verifyStoreContract } from 'stitchapi/testing';
import { describe, test } from 'vitest';

// --- a faithful in-memory Deno KV -----------------------------------------

interface Entry {
    value: unknown;
    versionstamp: string;
    /** Epoch ms at which the key expires; `Infinity` = no expiry. */
    expiresAt: number;
}

/** Array key → a stable string handle for the backing Map. */
function keyId(key: DenoKvKey): string {
    return JSON.stringify(key);
}

class FakeDenoKv implements DenoKvLike {
    private readonly data = new Map<string, Entry>();
    private seq = 0n;

    private nextStamp(): string {
        // Deno's versionstamps are 20-char hex; any monotonic unique string works.
        this.seq += 1n;
        return this.seq.toString(16).padStart(20, '0');
    }

    private live(id: string): Entry | undefined {
        const e = this.data.get(id);
        if (!e) return undefined;
        if (e.expiresAt <= Date.now()) {
            this.data.delete(id);
            return undefined;
        }
        return e;
    }

    async get(key: DenoKvKey): Promise<DenoKvEntryMaybe> {
        const e = this.live(keyId(key));
        return e
            ? { value: e.value, versionstamp: e.versionstamp }
            : { value: null, versionstamp: null };
    }

    async set(
        key: DenoKvKey,
        value: unknown,
        options?: { expireIn?: number },
    ): Promise<unknown> {
        const stamp = this.write(key, value, options?.expireIn);
        return { ok: true, versionstamp: stamp };
    }

    async delete(key: DenoKvKey): Promise<void> {
        this.data.delete(keyId(key));
    }

    atomic(): DenoAtomicOperation {
        return new FakeAtomic(this);
    }

    // --- internals the atomic builder drives (sync, so no interleave) ------

    /** True iff every check's versionstamp still matches the live entry. */
    checksPass(checks: DenoAtomicCheck[]): boolean {
        for (const c of checks) {
            const e = this.live(keyId(c.key));
            const live = e ? e.versionstamp : null;
            if (live !== c.versionstamp) return false;
        }
        return true;
    }

    write(key: DenoKvKey, value: unknown, expireIn?: number): string {
        const versionstamp = this.nextStamp();
        this.data.set(keyId(key), {
            value,
            versionstamp,
            expiresAt: expireIn == null ? Infinity : Date.now() + expireIn,
        });
        return versionstamp;
    }
}

/** A minimal `atomic()` builder: queue checks + one set, then commit-or-fail. */
class FakeAtomic implements DenoAtomicOperation {
    private readonly checks: DenoAtomicCheck[] = [];
    private write:
        | { key: DenoKvKey; value: unknown; expireIn: number | undefined }
        | undefined;

    constructor(private readonly kv: FakeDenoKv) {}

    check(...checks: DenoAtomicCheck[]): DenoAtomicOperation {
        this.checks.push(...checks);
        return this;
    }

    set(
        key: DenoKvKey,
        value: unknown,
        options?: { expireIn?: number },
    ): DenoAtomicOperation {
        this.write = { key, value, expireIn: options?.expireIn };
        return this;
    }

    // Synchronous read-validate-write under JS's single thread — the same
    // all-or-nothing guarantee Deno KV gives across isolates.
    async commit(): Promise<DenoAtomicCommitResult> {
        if (!this.kv.checksPass(this.checks)) return { ok: false };
        if (!this.write) return { ok: true, versionstamp: '' };
        const versionstamp = this.kv.write(
            this.write.key,
            this.write.value,
            this.write.expireIn,
        );
        return { ok: true, versionstamp };
    }
}

// --- the hermetic contract run --------------------------------------------

describe('@stitchapi/deno-kv store contract', () => {
    test('denoKvStore(...) passes the store contract', async () => {
        assertConformance(
            await verifyStoreContract(() => denoKvStore(new FakeDenoKv())),
        );
    });

    test('denoKvStore(..., { keyPrefix }) passes the store contract', async () => {
        assertConformance(
            await verifyStoreContract(() =>
                denoKvStore(new FakeDenoKv(), { keyPrefix: 'app:' }),
            ),
        );
    });
});
