import { blogSource } from '@/lib/blog';
import { appName } from '@/lib/shared';

import { generate as DefaultImage } from 'fumadocs-ui/og';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';

export const revalidate = false;

// Per-post Open Graph image, mirroring the docs OG route (`/og/docs/...`). The
// blog post metadata sets `openGraph.type: 'article'` + a `summary_large_image`
// Twitter card but shipped no image, so social cards rendered blank; this gives
// every post a real 1200×630 card showing its own title. The BlogPosting JSON-LD
// points its `image` here too, so the URL must resolve.
export async function GET(
    _req: Request,
    { params }: RouteContext<'/og/blog/[slug]'>,
) {
    const { slug } = await params;
    const post = blogSource.getPage([slug]);
    if (!post) notFound();

    return new ImageResponse(
        (
            <DefaultImage
                title={post.data.title}
                description={post.data.description}
                site={appName}
            />
        ),
        {
            width: 1200,
            height: 630,
        },
    );
}

export function generateStaticParams() {
    return blogSource.generateParams().map((params) => ({
        // Flatten fumadocs' `{ slug: string[] }` to this route's `{ slug: string }`,
        // exactly as the blog post page does.
        slug: params.slug?.[0] ?? '',
    }));
}
