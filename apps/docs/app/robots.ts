import { siteUrl } from '@/lib/shared';

import type { MetadataRoute } from 'next';

export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
    return {
        rules: {
            userAgent: '*',
            allow: '/',
        },
        sitemap: new URL('/sitemap.xml', siteUrl).toString(),
        host: siteUrl,
    };
}
