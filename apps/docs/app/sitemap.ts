import { getSortedPosts, postSlug } from '@/lib/blog';
import { blogRoute, siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

import type { MetadataRoute } from 'next';

export const revalidate = false;

const absolute = (path: string) => new URL(path, siteUrl).toString();

export default function sitemap(): MetadataRoute.Sitemap {
    // Static export (`revalidate = false`), so this is the build timestamp —
    // a truthful "last generated" signal for crawlers.
    const lastModified = new Date();
    return [
        {
            url: absolute('/'),
            lastModified,
            changeFrequency: 'monthly',
            priority: 1,
        },
        ...source.getPages().map((page) => ({
            url: absolute(page.url),
            lastModified,
            changeFrequency: 'weekly' as const,
            priority: 0.8,
        })),
        {
            url: absolute(blogRoute),
            lastModified,
            changeFrequency: 'weekly' as const,
            priority: 0.7,
        },
        ...getSortedPosts().map((post) => ({
            url: absolute(`${blogRoute}/${postSlug(post)}`),
            lastModified,
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        })),
    ];
}
