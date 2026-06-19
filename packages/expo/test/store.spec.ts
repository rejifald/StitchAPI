// expoSecureStore reuses the AsyncStorage store's logic over expo-secure-store's
// *Async methods, with engine keys hex-encoded into SecureStore's restricted
// charset. Prove the contract still holds and the key encoding is safe.
import { expoSecureStore } from '../src/store';
import type { SecureStoreLike } from '../src/store';

import { assertConformance, verifyStoreContract } from 'stitchapi/testing';
import { describe, expect, test } from 'vitest';

function fakeSecureStore(): SecureStoreLike {
    const map = new Map<string, string>();
    return {
        async getItemAsync(key) {
            const v = map.get(key);
            return v === undefined ? null : v;
        },
        async setItemAsync(key, value) {
            map.set(key, value);
        },
        async deleteItemAsync(key) {
            map.delete(key);
        },
    };
}

describe('expoSecureStore', () => {
    test('satisfies the StitchStore contract', async () => {
        assertConformance(
            await verifyStoreContract(() => expoSecureStore(fakeSecureStore())),
        );
    });

    test('encodes engine keys into the SecureStore-safe charset', async () => {
        const seen: string[] = [];
        const secure: SecureStoreLike = {
            async getItemAsync() {
                return null;
            },
            async setItemAsync(key) {
                seen.push(key);
            },
            async deleteItemAsync() {},
        };
        // 'throttle:host:1' has ':' — illegal as a raw SecureStore key.
        await expoSecureStore(secure).set('throttle:host:1', 1);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(seen[0]).toMatch(/^[0-9a-f]+$/);
    });
});
