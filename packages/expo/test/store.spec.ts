// expoSecureStore reuses the AsyncStorage store's logic over expo-secure-store's
// *Async methods, with engine keys hex-encoded into SecureStore's restricted
// charset. Prove the contract still holds and the key encoding is safe.
import { expoSecureStore } from '../src/store';
import type { SecureStoreLike } from '../src/store';

import { conformance } from 'stitchapi/testing';
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
        conformance.assert(
            await conformance.store(() => expoSecureStore(fakeSecureStore())),
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

    test('pads each code unit to 4 hex digits so distinct keys never collide', async () => {
        const api = expoSecureStore(fakeSecureStore());
        // Codes [1, 0] and [16] both hex to "10" under a NAIVE, unpadded
        // per-code-unit encoding ("1"+"0" vs "10"). padStart(4) keeps them
        // distinct ("00010000" vs "0010") — without it the second write would
        // clobber the first.
        const keyA = String.fromCharCode(1, 0);
        const keyB = String.fromCharCode(16);

        await api.set(keyA, 'first');
        await api.set(keyB, 'second');

        expect(await api.get(keyA)).toBe('first');
        expect(await api.get(keyB)).toBe('second');
    });
});
