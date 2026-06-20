// Unit tests for @stitchapi/react-native's streaming-polyfill guard
// (`polyfills.ts`), which no spec touched. Both functions take an injectable
// `scope`, so we exercise the required-globals check with fake scopes — and the
// default-scope path against Node's globals — without monkeypatching globalThis.
import { assertStreamingPolyfills, hasStreamingPolyfills } from '../src';

import { describe, expect, test } from 'vitest';

/** A scope where every streaming global is present. */
const allPresent = (): Record<string, unknown> => ({
    TextEncoder: class {},
    TextDecoder: class {},
    ReadableStream: class {},
});

describe('hasStreamingPolyfills', () => {
    test('true when TextEncoder, TextDecoder, and ReadableStream are all present', () => {
        expect(hasStreamingPolyfills(allPresent())).toBe(true);
    });

    test('false when a required global is absent', () => {
        // ReadableStream missing entirely.
        expect(
            hasStreamingPolyfills({
                TextEncoder: class {},
                TextDecoder: class {},
            }),
        ).toBe(false);
    });

    test('treats a global explicitly set to undefined as missing', () => {
        expect(
            hasStreamingPolyfills({
                TextEncoder: undefined,
                TextDecoder: class {},
                ReadableStream: class {},
            }),
        ).toBe(false);
    });

    test('the default scope is globalThis, which Node provides', () => {
        expect(hasStreamingPolyfills()).toBe(true);
    });
});

describe('assertStreamingPolyfills', () => {
    test('does not throw when every streaming global is present', () => {
        expect(() => assertStreamingPolyfills(allPresent())).not.toThrow();
    });

    test('throws naming the missing globals and the install hint', () => {
        // Only TextEncoder present → TextDecoder + ReadableStream missing, in
        // REQUIRED order.
        const scope: Record<string, unknown> = { TextEncoder: class {} };
        expect(() => assertStreamingPolyfills(scope)).toThrow(
            /TextDecoder, ReadableStream/,
        );
        expect(() => assertStreamingPolyfills(scope)).toThrow(
            /react-native-polyfill-globals\/auto/,
        );
    });

    test('the default scope (globalThis) does not throw in Node', () => {
        expect(() => assertStreamingPolyfills()).not.toThrow();
    });
});
