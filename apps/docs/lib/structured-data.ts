import { appName, docsRoute, siteUrl } from './shared';
import { getPageImage, source } from './source';

// Per-page structured data for doc pages. The root layout models the *site*
// (WebSite + SoftwareApplication); this models each *page* as a TechArticle and
// gives crawlers an explicit breadcrumb trail. Both are parsed more reliably by
// search engines and AI summarizers than the rendered prose — which matters for
// an agent-native tool whose audience includes LLM retrieval pipelines.

type DocsPage = (typeof source)['$inferPage'];

const absolute = (path: string) => new URL(path, siteUrl).toString();

const publisher = {
    '@type': 'Organization',
    name: appName,
    url: siteUrl,
    logo: { '@type': 'ImageObject', url: absolute('/icon.png') },
};

const author = { '@type': 'Person', name: 'Oleksandr Zhuravlov' };

// "getting-started" -> "Getting started" — fallback only; real titles win.
const humanize = (segment: string) =>
    segment.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function techArticle(page: DocsPage) {
    return {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: page.data.title,
        description: page.data.description,
        url: absolute(page.url),
        image: absolute(getPageImage(page).url),
        inLanguage: 'en-US',
        isPartOf: { '@type': 'WebSite', name: appName, url: siteUrl },
        author,
        publisher,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
    };
    // No datePublished/dateModified: the repo keeps no per-page dates, and the
    // sitemap's build timestamp is not a truthful per-page signal — omit rather
    // than fabricate. Dates are optional for TechArticle.
}

function breadcrumb(page: DocsPage) {
    const trail = [
        { name: appName, url: siteUrl },
        { name: 'Documentation', url: absolute(docsRoute) },
    ];

    // Resolve each ancestor slug to its real page title where one exists.
    page.slugs.forEach((_segment: string, i: number) => {
        const prefix = page.slugs.slice(0, i + 1);
        const node = source.getPage(prefix);
        trail.push({
            name: node?.data.title ?? humanize(prefix[i]),
            url: absolute(`${docsRoute}/${prefix.join('/')}`),
        });
    });

    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: trail.map((crumb, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: crumb.name,
            item: crumb.url,
        })),
    };
}

export function docsStructuredData(page: DocsPage) {
    return [techArticle(page), breadcrumb(page)];
}
