import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The enforcement half of the blog's interlinking convention (AUTHORING.md →
// "Blog posts"). The house style is that every post links to sibling posts in
// prose; the automated `getRelatedPosts` footer is only a safety net. These
// tests fail the moment a post is authored as an island so the network can't
// silently rot — the same role `content-manifest.spec.ts` plays for the docs IA.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const BLOG = resolve(DOCS_ROOT, 'content', 'blog');

/** Map of slug → raw post body, for every `.mdx` post under `content/blog`. */
function readPosts(): Map<string, string> {
    const posts = new Map<string, string>();
    for (const entry of readdirSync(BLOG, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue;
        const slug = basename(entry.name, '.mdx');
        posts.set(slug, readFileSync(join(BLOG, entry.name), 'utf8'));
    }
    return posts;
}

/** Every `/blog/<slug>` reference in `body`, excluding self-links. */
function blogLinksIn(body: string, selfSlug: string): string[] {
    const slugs = new Set<string>();
    for (const match of body.matchAll(/\/blog\/([a-z0-9-]+)/g)) {
        const slug = match[1];
        if (slug && slug !== selfSlug) slugs.add(slug);
    }
    return [...slugs];
}

const posts = readPosts();
const slugs = new Set(posts.keys());

describe('blog interlinking', () => {
    it('has posts to check', () => {
        expect(posts.size).toBeGreaterThan(0);
    });

    it('every post links to at least one sibling post (no orphans)', () => {
        const orphans = [...posts]
            .filter(([slug, body]) => blogLinksIn(body, slug).length === 0)
            .map(([slug]) => slug);

        expect(
            orphans,
            `These posts link to no sibling post. Add an inline contextual ` +
                `link to a related /blog/<slug> post (see AUTHORING.md → ` +
                `"Blog posts"):\n  ${orphans.join('\n  ')}`,
        ).toEqual([]);
    });

    it('every cross-link points at a real post (no dangling links)', () => {
        const dangling: string[] = [];
        for (const [slug, body] of posts) {
            for (const target of blogLinksIn(body, slug)) {
                if (!slugs.has(target)) dangling.push(`${slug} → ${target}`);
            }
        }

        expect(
            dangling,
            `These cross-links point at a /blog/ slug that does not exist:\n  ${dangling.join('\n  ')}`,
        ).toEqual([]);
    });
});
