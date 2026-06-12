import { siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

import type { MetadataRoute } from 'next';

export const revalidate = false;

const absolute = (path: string) => new URL(path, siteUrl).toString();

export default function sitemap(): MetadataRoute.Sitemap {
    return [
        {
            url: absolute('/'),
            changeFrequency: 'monthly',
            priority: 1,
        },
        ...source.getPages().map((page) => ({
            url: absolute(page.url),
            changeFrequency: 'weekly' as const,
            priority: 0.8,
        })),
    ];
}
