// Direct unit tests for the pure pieces of src/store.ts. store.spec.ts drives the store-backed
// throttle + sessions through real stitches (integration), but three building blocks are only ever
// exercised indirectly:
//   memoryStore   — the bare key/value contract (get-missing, set/get, set(undefined) deletes,
//                   incr atomicity, close clears);
//   vaultView     — the namespaced lens that prefixes every key and delegates close to the backend;
//   chainThrottle — composing gates: acquire each in order (summing waitedMs), release in REVERSE,
//                   threading acquire options to every gate.
import { chainThrottle, memoryStore, vaultView } from '../src/store';
import type { Throttle } from '../src/store';
import type { StitchStore } from '../src/types';

describe('memoryStore (key/value contract)', () => {
    test('get of a missing key is undefined; set/get round-trips', async () => {
        const s = memoryStore();
        expect(await s.get('missing')).toBeUndefined();
        await s.set('k', 'v');
        expect(await s.get('k')).toBe('v');
    });

    test('set(undefined) deletes the key', async () => {
        const s = memoryStore();
        await s.set('k', 'v');
        await s.set('k', undefined);
        expect(await s.get('k')).toBeUndefined();
    });

    test('incr starts at 1 and increments the same key atomically', async () => {
        const s = memoryStore();
        expect(await s.incr('c', 1000)).toBe(1);
        expect(await s.incr('c', 1000)).toBe(2);
        expect(await s.incr('c', 1000)).toBe(3);
    });

    test('close() clears all state', async () => {
        const s = memoryStore();
        await s.set('k', 'v');
        await s.close?.();
        expect(await s.get('k')).toBeUndefined();
    });
});

describe('vaultView (namespaced lens)', () => {
    test('prefixes every key into the backend (and reads back through the lens)', async () => {
        const backend = memoryStore();
        const vault = vaultView(backend);
        await vault.set('token', 'abc');
        expect(await backend.get('vault:token')).toBe('abc'); // stored under the prefix
        expect(await backend.get('token')).toBeUndefined(); // not under the bare key
        expect(await vault.get('token')).toBe('abc'); // read back through the lens
        await vault.incr('count', 1000);
        expect(await backend.get('vault:count')).toBe(1);
    });

    test('honours a custom prefix', async () => {
        const backend = memoryStore();
        const vault = vaultView(backend, 'sec:');
        await vault.set('k', 'v');
        expect(await backend.get('sec:k')).toBe('v');
    });

    test('close() delegates to the backend', async () => {
        let closed = false;
        const backend: StitchStore = {
            get: async () => undefined,
            set: async () => undefined,
            incr: async () => 1,
            close: async () => {
                closed = true;
            },
        };
        await vaultView(backend).close?.();
        expect(closed).toBe(true);
    });

    test('a backend with no close() yields a view with no close()', () => {
        const backend: StitchStore = {
            get: async () => undefined,
            set: async () => undefined,
            incr: async () => 1,
        };
        expect('close' in vaultView(backend)).toBe(false);
    });
});

describe('chainThrottle (compose gates)', () => {
    const recorder = () => {
        const order: string[] = [];
        const mk = (name: string, waited: number): Throttle => ({
            acquire: async (key, opts) => {
                order.push(
                    `acq:${name}:${key}:${opts?.rateOnly ? 'rateOnly' : 'full'}`,
                );
                return { waitedMs: waited };
            },
            release: (key) => {
                order.push(`rel:${name}:${key}`);
            },
        });
        return { order, mk };
    };

    test('acquires every gate in order and sums waitedMs', async () => {
        const { order, mk } = recorder();
        const chain = chainThrottle([mk('a', 10), mk('b', 5)]);
        const { waitedMs } = await chain.acquire('K');
        expect(waitedMs).toBe(15);
        expect(order).toEqual(['acq:a:K:full', 'acq:b:K:full']);
    });

    test('releases in REVERSE acquisition order', async () => {
        const { order, mk } = recorder();
        const chain = chainThrottle([mk('a', 0), mk('b', 0)]);
        await chain.acquire('K');
        order.length = 0; // drop the acquire entries; focus on release order
        chain.release('K');
        expect(order).toEqual(['rel:b:K', 'rel:a:K']);
    });

    test('threads acquire options (rateOnly) to every gate', async () => {
        const { order, mk } = recorder();
        const chain = chainThrottle([mk('a', 0), mk('b', 0)]);
        await chain.acquire('K', { rateOnly: true });
        expect(order).toEqual(['acq:a:K:rateOnly', 'acq:b:K:rateOnly']);
    });
});
