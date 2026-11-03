// The consumer rule `stitch init` writes into users' repos lives in one place —
// `RULES_BODY` (packages/core/src/rules-template.ts) — but two pages show it in
// full: the "Adopt in your project" guide and the "Keep agents on your API layer"
// post. Nothing generates those copies, so a wording change to the source (the
// `npx stitchapi` fix, #861, edited all three by hand) can leave a page showing a
// rule the CLI no longer writes. This pins each copy to the source.
//
// Prettier reformats the fenced block inside the MDX (it re-indents the nested
// code fence under its list item, re-indents the TypeScript to the repo's four
// spaces and collapses the padding before trailing comments), so the comparison is
// per line with indentation and runs of spaces normalised away. Words, order and
// line breaks must still match exactly.
import { RULES_BODY } from '../../../packages/core/src/rules-template';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COPIES = [
    'content/docs/agents/adopt-in-your-project.mdx',
    'content/blog/keep-agents-on-your-api-layer.mdx',
];

const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** Per line: trim, squash runs of whitespace, drop blank lines. */
const normalise = (text: string): string[] =>
    text
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

/** The fenced block (any fence of 3+ backticks) that opens with the rule's heading. */
function ruleBlock(mdx: string): string | null {
    const fence =
        /^(`{3,})[a-z]*\n(# Using StitchAPI in this project\n[\s\S]*?)\n\1$/m;
    return fence.exec(mdx)?.[2] ?? null;
}

describe('docs copies of RULES_BODY', () => {
    it.each(COPIES)('%s shows the rule exactly as the CLI writes it', (rel) => {
        const block = ruleBlock(read(rel));
        expect(
            block,
            `no fenced copy of the rule found in ${rel}`,
        ).not.toBeNull();
        expect(normalise(block as string)).toEqual(normalise(RULES_BODY));
    });

    it('catches a drifted word, not just a missing block', () => {
        const drifted = RULES_BODY.replace(
            'stitchapi diagram',
            'stitchapi graph',
        );
        expect(drifted).not.toBe(RULES_BODY);
        expect(normalise(drifted)).not.toEqual(normalise(RULES_BODY));
    });

    it('ignores indentation and padding, which prettier rewrites', () => {
        const reindented = RULES_BODY.split('\n')
            .map((line) => (line.startsWith('   ') ? ` ${line}` : line))
            .join('\n')
            .replace(/ {2,}\/\//g, ' //');
        expect(reindented).not.toBe(RULES_BODY);
        expect(normalise(reindented)).toEqual(normalise(RULES_BODY));
    });
});
