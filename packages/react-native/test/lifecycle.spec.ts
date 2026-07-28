// The lifecycle subscription logic lives in two pure functions (onAppActive /
// onReconnect) that take the platform module by argument; the hooks are thin
// useEffect wrappers over them. Test the logic directly with fake emitters.
import {
    onAppActive,
    onReconnect,
    useReconnectRefetch,
} from '../src/lifecycle';
import type { AppStateLike, NetInfoLike } from '../src/lifecycle';

import { describe, expect, test } from 'vitest';

function fakeAppState(initial = 'active'): {
    appState: AppStateLike;
    emit(state: string): void;
} {
    let listener: ((state: string) => void) | null = null;
    return {
        appState: {
            currentState: initial,
            addEventListener(_type, l) {
                listener = l;
                return {
                    remove() {
                        listener = null;
                    },
                };
            },
        },
        emit(state) {
            listener?.(state);
        },
    };
}

function fakeNetInfo(): {
    netInfo: NetInfoLike;
    emit(isConnected: boolean | null): void;
} {
    let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
    return {
        netInfo: {
            addEventListener(l) {
                listener = l;
                return () => {
                    listener = null;
                };
            },
        },
        emit(isConnected) {
            listener?.({ isConnected });
        },
    };
}

describe('onAppActive', () => {
    test('fires only on background→active transitions, and stops after unsubscribe', () => {
        const { appState, emit } = fakeAppState('active');
        let calls = 0;
        const off = onAppActive(appState, () => {
            calls += 1;
        });

        emit('background'); // active → background: no
        emit('active'); // background → active: yes
        emit('inactive');
        emit('active'); // inactive → active: yes
        off();
        emit('active'); // unsubscribed: no

        expect(calls).toBe(2);
    });
});

describe('useReconnectRefetch', () => {
    test('accepts the NetInfo module positionally or in the envelope (P15, type-level)', () => {
        const { netInfo } = fakeNetInfo();
        type Second = Parameters<typeof useReconnectRefetch>[1];
        const positional: Second = netInfo;
        const envelope: Second = { netInfo, enabled: false };
        expect(positional).toBeDefined();
        expect(envelope).toBeDefined();
    });
});

describe('onReconnect', () => {
    test('fires on disconnected→connected transitions, and stops after unsubscribe', () => {
        const { netInfo, emit } = fakeNetInfo();
        let calls = 0;
        const off = onReconnect(netInfo, () => {
            calls += 1;
        });

        emit(true); // first sample (was null): no
        emit(false); // connected → disconnected
        emit(true); // disconnected → connected: yes
        emit(true); // still connected: no
        emit(null); // → disconnected
        emit(true); // disconnected → connected: yes
        off();
        emit(true); // unsubscribed: no

        expect(calls).toBe(2);
    });
});
