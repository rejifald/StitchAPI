import { blogSource } from './blog';
import { blogRoute, docsRoute } from './shared';
import { source } from './source';

export interface ResolvedPrerequisite {
    href: string;
    title: string;
    description?: string;
}

/**
 * Resolve a page's `prerequisites` frontmatter — internal hrefs to the
 * foundational pages it assumes the reader already knows — into the linked
 * pages' real titles and descriptions, pulled from the same fumadocs sources
 * that render those pages. Resolving from source (rather than letting the author
 * retype a title) means the link text can never drift from its target — the
 * anti-drift rule the product sells, applied to the docs' own navigation.
 *
 * Works across both surfaces:
 *   `/docs/concepts/the-stitch`   → docs source
 *   `/blog/what-is-schema-drift`  → blog source
 *
 * An unresolvable href is dropped here so the renderer never shows a broken
 * link; the build gate (`test/prerequisites.spec.ts`) is what fails CI when a
 * prerequisite dangles, the same way the no-orphans gate guards blog links.
 */
export function resolvePrerequisites(
    hrefs: string[] | undefined,
): ResolvedPrerequisite[] {
    if (!hrefs?.length) return [];

    const resolved: ResolvedPrerequisite[] = [];
    for (const href of hrefs) {
        const page = pageForHref(href);
        if (page) {
            resolved.push({
                href,
                title: page.data.title,
                description: page.data.description,
            });
        }
    }
    return resolved;
}

/** The page a `/docs/...` or `/blog/<slug>` href points at, or undefined. */
function pageForHref(href: string) {
    // Defensive: drop any query/hash and a trailing slash before matching.
    const path = (href.split(/[?#]/)[0] ?? href).replace(/\/+$/, '');

    const docsSlugs = segmentsUnder(path, docsRoute);
    if (docsSlugs) return source.getPage(docsSlugs);

    const blogSlugs = segmentsUnder(path, blogRoute);
    if (blogSlugs) return blogSource.getPage(blogSlugs);

    return undefined;
}

/**
 * If `path` is `base` or sits under `base/`, return the remaining URL segments
 * (`/docs/concepts/the-stitch` under `/docs` → `['concepts','the-stitch']`;
 * `/docs` → `[]`). Returns undefined when `path` is not under `base`.
 */
function segmentsUnder(path: string, base: string): string[] | undefined {
    if (path === base) return [];
    if (!path.startsWith(`${base}/`)) return undefined;
    return path
        .slice(base.length + 1)
        .split('/')
        .filter(Boolean);
}
