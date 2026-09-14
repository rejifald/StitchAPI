// asyncStorageStore — a StitchStore backed by React Native's AsyncStorage.
//
// Attaching it makes the engine's process-local state persist across app restarts:
// the auth vault's cookie jar / token cache (so a logged-in user stays logged in)
// and throttle counters (so a client-side rate window survives a reload). Mirrors
// `@stitchapi/redis`: bring your own client — the store never imports AsyncStorage,
// it talks to a tiny normalized {@link AsyncStorageLike} surface, so the community
// module, an MMKV shim, a SecureStore wrapper, or a test double all drop in.
//
// Compliance with the store contract is proven against `conformance.store` from
// `stitchapi/testing` (see test/store.spec.ts).
import { systemClock } from 'stitchapi';
import type { Clock, StitchStore } from 'stitchapi';

/**
 * The minimal AsyncStorage surface {@link asyncStorageStore} uses. The default
 * export of `@react-native-async-storage/async-storage` satisfies it structurally
 * — you never implement this yourself.
 */
export interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/** Options for {@link asyncStorageStore}. */
export interface AsyncStorageStoreOptions {
    /**
     * Prefix applied to every key, for sharing one AsyncStorage with other data.
     * Applied on read and write so the store stays self-consistent. Default
     * `'stitch:'`.
     *
     * Deliberate P8 divergence from `redisStore`'s `''` default: AsyncStorage is
     * the app's single shared device-wide bucket — the app's own data lives right
     * next to the store's keys — so namespacing by default prevents collisions.
     * A Redis deployment typically dedicates a database/namespace instead.
     */
    keyPrefix?: string;
    /**
     * Time seam (ADR 0010) for TTL expiry. Defaults to `systemClock`; tests pass a
     * `manualClock()` from `stitchapi/testing` and drive expiry with `advance(ms)` —
     * the same object, spelled the same way, that already drives a stitch's retry
     * backoff and `@stitchapi/download`'s idle timer.
     *
     * Spelled `clock` and typed {@link Clock}, never a bare `now: () => number`
     * (CONTRACT.md P1): `now` is already an epoch-ms NUMBER on this contract — it is
     * what the envelope's expiry is compared against — so one token would carry two
     * value-spaces, a number here and a function there.
     */
    clock?: Clock;
}

// AsyncStorage holds opaque strings with NO native expiry, so each value rides in a
// JSON envelope carrying an absolute expiry (ms epoch). An expired read resolves to
// `undefined` and lazily removes the key.
interface Envelope {
    v: unknown;
    /** Absolute expiry (ms epoch); omitted = never expires. */
    e?: number;
}

/**
 * A {@link StitchStore} over AsyncStorage. Pass the AsyncStorage module (or
 * anything matching {@link AsyncStorageLike}):
 *
 * ```ts
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { seam } from 'stitchapi';
 * import { asyncStorageStore } from '@stitchapi/react-native';
 *
 * const api = seam({ store: asyncStorageStore(AsyncStorage) });
 * ```
 *
 * `increment` is serialized through an in-process queue so concurrent increments stay
 * atomic (RN is single-threaded, and a device-local store has one writer) — the
 * throttle counter behaves exactly as it does on Redis.
 */
export function asyncStorageStore(
    storage: AsyncStorageLike,
    opts: AsyncStorageStoreOptions = {},
): StitchStore {
    const prefix = opts.keyPrefix ?? 'stitch:';
    const clock = opts.clock ?? systemClock;
    const k = (key: string): string => prefix + key;

    const readEnvelope = async (key: string): Promise<Envelope | undefined> => {
        const raw = await storage.getItem(k(key));
        if (raw == null) return undefined;
        let env: Envelope;
        try {
            env = JSON.parse(raw) as Envelope;
        } catch {
            return undefined; // not written by us — treat as absent
        }
        if (env.e !== undefined && env.e <= clock.now()) {
            await storage.removeItem(k(key));
            return undefined;
        }
        return env;
    };

    const write = (key: string, env: Envelope): Promise<void> =>
        storage.setItem(k(key), JSON.stringify(env));

    // Serialize read-modify-write increments so 20 concurrent `increment` calls return
    // 1..20 exactly (the store contract's atomicity rule). AsyncStorage has no
    // atomic INCR, but a single-threaded JS queue gives the same guarantee.
    let tail: Promise<unknown> = Promise.resolve();
    const serialize = <T>(op: () => Promise<T>): Promise<T> => {
        const run = tail.then(op, op);
        tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    };

    return {
        async get(key) {
            return (await readEnvelope(key))?.v;
        },
        async set(key, value, ttl) {
            // `set(key, undefined)` is the cache's delete (ADR 0003 §8).
            if (value === undefined) {
                await storage.removeItem(k(key));
                return;
            }
            await write(
                key,
                ttl === undefined
                    ? { v: value }
                    : { v: value, e: clock.now() + ttl },
            );
        },
        increment(key, ttl) {
            return serialize(async () => {
                const env = await readEnvelope(key);
                const current = typeof env?.v === 'number' ? env.v : 0;
                const next = current + 1;
                // Set the expiry only when CREATING the counter, never extending it,
                // so a busy window still resets once it lapses (matches redisStore).
                // An absent `ttl` means no window — the counter never expires.
                const expiry =
                    env === undefined
                        ? ttl === undefined
                            ? undefined
                            : clock.now() + ttl
                        : env.e;
                await write(
                    key,
                    expiry === undefined ? { v: next } : { v: next, e: expiry },
                );
                return next;
            });
        },
    };
}
