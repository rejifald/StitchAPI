import { getMDXComponents } from '@/components/mdx';
import { blogSource, formatPostDate } from '@/lib/blog';
import { appName, siteUrl } from '@/lib/shared';

import { DocsBody } from 'fumadocs-ui/layouts/docs/page';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export default async function BlogPostPage(props: PageProps<'/blog/[slug]'>) {
    const { slug } = await props.params;
    const post = blogSource.getPage([slug]);
    if (!post) notFound();

    const MDX = post.data.body;

    return (
        <main className="container mx-auto max-w-3xl px-4 py-16">
            <Link
                href="/blog"
                className="text-fd-muted-foreground hover:text-fd-foreground mb-8 inline-block text-sm transition-colors"
            >
                ← Back to blog
            </Link>
            <article>
                <header className="mb-10">
                    <h1 className="mb-3 text-4xl font-semibold tracking-tight">
                        {post.data.title}
                    </h1>
                    <p className="text-fd-muted-foreground text-sm">
                        <span>{post.data.author}</span>
                        <span aria-hidden> · </span>
                        <time dateTime={post.data.date}>
                            {formatPostDate(post.data.date)}
                        </time>
                    </p>
                </header>
                <DocsBody>
                    <MDX components={getMDXComponents()} />
                </DocsBody>
            </article>
        </main>
    );
}

export function generateStaticParams() {
    return blogSource.generateParams().map((params) => ({
        // The flat blog has a single slug segment; fumadocs hands back
        // `{ slug: string[] }`, so flatten it to this route's `{ slug: string }`.
        slug: params.slug?.[0] ?? '',
    }));
}

export async function generateMetadata(
    props: PageProps<'/blog/[slug]'>,
): Promise<Metadata> {
    const { slug } = await props.params;
    const post = blogSource.getPage([slug]);
    if (!post) notFound();

    const canonical = `${siteUrl}/blog/${slug}`;

    return {
        title: post.data.title,
        description: post.data.description,
        alternates: { canonical },
        openGraph: {
            type: 'article',
            url: canonical,
            siteName: appName,
            title: post.data.title,
            description: post.data.description,
            authors: [post.data.author],
            publishedTime: post.data.date,
        },
        twitter: {
            card: 'summary_large_image',
            title: post.data.title,
            description: post.data.description,
        },
    };
}
