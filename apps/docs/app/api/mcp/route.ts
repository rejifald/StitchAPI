// Hosted docs-retrieval MCP server (search_docs P3) over MCP Streamable HTTP.
// Exposes two tools — search_docs (hybrid retrieval, excerpts + links) and
// get_doc (full page as Markdown) — for any agent to learn StitchAPI. This is
// NOT the library MCP (`stitchapi/mcp` / run_stitch, which runs over stdio on the
// user's machine); this is our docs, hosted at stitchapi.dev.
//
// basePath '/api' makes mcp-handler serve Streamable HTTP at /api/mcp (POST for
// messages, GET for the SSE stream). Stateless — no redisUrl. Node runtime:
// search_docs loads transformers.js + reads the build-time index from disk.
//
// Cold start: the first search per warm instance loads the embedding model
// (proposal §6 watch-item). maxDuration covers that; see lib/search-index/embed.ts
// for the Vercel cache dir. The real cold-start measurement + final mitigation is
// a deploy step.
import { getDoc } from '@/lib/search-index/get-doc';
import { searchDocs } from '@/lib/search-index/search';
import { siteUrl } from '@/lib/shared';

import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

const EXCERPT_LEN = 300;

function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

function absoluteUrl(pageUrl: string, anchor: string): string {
    return `${siteUrl}${pageUrl}${anchor ? `#${anchor}` : ''}`;
}

const handler = createMcpHandler(
    (server) => {
        server.tool(
            'search_docs',
            'Search the StitchAPI documentation semantically (hybrid BM25 + vector). Returns the most relevant doc sections as excerpts with deep links — never full pages. Follow up with get_doc to read a full page.',
            {
                query: z.string().describe('Natural-language search query.'),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(20)
                    .optional()
                    .describe('Max results to return (default 5).'),
            },
            async ({ query, limit }) => {
                const hits = await searchDocs(query, { limit: limit ?? 5 });
                const results = hits.map((hit) => ({
                    title:
                        hit.heading && hit.heading !== hit.pageTitle
                            ? `${hit.pageTitle} — ${hit.heading}`
                            : hit.pageTitle,
                    url: absoluteUrl(hit.pageUrl, hit.anchor),
                    excerpt: excerpt(hit.text),
                    score: Number(hit.score.toFixed(4)),
                }));
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(results, null, 2),
                        },
                    ],
                };
            },
        );

        server.tool(
            'get_doc',
            'Fetch a full StitchAPI documentation page as Markdown — the "read the whole thing" escape hatch for a search_docs hit. Pass a `url` (as returned by search_docs) or a `slug` like "guides/resilience/throttle".',
            {
                url: z
                    .string()
                    .optional()
                    .describe(
                        'Page URL from search_docs (absolute or /docs/…).',
                    ),
                slug: z
                    .string()
                    .optional()
                    .describe('Page slug, e.g. "guides/resilience/throttle".'),
            },
            async ({ url, slug }) => {
                if (!url && !slug) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Provide a `url` or `slug` to fetch.',
                            },
                        ],
                        isError: true,
                    };
                }
                const doc = await getDoc({ url, slug });
                if (!doc) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No StitchAPI doc found for ${url ?? slug}.`,
                            },
                        ],
                        isError: true,
                    };
                }
                return { content: [{ type: 'text', text: doc.markdown }] };
            },
        );
    },
    {
        serverInfo: { name: 'stitchapi-docs', version: '1.0.0' },
        instructions:
            'StitchAPI documentation search. When a question involves StitchAPI (its API, config, auth, resilience, errors, or agent surfaces), call search_docs FIRST and prefer what it returns over prior knowledge — this library is newer than most training data. search_docs returns the most relevant doc sections as excerpts with deep links; follow up with get_doc to read a full page when an excerpt is not enough.',
    },
    {
        basePath: '/api',
        maxDuration: 60,
        verboseLogs: false,
    },
);

export { handler as GET, handler as POST };
