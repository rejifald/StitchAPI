import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The enforcement half of the blog's "snippets are verified code" convention
// (AUTHORING.md → "Blog posts"). Every TypeScript code block in a post must be a
// `twoslash` block, so it type-checks against the real `stitchapi` types at build
// time — the same gate docs pages get. A bare ```ts fence ships unverified code
// and is exactly how a snippet silently rots out of sync with the API; this test
// fails the moment one appears. Blocks that genuinely cannot type-check (an
// intentional "before"/anti-pattern snippet, or one importing an SDK the docs
// don't install) still use `twoslash` — with an in-block `// @noErrors` or
// `// @errors: <code>` directive — so the fence stays uniform and the exception
// is explicit and greppable, never an un-annotated plain block.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BLOG = resolve(DOCS_ROOT, 'content', 'blog');

// Fence info-strings whose language is the TypeScript family and must therefore
// carry `twoslash`. JSX variants included — they type-check too.
const TS_LANGS = new Set(['ts', 'typescript', 'tsx']);

interface Fence {
    slug: string;
    line: number;
    info: string;
    lang: string;
}

/** Every fenced code block opener across all posts, with its 1-based line. */
function readFences(): Fence[] {
    const fences: Fence[] = [];
    for (const entry of readdirSync(BLOG, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;
        const slug = basename(entry.name, '.mdx');
        const lines = readFileSync(join(BLOG, entry.name), 'utf8').split('\n');
        let open = false;
        lines.forEach((raw, i) => {
            const m = /^```(.*)$/.exec(raw);
            if (!m) return;
            if (open) {
                open = false; // this ``` closes the current block
                return;
            }
            open = true; // this ``` opens a block
            const info = m[1].trim();
            fences.push({ slug, line: i + 1, info, lang: info.split(/\s+/)[0] });
        });
    }
    return fences;
}

const fences = readFences();

describe('blog twoslash enforcement', () => {
    it('found code fences to check', () => {
        expect(fences.length).toBeGreaterThan(0);
    });

    it('every TypeScript code block is a twoslash block', () => {
        const offenders = fences
            .filter((f) => TS_LANGS.has(f.lang))
            .filter((f) => !/\btwoslash\b/.test(f.info))
            .map((f) => `${f.slug}.mdx:${f.line}  (\`\`\`${f.info})`);

        expect(
            offenders,
            `These blog TypeScript blocks are not \`twoslash\` and so ship ` +
                `unverified. Change the fence to \`${''}ts twoslash\` (or ` +
                `\`tsx twoslash\`) and make it type-check. If the snippet is an ` +
                `intentional anti-pattern or imports an SDK the docs don't ` +
                `install, keep the twoslash fence and add \`// @noErrors\` (or ` +
                `\`// @errors: <code>\`) inside the block:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });
});
