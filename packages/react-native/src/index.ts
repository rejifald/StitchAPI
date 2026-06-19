// @stitchapi/react-native — React Native bindings for StitchAPI.
//
// The hooks (`useStitch` / `useStitchStream` / `queryOptions`) are re-exported
// verbatim from `@stitchapi/react`: they are pure `useSyncExternalStore` over the
// shared `@stitchapi/query-core` store and run unchanged on React Native. What this
// package ADDS is the platform glue bare RN needs:
//
// - `rnStreamAdapter`         — a streaming transport (RN's `fetch` cannot stream).
// - `asyncStorageStore`       — a `StitchStore` over AsyncStorage, so sessions /
//                               cookies / tokens survive app restarts.
// - `useAppActiveRefetch` /   — refetch on app-foreground / on reconnect, the
//   `useReconnectRefetch`       data lifecycle a mobile app expects.
// - `assertStreamingPolyfills`— a precise error when the streaming globals Hermes
//                               lacks (TextEncoder/TextDecoder/ReadableStream) are
//                               missing.
export * from '@stitchapi/react';

export {
    rnStreamAdapter,
    type RnStreamAdapterOptions,
    type RnStreamingXhr,
    type RnStreamingXhrCtor,
} from './adapter';
export {
    asyncStorageStore,
    type AsyncStorageLike,
    type AsyncStorageStoreOptions,
} from './store';
export {
    onAppActive,
    onReconnect,
    useAppActiveRefetch,
    useReconnectRefetch,
    type AppActiveRefetchOptions,
    type AppStateLike,
    type EventSubscriptionLike,
    type NetInfoLike,
    type NetInfoStateLike,
    type ReconnectRefetchOptions,
    type Refetchable,
} from './lifecycle';
export { assertStreamingPolyfills, hasStreamingPolyfills } from './polyfills';
