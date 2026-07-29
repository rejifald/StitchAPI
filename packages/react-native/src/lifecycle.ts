// Lifecycle helpers — refetch a stitch query when the app returns to the
// foreground, or when connectivity comes back. These are the data behaviours a
// mobile app expects but a web query library doesn't provide.
//
// The subscription LOGIC lives in two pure functions (`onAppActive`, `onReconnect`)
// that take the platform module by argument, so they are testable off-device and
// usable without React. The hooks are thin `useEffect` wrappers over them, with
// RN's `AppState` wired as the default.
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** A removable native subscription (RN's `addEventListener` return). */
export interface EventSubscriptionLike {
    remove(): void;
}

/** Structural surface of RN's `AppState` the helpers use (injectable for tests). */
export interface AppStateLike {
    readonly currentState: string;
    addEventListener(
        type: 'change',
        listener: (state: string) => void,
    ): EventSubscriptionLike;
}

/** A connectivity snapshot — the slice of `@react-native-community/netinfo`'s state we read. */
export interface NetInfoStateLike {
    isConnected: boolean | null;
}

/** Structural surface of a `@react-native-community/netinfo` module. */
export interface NetInfoLike {
    addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

/** Anything with a `refetch` — a `useStitch` / `useStitchStream` result satisfies it. */
export interface Refetchable {
    refetch: () => void;
}

/**
 * Subscribe to app foreground transitions: call `onActive` whenever the app
 * returns to the `'active'` state from background/inactive. Returns an unsubscribe.
 * Pure — inject any {@link AppStateLike} (the hook wires RN's `AppState` for you).
 */
export function onAppActive(
    appState: AppStateLike,
    onActive: () => void,
): () => void {
    let previous = appState.currentState;
    const sub = appState.addEventListener('change', (next) => {
        if (next === 'active' && previous !== 'active') onActive();
        previous = next;
    });
    return () => sub.remove();
}

/**
 * Subscribe to connectivity: call `onOnline` on a (disconnected → connected)
 * transition. Returns an unsubscribe. Pure — inject any {@link NetInfoLike}.
 */
export function onReconnect(
    netInfo: NetInfoLike,
    onOnline: () => void,
): () => void {
    let wasConnected: boolean | null = null;
    return netInfo.addEventListener((state) => {
        const connected = state.isConnected === true;
        if (connected && wasConnected === false) onOnline();
        wasConnected = connected;
    });
}

// RN's AppState, widened to our structural surface (the ambient shim types it; we
// never depend on @types/react-native).
const RN_APP_STATE = AppState as unknown as AppStateLike;

/** Options for {@link useAppActiveRefetch}. */
export interface AppActiveRefetchOptions {
    /** Turn the subscription on/off without unmounting (default `true`). */
    enabled?: boolean;
    /** Override the AppState module (default RN's `AppState`). */
    appState?: AppStateLike;
}

/**
 * Refetch a stitch query whenever the app returns to the foreground.
 *
 * ```tsx
 * const q = useStitch(getInbox, {});
 * useAppActiveRefetch(q);
 * ```
 */
export function useAppActiveRefetch(
    handle: Refetchable,
    options: AppActiveRefetchOptions = {},
): void {
    const { enabled = true, appState = RN_APP_STATE } = options;
    const ref = useRef(handle);
    ref.current = handle;
    useEffect(() => {
        if (!enabled) return;
        return onAppActive(appState, () => ref.current.refetch());
    }, [enabled, appState]);
}

/** Options for {@link useReconnectRefetch}. */
export interface ReconnectRefetchOptions {
    /** Turn the subscription on/off without unmounting (default `true`). */
    enabled?: boolean;
    /**
     * The NetInfo module — required (P15), because `@react-native-community/netinfo`
     * is an optional peer this package does not bundle. Pass the imported module;
     * or skip the envelope and pass the module positionally.
     */
    netInfo: NetInfoLike;
}

/**
 * Refetch a stitch query whenever connectivity returns. The NetInfo module is the
 * one required value, so it can be passed positionally (P15 shorthand); use the
 * options envelope when you also need `enabled`.
 *
 * ```tsx
 * import NetInfo from '@react-native-community/netinfo';
 * useReconnectRefetch(q, NetInfo);
 * // or, with the envelope:
 * useReconnectRefetch(q, { netInfo: NetInfo, enabled: isLoggedIn });
 * ```
 */
export function useReconnectRefetch(
    handle: Refetchable,
    options: NetInfoLike | ReconnectRefetchOptions,
): void {
    // A NetInfoLike is distinguishable by its `addEventListener`; the envelope
    // carries the module under `netInfo` instead.
    const opts: ReconnectRefetchOptions =
        'addEventListener' in options ? { netInfo: options } : options;
    const { enabled = true, netInfo } = opts;
    const ref = useRef(handle);
    ref.current = handle;
    useEffect(() => {
        if (!enabled) return;
        return onReconnect(netInfo, () => ref.current.refetch());
    }, [enabled, netInfo]);
}
