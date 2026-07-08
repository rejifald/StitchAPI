import { Section, SectionHeading } from './primitives';

import { formatPostDate, getSortedPosts, postSlug } from '@/lib/blog';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

// A "latest posts" band on the home page. Beyond being useful, this is
// deliberate internal linking: the home page is the most-crawled URL on the
// site, so a direct link from here to each post is the strongest crawl-priority
// signal we can give a young blog sitting in "Discovered — currently not
// indexed". Server-rendered, so every card is a static <a> in the HTML.
export function FromTheBlog() {
    const posts = getSortedPosts().slice(0, 4);
    if (posts.length === 0) return null;

    return (
        <Section id="from-the-blog" className="border-b border-fd-border">
            <SectionHeading
                eyebrow="From the blog"
                title="Notes on stitching APIs"
                lead="Field notes on API stitching, agent-native integrations, and cutting AI cost."
                align="center"
            />

            <ul className="mx-auto mt-12 grid max-w-4xl gap-5 sm:grid-cols-2">
                {posts.map((post) => (
                    <li key={post.url}>
                        <Link
                            href={`/blog/${postSlug(post)}`}
                            className="group block h-full rounded-2xl border border-fd-border bg-fd-card p-7 transition-colors hover:bg-fd-accent"
                        >
                            <time
                                dateTime={post.data.date}
                                className="text-xs font-medium uppercase tracking-[0.14em] text-fd-muted-foreground"
                            >
                                {formatPostDate(post.data.date)}
                            </time>
                            <h3 className="mt-3 text-xl font-semibold tracking-tight text-fd-foreground group-hover:text-stitch">
                                {post.data.title}
                            </h3>
                            {post.data.description ? (
                                <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                                    {post.data.description}
                                </p>
                            ) : null}
                        </Link>
                    </li>
                ))}
            </ul>

            <div className="mt-10 flex justify-center">
                <Link
                    href="/blog"
                    className="group inline-flex items-center gap-2 text-sm font-semibold text-stitch hover:text-stitch-strong"
                >
                    Read the blog
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
            </div>
        </Section>
    );
}
