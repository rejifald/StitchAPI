import { getSortedPosts, postSlug } from '@/lib/blog';
import { appName, siteUrl } from '@/lib/shared';

// Static export: the feed is generated at build time, not per request.
export const revalidate = false;

const escapeXml = (value: string): string =>
    value.replace(/[<>&'"]/g, (char) => {
        switch (char) {
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '&':
                return '&amp;';
            case "'":
                return '&apos;';
            case '"':
                return '&quot;';
            default:
                return char;
        }
    });

export function GET() {
    const blogUrl = `${siteUrl}/blog`;
    const posts = getSortedPosts();

    const items = posts
        .map((post) => {
            const link = `${blogUrl}/${postSlug(post)}`;
            const pubDate = new Date(post.data.date).toUTCString();
            return `        <item>
            <title>${escapeXml(post.data.title)}</title>
            <link>${escapeXml(link)}</link>
            <description>${escapeXml(post.data.description ?? '')}</description>
            <pubDate>${pubDate}</pubDate>
            <guid isPermaLink="true">${escapeXml(link)}</guid>
        </item>`;
        })
        .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
    <channel>
        <title>${escapeXml(`${appName} Blog`)}</title>
        <link>${escapeXml(blogUrl)}</link>
        <description>${escapeXml(`Notes from the ${appName} team on API stitching, agent-native integrations, and cutting AI cost.`)}</description>
        <language>en</language>
${items}
    </channel>
</rss>
`;

    return new Response(xml, {
        headers: { 'Content-Type': 'application/xml' },
    });
}
