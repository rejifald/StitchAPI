import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The enforcement half of the `prerequisites` frontmatter field (AUTHORING.md →
// "Prerequisites — the upstream pointer"). A page may point upstream at the
// foundational pages it assumes via `prerequisites:` hrefs; the <Prerequisites>
// box resolves each from source and silently drops anything unresolvable, so the
// reader never sees a broken link. This gate is what fails the build when a
// prerequisite dangles — the same role blog-interlinking.spec.ts plays for
// sibling links and content-manifest.spec.ts for the docs IA. Raw-FS, like those
// specs, so it needs no generated `.source`.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DOCS = resolve(DOCS_ROOT, 'content', 'docs');
const BLOG = resolve(DOCS_ROOT, 'content', 'blog');

/** Absolute paths of every `.mdx` under `dir`, recursively. */
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.mdx')) out.push(full);
    }
    return out;
}

/**
 * The site URL an `.mdx` file is served at:
 *   content/blog/x.mdx                    → /blog/x
 *   content/docs/concepts/the-stitch.mdx  → /docs/concepts/the-stitch
 *   content/docs/getting-started/index.mdx → /docs/getting-started (index → root)
 *   content/docs/index.mdx                → /docs
 */
function urlFor(absMdx: string): string {
    if (absMdx.startsWith(BLOG)) {
        return `/blog/${relative(BLOG, absMdx).replace(/\.mdx$/, '')}`;
    }
    const path = relative(DOCS, absMdx)
        .split(sep)
        .join('/')
        .replace(/\.mdx$/, '')
        .replace(/(^|\/)index$/, '');
    return path ? `/docs/${path}` : '/docs';
}

/** The frontmatter block (between the first two `---`) of an `.mdx` file, or ''. */
function frontmatterOf(body: string): string {
    return body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
}

/**
 * The internal hrefs declared under `prerequisites:` in a frontmatter block.
 * Captures the `prerequisites:` value — the rest of its line plus any following
 * more-indented lines — so it tolerates both inline (`[...]`) and block (`- ...`)
 * YAML, then pulls `/docs/...` and `/blog/...` hrefs from it. Trailing slashes
 * are normalized away to match how the resolver and `urlFor` spell a URL.
 */
function prerequisiteHrefsIn(frontmatter: string): string[] {
    const block = frontmatter.match(/^prerequisites:.*(?:\n[ \t]+.*)*/m)?.[0];
    if (!block) return [];
    return [...block.matchAll(/\/(?:docs|blog)\/[a-z0-9/-]+/g)].map((m) =>
        m[0].replace(/\/+$/, ''),
    );
}

const files = [...walk(DOCS), ...walk(BLOG)];
const validUrls = new Set(files.map(urlFor));
const declared = files.map((file) => ({
    url: urlFor(file),
    hrefs: prerequisiteHrefsIn(frontmatterOf(readFileSync(file, 'utf8'))),
}));

describe('prerequisites resolve', () => {
    it('has content to check', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it('every prerequisite href points at a real page (no dangling)', () => {
        const dangling: string[] = [];
        for (const { url, hrefs } of declared) {
            for (const href of hrefs) {
                if (!validUrls.has(href)) dangling.push(`${url} → ${href}`);
            }
        }
        expect(
            dangling,
            `These \`prerequisites\` hrefs point at a page that does not ` +
                `exist (see AUTHORING.md → "Prerequisites"):\n  ${dangling.join('\n  ')}`,
        ).toEqual([]);
    });

    it('no page lists itself as a prerequisite', () => {
        const selfRefs = declared
            .filter(({ url, hrefs }) => hrefs.includes(url))
            .map(({ url }) => url);
        expect(
            selfRefs,
            `A page lists its own URL under \`prerequisites\`:\n  ${selfRefs.join('\n  ')}`,
        ).toEqual([]);
    });
});
