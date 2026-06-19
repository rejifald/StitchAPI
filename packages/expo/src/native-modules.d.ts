// Ambient shims for the Expo/native peer modules this package (and the
// @stitchapi/react-native source it builds on) touch, so it typechecks and builds
// WITHOUT installing expo / react-native (peer deps resolved in the consumer's
// app). Only the minimal surface used is declared; the real modules satisfy it.
// Never emitted into the published `.d.ts` — only `lib/` is published.
declare module 'expo/fetch' {
    // expo/fetch is WinterCG-compliant: same shape as the global fetch, but its
    // Response#body is a real ReadableStream (which bare RN's fetch is not).
    export const fetch: typeof globalThis.fetch;
}

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
