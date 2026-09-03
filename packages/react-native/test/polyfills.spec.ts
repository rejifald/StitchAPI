// Unit tests for @stitchapi/react-native's streaming-polyfill guard
// (`polyfills.ts`), which no spec touched. Both members take an injectable
// `scope`, so we exercise the required-globals check with fake scopes — and the
// default-scope path against Node's globals — without monkeypatching globalThis.
//
// Driven through the exported namespace rather than the module functions, so these
// double as the behavioural half of the surface pins at the bottom: a barrel wired
// to some other predicate passes a typeof check and fails here.
import * as api from '../src';
import { rnStreamingPolyfills } from '../src';

import { describe, expect, test } from 'vitest';

/** A scope where every streaming global is present. */
const allPresent = (): Record<string, unknown> => ({
    TextEncoder: class {},
    TextDecoder: class {},
    ReadableStream: class {},
});

describe('rnStreamingPolyfills.has', () => {
    test('true when TextEncoder, TextDecoder, and ReadableStream are all present', () => {
        expect(rnStreamingPolyfills.has(allPresent())).toBe(true);
    });

    test('false when a required global is absent', () => {
        // ReadableStream missing entirely.
        expect(
            rnStreamingPolyfills.has({
                TextEncoder: class {},
                TextDecoder: class {},
            }),
        ).toBe(false);
    });

    test('treats a global explicitly set to undefined as missing', () => {
        expect(
            rnStreamingPolyfills.has({
                TextEncoder: undefined,
                TextDecoder: class {},
                ReadableStream: class {},
            }),
        ).toBe(false);
    });

    test('the default scope is globalThis, which Node provides', () => {
        expect(rnStreamingPolyfills.has()).toBe(true);
    });
});

describe('rnStreamingPolyfills.assert', () => {
    test('does not throw when every streaming global is present', () => {
        expect(() => rnStreamingPolyfills.assert(allPresent())).not.toThrow();
    });

    test('throws naming the missing globals and the install hint', () => {
        // Only TextEncoder present → TextDecoder + ReadableStream missing, in
        // REQUIRED order.
        const scope: Record<string, unknown> = { TextEncoder: class {} };
        expect(() => rnStreamingPolyfills.assert(scope)).toThrow(
            /TextDecoder, ReadableStream/,
        );
        expect(() => rnStreamingPolyfills.assert(scope)).toThrow(
            /react-native-polyfill-globals\/auto/,
        );
    });

    test('the default scope (globalThis) does not throw in Node', () => {
        expect(() => rnStreamingPolyfills.assert()).not.toThrow();
    });
});

// This package has no public-api-surface spec of its own (only core does), so the
// export shape is pinned here, matching the intent of core's SECRET_NAMESPACE_MEMBERS
// / REMOVED_SECRET_FUNCTIONS pair.
//
// Pinned as a WHOLE, not as two members: `assert` without `has` leaves a caller that
// wants to branch (fall back to a buffered request) with nothing but a try/catch, which
// is the reason the predicate is public in the first place.
const POLYFILL_NAMESPACE_MEMBERS = ['assert', 'has'] as const;

// The two verb-prefixed functions `rnStreamingPolyfills` REPLACED, pinned absent for the
// same reason as core's parsers and secret functions — one dimension, one name, the verb
// at the call site. They remain module functions in `polyfills.ts` (the adapter's own
// call site imports `assertStreamingPolyfills` directly, so the namespace stays a thin
// facade); what is pinned is that neither reaches the BARREL, where an alias would leave
// two spellings of one call.
const REMOVED_POLYFILL_FUNCTIONS = [
    'assertStreamingPolyfills',
    'hasStreamingPolyfills',
] as const;

describe('public API surface (src/index.ts)', () => {
    test.each(POLYFILL_NAMESPACE_MEMBERS)(
        'exports rnStreamingPolyfills.%s as a function',
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

    test.each(REMOVED_POLYFILL_FUNCTIONS)(
        'does NOT export %s — the namespace replaced it',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );
});
