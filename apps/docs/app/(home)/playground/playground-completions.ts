import { PLAYGROUND_COMPLETIONS } from './playground-completions.generated';

import {
    type CompletionContext,
    type CompletionResult,
} from '@codemirror/autocomplete';

/**
 * Returns the open-brace depth of `text` — positive when we're inside more
 * `{` than `}`.
 */
function braceDepth(text: string): number {
    let depth = 0;
    for (const ch of text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }
    return depth;
}

/**
 * Completion source for all known playground primitives.
 *
 * For each entry in PLAYGROUND_COMPLETIONS (keyed by function name), checks
 * whether the cursor is inside a `fnName({…})` object literal and returns that
 * function's config-key completions. Adding a new primitive requires only a new
 * entry in the PlaygroundCompletionsPlugin config in next.config.mjs — no
 * changes here.
 */
export function playgroundCompletionSource(
    context: CompletionContext,
): CompletionResult | null {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const lookback = context.state.doc.sliceString(
        Math.max(0, context.pos - 2000),
        context.pos,
    );

    for (const [fnName, completions] of Object.entries(
        PLAYGROUND_COMPLETIONS,
    )) {
        const marker = `${fnName}(`;
        const idx = lookback.lastIndexOf(marker);
        if (idx === -1) continue;
        if (braceDepth(lookback.slice(idx + marker.length)) > 0) {
            return { from: word.from, options: completions, validFor: /^\w*$/ };
        }
    }

    return null;
}
