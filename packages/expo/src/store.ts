// expoSecureStore — a StitchStore backed by expo-secure-store (encrypted keychain
// / keystore). The right default for the auth vault on device: tokens and cookie
// jars are stored encrypted at rest rather than in plaintext AsyncStorage.
//
// It REUSES @stitchapi/react-native's `asyncStorageStore` for all the store logic
// (JSON envelope, TTL, serialized atomic incr); only two things differ from
// AsyncStorage and live here: the `*Async` method names, and SecureStore's
// restricted key charset (keys allow only `[A-Za-z0-9._-]`), which we satisfy by
// hex-encoding every engine key.
import { asyncStorageStore } from '@stitchapi/react-native';
import type {
    AsyncStorageLike,
    AsyncStorageStoreOptions,
} from '@stitchapi/react-native';
import type { StitchStore } from 'stitchapi';

/**
 * The minimal `expo-secure-store` surface {@link expoSecureStore} uses. The module
 * (`import * as SecureStore from 'expo-secure-store'`) satisfies it structurally.
 */
export interface SecureStoreLike {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
}

/** Options for {@link expoSecureStore} (same as the AsyncStorage store). */
export type ExpoSecureStoreOptions = AsyncStorageStoreOptions;

// SecureStore keys allow only [A-Za-z0-9._-]; engine keys may contain ':' and more.
// Hex-encode each UTF-16 code unit to a safe, collision-free key — and avoid a
// TextEncoder polyfill (which Expo does not ship) by working over code units.
function toSecureKey(key: string): string {
    let out = '';
    for (let i = 0; i < key.length; i++) {
        out += key.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return out;
}

/**
 * A {@link StitchStore} over `expo-secure-store`. Pass the module:
 *
 * ```ts
 * import * as SecureStore from 'expo-secure-store';
 * import { seam } from 'stitchapi';
 * import { expoSecureStore } from '@stitchapi/expo';
 *
 * // Encrypted vault for auth tokens/cookies; pair with asyncStorageStore for
 * // non-secret throttle counters if you want those persisted too.
 * const api = seam({ secretStore: expoSecureStore(SecureStore) });
 * ```
 *
 * Values ride in the same JSON envelope as the AsyncStorage store (TTL-aware); keep
 * individual values under SecureStore's ~2KB limit (auth tokens fit comfortably).
 */
export function expoSecureStore(
    secure: SecureStoreLike,
    opts: ExpoSecureStoreOptions = {},
): StitchStore {
    const storage: AsyncStorageLike = {
        getItem: (key) => secure.getItemAsync(toSecureKey(key)),
        setItem: (key, value) => secure.setItemAsync(toSecureKey(key), value),
        removeItem: (key) => secure.deleteItemAsync(toSecureKey(key)),
    };
    return asyncStorageStore(storage, opts);
}
