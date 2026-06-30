import { getMDXComponents } from '@/components/mdx';
import { Prerequisites } from '@/components/prerequisites';
import { jsonLdHtml } from '@/lib/json-ld';
import { appName, gitConfig } from '@/lib/shared';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import { docsStructuredData } from '@/lib/structured-data';

import {
    DocsBody,
    DocsDescription,
    DocsPage,
    DocsTitle,
    MarkdownCopyButton,
    ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
    const params = await props.params;
    const page = source.getPage(params.slug);
    if (!page) notFound();

    const MDX = page.data.body;
    const markdownUrl = getPageMarkdownUrl(page).url;

    return (
        <>
            {/* Per-page JSON-LD, rendered by this server component as a sibling of
                <DocsPage> (a client component) so the markup is in the SSR HTML. */}
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{
                    __html: jsonLdHtml(docsStructuredData(page)),
                }}
            />
            <DocsPage toc={page.data.toc} full={page.data.full}>
                <DocsTitle>{page.data.title}</DocsTitle>
                <DocsDescription className="mb-0">
                    {page.data.description}
                </DocsDescription>
                <div className="flex flex-row gap-2 items-center border-b pb-6">
                    <MarkdownCopyButton markdownUrl={markdownUrl} />
                    <ViewOptionsPopover
                        markdownUrl={markdownUrl}
                        githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/content/docs/${page.path}`}
                    />
                </div>
                <Prerequisites hrefs={page.data.prerequisites} />
                <DocsBody>
                    <MDX
                        components={getMDXComponents({
                            // this allows you to link to other pages with relative file paths
                            a: createRelativeLink(source, page),
                        })}
                    />
                </DocsBody>
            </DocsPage>
        </>
    );
}

export async function generateStaticParams() {
    return source.generateParams();
}

export async function generateMetadata(
    props: PageProps<'/docs/[[...slug]]'>,
): Promise<Metadata> {
    const params = await props.params;
    const page = source.getPage(params.slug);
    if (!page) notFound();

    const isIndex = !params.slug?.length;
    const image = getPageImage(page).url;

    return {
        // The /docs index title is just "StitchAPI"; the root `%s — StitchAPI`
        // template would render "StitchAPI — StitchAPI", so name it explicitly.
        title: isIndex
            ? { absolute: `${appName} Documentation` }
            : page.data.title,
        description: page.data.description,
        alternates: { canonical: page.url },
        openGraph: {
            type: 'article',
            url: page.url,
            siteName: appName,
            title: page.data.title,
            description: page.data.description,
            images: image,
        },
        twitter: {
            card: 'summary_large_image',
            title: page.data.title,
            description: page.data.description,
            images: image,
        },
    };
}
