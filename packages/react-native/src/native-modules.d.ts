// Ambient shims for the native peer modules this package touches, so it typechecks
// and builds WITHOUT installing react-native (a peer dependency, resolved in the
// consumer's app). Only the minimal surface we use is declared; the real module
// satisfies it. These shims are never emitted into the published `.d.ts` (the
// public API references this package's own structural interfaces, not these), and
// only `lib/` is published.
declare module 'react-native' {
    export interface NativeEventSubscription {
        remove(): void;
    }
    export type AppStateStatus =
        | 'active'
        | 'background'
        | 'inactive'
        | 'unknown'
        | 'extension';
    export interface AppStateStatic {
        readonly currentState: AppStateStatus;
        addEventListener(
            type: 'change',
            listener: (state: AppStateStatus) => void,
        ): NativeEventSubscription;
    }
    export const AppState: AppStateStatic;
}
