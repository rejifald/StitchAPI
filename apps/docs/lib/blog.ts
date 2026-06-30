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

/**
 * The automated half of the blog's interlinking (see AUTHORING.md → "Blog
 * posts"). Inline contextual links are the author's job; this is the safety net
 * that keeps every post connected even when the prose forgets — ranked by shared
 * `tags`, newest breaking ties, so a post is never an island.
 *
 * Returns up to `limit` other posts sharing at least one tag with `post`. Posts
 * with more tags in common rank higher; among equal overlap the newer post wins.
 */
export function getRelatedPosts(post: BlogPost, limit = 3): BlogPost[] {
    const tags = new Set(post.data.tags ?? []);
    if (tags.size === 0) return [];

    return (
        getSortedPosts()
            .filter((candidate) => postSlug(candidate) !== postSlug(post))
            .map((candidate) => ({
                candidate,
                overlap: (candidate.data.tags ?? []).filter((tag) =>
                    tags.has(tag),
                ).length,
            }))
            .filter(({ overlap }) => overlap > 0)
            // `getSortedPosts` is already newest-first, so a stable sort on overlap
            // alone keeps date as the tie-breaker.
            .sort((a, b) => b.overlap - a.overlap)
            .slice(0, limit)
            .map(({ candidate }) => candidate)
    );
}
