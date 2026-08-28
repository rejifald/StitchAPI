// `@stitchapi/expo`'s barrel is `export * from '@stitchapi/react-native'` plus the two
// Expo-specific pieces, so react-native's public surface is republished under this
// package's name on npm — a rename there lands here with no diff in this package to
// show for it, and nothing in expo's own CI would notice a break in the chain.
//
// This pins the one such name that carries an Expo-specific caveat: the streaming
// polyfill guard. Expo needs no polyfill (`expo/fetch` streams natively), so the symbol
// is reachable here while answering about a gap this package does not have — which is
// exactly why it is `rn`-qualified rather than bare (ADR 0012 rule 6).
import * as api from '../src';

import { describe, expect, test } from 'vitest';

const POLYFILL_NAMESPACE_MEMBERS = ['assert', 'has'] as const;

// The two verb-prefixed functions the namespace replaced, pinned absent HERE as well as
// in react-native: `export *` re-publishes whatever the upstream barrel holds, so an
// alias drifting back there would silently reappear on this surface too.
const REMOVED_POLYFILL_FUNCTIONS = [
    'assertStreamingPolyfills',
    'hasStreamingPolyfills',
] as const;

describe('the re-exported react-native surface', () => {
    test.each(POLYFILL_NAMESPACE_MEMBERS)(
        'rnStreamingPolyfills.%s transits the barrel',
        (member) => {
            expect(
                typeof (
                    api.rnStreamingPolyfills as unknown as Record<
                        string,
                        unknown
                    >
                )[member],
            ).toBe('function');
        },
    );

    // Behavioural, not just structural: `export *` could in principle be shadowed by a
    // local of the same name. A namespace that is not the real guard passes the typeof
    // checks above and fails this. The guard is a presence check (`typeof === 'undefined'`)
    // rather than a shape check, so any defined value stands in for a real global here.
    test('the transited namespace is the real guard', () => {
        expect(
            api.rnStreamingPolyfills.has({
                TextEncoder: {},
                TextDecoder: {},
            }),
        ).toBe(false);
    });

    test.each(REMOVED_POLYFILL_FUNCTIONS)(
        'does NOT re-export %s — the namespace replaced it',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );
});
