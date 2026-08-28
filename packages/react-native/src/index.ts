// @stitchapi/react-native — React Native bindings for StitchAPI.
//
// The hooks (`useStitch` / `useStitchStream` / `stitchQueryOptions`) are re-exported
// verbatim from `@stitchapi/react`: they are pure `useSyncExternalStore` over the
// shared `@stitchapi/query-core` store and run unchanged on React Native. What this
// package ADDS is the platform glue bare RN needs:
//
// - `rnStreamAdapter`         — a streaming transport (RN's `fetch` cannot stream).
// - `asyncStorageStore`       — a `StitchStore` over AsyncStorage, so sessions /
//                               cookies / tokens survive app restarts.
// - `useAppActiveRefetch` /   — refetch on app-foreground / on reconnect, the
//   `useReconnectRefetch`       data lifecycle a mobile app expects.
// - `rnStreamingPolyfills`    — assert/check the streaming globals Hermes lacks
//                               (TextEncoder/TextDecoder/ReadableStream) are present.
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
// The streaming-polyfill guard, one namespace over one question: are the three globals
// Hermes does not ship present? `rnStreamingPolyfills.assert()` throws naming what is
// missing and how to install it (what `rnStreamAdapter` calls before its first streamed
// response, so this is the hook for checking at app start instead); `rnStreamingPolyfills
// .has()` is the same check as a boolean, for a caller that would rather branch than
// catch.
//
// Same shape as core's `secrets` and token grammars, for the same reason: one name per
// dimension with the verb at the call site, rather than the two verb-prefixed functions
// (`assertStreamingPolyfills`/`hasStreamingPolyfills`) it replaced — two names on the
// barrel for one decision. The `rn` qualifier is ADR 0012 rule 6: this is an adapter
// package, the old names were bare, and `@stitchapi/expo` re-exports this barrel verbatim
// into a package that needs no polyfill at all.
export { rnStreamingPolyfills } from './polyfills';
