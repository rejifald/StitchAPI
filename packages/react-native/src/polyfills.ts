// Bare React Native (Hermes) ships no `TextEncoder` / `TextDecoder` /
// `ReadableStream`, and its global `fetch` cannot stream. `rnStreamAdapter` builds
// the stream itself, but the engine's decoders still construct a `TextDecoder` and
// call `getReader()`, so those three globals must exist. This guard turns a cryptic
// "ReadableStream is not defined" deep in a decoder into one actionable message.

const REQUIRED = ['TextEncoder', 'TextDecoder', 'ReadableStream'] as const;

const scopeOf = (): Record<string, unknown> =>
    globalThis as unknown as Record<string, unknown>;

const missingGlobals = (scope: Record<string, unknown>): string[] =>
    REQUIRED.filter((name) => typeof scope[name] === 'undefined');

/**
 * Throw a precise, actionable error if a global required for streaming is missing.
 * Called by {@link rnStreamAdapter} before its first streamed response, so a
 * misconfigured app fails fast with install instructions instead of crashing
 * deep in the stream decoder. Non-streaming stitches never call this.
 */
export function assertStreamingPolyfills(
    scope: Record<string, unknown> = scopeOf(),
): void {
    const missing = missingGlobals(scope);
    if (missing.length === 0) return;
    throw new Error(
        `@stitchapi/react-native: streaming needs ${missing.join(', ')}, which ` +
            `Hermes does not ship. Install the polyfills once at your app's entry, e.g.\n` +
            `  import 'react-native-polyfill-globals/auto';\n` +
            `or wire 'text-encoding' + 'web-streams-polyfill' yourself. ` +
            `(Non-streaming stitches work without them.)`,
    );
}

/**
 * `true` when every streaming global is present — lets callers branch (e.g. fall
 * back to a buffered request) without catching {@link assertStreamingPolyfills}.
 */
export function hasStreamingPolyfills(
    scope: Record<string, unknown> = scopeOf(),
): boolean {
    return missingGlobals(scope).length === 0;
}
