import {
    PLAYGROUND_COMPLETIONS,
    PLAYGROUND_INSTANCE_COMPLETIONS,
} from './playground-completions.generated';

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
 * Config-key completions inside primitive({…}) call arguments.
 *
 * For each entry in PLAYGROUND_COMPLETIONS (keyed by function name), checks
 * whether the cursor is inside a `fnName({…})` object literal. Adding a new
 * primitive only requires a new entry in PlaygroundCompletionsPlugin config.
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

/**
 * Dot-completion source for instance members on primitive return values.
 *
 * Fires when the cursor is after `identifier.` and that identifier was assigned
 * from a known primitive call (e.g. `const getUser = stitch(...)`). Suggests
 * the methods and properties of the returned instance (stream, with, …).
 */
export function instanceCompletionSource(
    context: CompletionContext,
): CompletionResult | null {
    // Match `identifier.partialWord`
    const match = context.matchBefore(/\w+\.\w*/);
    if (!match) return null;

    const dotIdx = match.text.indexOf('.');
    const receiver = match.text.slice(0, dotIdx);

    const docText = context.state.doc.sliceString(
        0,
        Math.min(context.pos, context.state.doc.length),
    );

    for (const [fnName, completions] of Object.entries(
        PLAYGROUND_INSTANCE_COMPLETIONS,
    )) {
        // Heuristic: look for `const/let/var receiver = <anything>fnName(`
        const pattern = new RegExp(
            `(?:const|let|var)\\s+${receiver}\\s*=\\s*[\\s\\S]*?${fnName}\\s*[\\({]`,
        );
        if (pattern.test(docText)) {
            return {
                from: match.from + dotIdx + 1,
                options: completions,
                validFor: /^\w*$/,
            };
        }
    }

    return null;
}
