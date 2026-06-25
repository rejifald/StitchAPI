import { formatPostDate, getSortedPosts, postSlug } from '@/lib/blog';
import { appName } from '@/lib/shared';

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
    title: 'Blog',
    description: `Notes from the ${appName} team on API stitching, agent-native integrations, and cutting AI cost.`,
};

export default function BlogIndexPage() {
    const posts = getSortedPosts();

    return (
        <main className="container mx-auto max-w-3xl px-4 py-16">
            <header className="mb-12">
                <h1 className="mb-3 text-4xl font-semibold tracking-tight">
                    Blog
                </h1>
                <p className="text-fd-muted-foreground text-lg">
                    Notes on API stitching, agent-native integrations, and
                    cutting AI cost.
                </p>
            </header>

            {posts.length === 0 ? (
                <p className="text-fd-muted-foreground">No posts yet.</p>
            ) : (
                <ul className="flex flex-col gap-10">
                    {posts.map((post) => (
                        <li
                            key={post.url}
                            className="border-fd-border border-b pb-10 last:border-b-0"
                        >
                            <article className="flex flex-col gap-2">
                                <h2 className="text-2xl font-semibold tracking-tight">
                                    <Link
                                        href={`/blog/${postSlug(post)}`}
                                        className="hover:text-fd-primary transition-colors"
                                    >
                                        {post.data.title}
                                    </Link>
                                </h2>
                                <p className="text-fd-muted-foreground text-sm">
                                    <span>{post.data.author}</span>
                                    <span aria-hidden> · </span>
                                    <time dateTime={post.data.date}>
                                        {formatPostDate(post.data.date)}
                                    </time>
                                </p>
                                {post.data.description ? (
                                    <p className="text-fd-muted-foreground">
                                        {post.data.description}
                                    </p>
                                ) : null}
                            </article>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
