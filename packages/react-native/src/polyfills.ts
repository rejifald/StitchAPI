// Bare React Native (Hermes) ships no `TextEncoder` / `TextDecoder` /
// `ReadableStream`, and its global `fetch` cannot stream. `rnStreamAdapter` builds
// the stream itself, but the engine's decoders still construct a `TextDecoder` and
// call `getReader()`, so those three globals must exist. This guard turns a cryptic
// "ReadableStream is not defined" deep in a decoder into one actionable message.

const REQUIRED = ['TextEncoder', 'TextDecoder', 'ReadableStream'] as const;

const scopeOf = (): Record<string, unknown> => globalThis;

const missingGlobals = (scope: Record<string, unknown>): string[] =>
    REQUIRED.filter((name) => typeof scope[name] === 'undefined');

/**
 * Assert half of {@link rnStreamingPolyfills}; the namespace carries the contract.
 * Internal — the barrel exports the namespace, not this.
 *
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
 * Predicate half of {@link rnStreamingPolyfills}; the namespace carries the contract.
 * Internal — the barrel exports the namespace, not this.
 *
 * `true` when every streaming global is present — lets callers branch (e.g. fall
 * back to a buffered request) without catching {@link assertStreamingPolyfills}.
 */
export function hasStreamingPolyfills(
    scope: Record<string, unknown> = scopeOf(),
): boolean {
    return missingGlobals(scope).length === 0;
}

/**
 * The streaming-polyfill guard — one namespace over one question: are the three globals
 * Hermes does not ship (`TextEncoder`, `TextDecoder`, `ReadableStream`) present in this
 * scope? The shape is core's `secrets` and token grammars: one name per dimension, the
 * verb named at the call site, rather than two verb-prefixed functions for one decision.
 *
 * - `rnStreamingPolyfills.assert()` throws a message naming the missing globals and how
 *   to install them. {@link rnStreamAdapter} calls it before its first streamed response,
 *   so this is the manual hook — check at app start rather than at first stream.
 * - `rnStreamingPolyfills.has()` is the same check as a boolean, for a caller that wants
 *   to branch (fall back to a buffered request, hide a live view) instead of catching.
 *
 * Both take an optional `scope` — the object the globals are looked up on, defaulting to
 * `globalThis`. It exists so the check can be exercised against a fake scope without
 * monkeypatching the real one.
 *
 * **Streaming only.** A missing polyfill is not a broken install: non-streaming stitches
 * run on bare Hermes untouched, and `rnStreamAdapter` delegates them to core's buffered
 * `xhrAdapter` without ever reaching this guard. `has()` returning `false` means "this app
 * cannot stream", not "this app cannot call".
 *
 * **Not needed on Expo.** `@stitchapi/expo` re-exports this barrel verbatim, so the
 * namespace is reachable from there too — but `expo/fetch` streams natively and needs no
 * polyfill, so on Expo `has()` is answering about a gap that package does not have. The
 * `rn` qualifier is what says so at the call site (ADR 0012 rule 6), matching
 * {@link rnStreamAdapter} in this package.
 */
export const rnStreamingPolyfills = {
    assert: assertStreamingPolyfills,
    has: hasStreamingPolyfills,
} as const;
