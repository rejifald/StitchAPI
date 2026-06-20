// @stitchapi/expo — Expo bindings for StitchAPI.
//
// Expo ships `expo/fetch`, a WinterCG-compliant fetch with REAL streaming
// (`Response#body` is a `ReadableStream`), so the streaming gap bare React Native
// has is already solved: `expoFetchAdapter` is a thin wrap of core's `fetchAdapter`
// over it — no XHR shim, no TextDecoder/ReadableStream polyfills.
//
// Everything else is shared with — and re-exported verbatim from —
// `@stitchapi/react-native`: the `useStitch` / `useStitchStream` hooks, the
// `asyncStorageStore`, and the `useAppActiveRefetch` / `useReconnectRefetch`
// lifecycle helpers. This package adds the two Expo-specific pieces:
//
// - `expoFetchAdapter` — streaming transport over `expo/fetch`.
// - `expoSecureStore`  — a `StitchStore` over `expo-secure-store` (encrypted
//                        tokens), reusing the AsyncStorage store's logic.
export * from '@stitchapi/react-native';

export { expoFetchAdapter, type ExpoFetchAdapterOptions } from './adapter';
export {
    expoSecureStore,
    type ExpoSecureStoreOptions,
    type SecureStoreLike,
} from './store';
