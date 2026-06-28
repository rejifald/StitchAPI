import { blogRoute } from './shared';

import { blog } from 'collections/server';
import { loader } from 'fumadocs-core/source';

// The blog is its own fumadocs source, rooted at `/blog`, kept separate from the
// docs source (and the docs IA drift guard) on purpose. Posts are flat under
// `content/blog`, so a page's single slug segment is the URL slug.
export const blogSource = loader({
    baseUrl: blogRoute,
    source: blog.toFumadocsSource(),
});

export type BlogPost = (typeof blogSource)['$inferPage'];

/**
 * Every post, newest first. `date` is an ISO date string validated in
 * `source.config.ts`, so a lexicographic compare already orders correctly; we
 * parse to `Date` defensively in case a post uses a fuller timestamp.
 */
export function getSortedPosts(): BlogPost[] {
    return [...blogSource.getPages()].sort(
        (a, b) =>
            new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
    );
}

/** The single-segment URL slug for a post (e.g. `cut-llm-costs-from-both-ends`). */
export function postSlug(post: BlogPost): string {
    return post.slugs[0] ?? '';
}

/** Format an ISO date string for display, e.g. "June 25, 2026". */
export function formatPostDate(date: string): string {
    return new Date(date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
    });
}
