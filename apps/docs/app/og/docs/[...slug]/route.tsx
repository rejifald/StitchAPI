import { ogImageResponse } from '@/lib/og-image';
import { getPageImage, source } from '@/lib/source';

import { notFound } from 'next/navigation';

export const revalidate = false;

export async function GET(
    _req: Request,
    { params }: RouteContext<'/og/docs/[...slug]'>,
) {
    const { slug } = await params;
    const page = source.getPage(slug.slice(0, -1));
    if (!page) notFound();

    return ogImageResponse({
        title: page.data.title,
        description: page.data.description,
        section: 'Docs',
    });
}

export function generateStaticParams() {
    return source.getPages().map((page) => ({
        lang: page.locale,
        slug: getPageImage(page).segments,
    }));
}
