import { getSortedPosts, postSlug } from '@/lib/blog';
import { blogRoute, siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

import type { MetadataRoute } from 'next';

export const revalidate = false;

const absolute = (path: string) => new URL(path, siteUrl).toString();

export default function sitemap(): MetadataRoute.Sitemap {
    const posts = getSortedPosts();

    // Docs pages carry no per-page date, so the build timestamp is the most
    // truthful `lastmod` we have for them (and for the home page). Blog URLs get
    // their real content dates below — see the note there.
    const buildTime = new Date();

    // The newest post's date is when the blog index last meaningfully changed.
    const blogIndexModified = posts[0]
        ? new Date(posts[0].data.date)
        : buildTime;

    return [
        {
            url: absolute('/'),
            lastModified: buildTime,
            changeFrequency: 'monthly',
            priority: 1,
        },
        ...source.getPages().map((page) => ({
            url: absolute(page.url),
            lastModified: buildTime,
            changeFrequency: 'weekly' as const,
            priority: 0.8,
        })),
        {
            url: absolute(blogRoute),
            lastModified: blogIndexModified,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
        },
        // A post's own publication date is a stable, per-URL `lastmod` that only
        // moves when the content does. This is deliberate: stamping every URL
        // with the build time (as this route used to) tells Google all ~100
        // pages changed on every deploy, which it treats as noise and ignores —
        // discarding the very signal it uses to schedule crawls. Truthful,
        // stable dates are what a young domain stuck in "Discovered — currently
        // not indexed" needs.
        ...posts.map((post) => ({
            url: absolute(`${blogRoute}/${postSlug(post)}`),
            lastModified: new Date(post.data.date),
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        })),
    ];
}
