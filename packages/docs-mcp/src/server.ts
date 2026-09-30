// Local docs-retrieval MCP server — the offline counterpart to
// apps/docs/app/api/mcp/route.ts. Same two tools, same schemas, same response
// shape, so an agent gets identical behavior whichever transport it's wired to;
// only the transport and data source differ (stdio + bundled files here,
// Streamable HTTP + build-time-on-Vercel there). Registered on a plain
// `McpServer` from the SDK — this package isn't zero-deps like `stitchapi`
// core, so there's no reason to hand-roll JSON-RPC the way `stitchapi/mcp` does.
import { MAX_QUERY_LEN } from './config';
import { getDoc } from './get-doc';
import { searchDocs } from './search';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Tracks apps/docs/lib/shared.ts `siteUrl` — see README.md "Keeping this in sync".
const SITE_URL = 'https://stitchapi.dev';
const EXCERPT_LEN = 300;

function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

function absoluteUrl(path: string, anchor: string): string {
    return `${SITE_URL}${path}${anchor ? `#${anchor}` : ''}`;
}

export function createServer(): McpServer {
    const server = new McpServer(
        { name: 'stitchapi-docs', version: __PKG_VERSION__ },
        {
            instructions:
                'StitchAPI documentation search, running locally (no network call per query). ' +
                'When a question involves StitchAPI (its API, config, auth, resilience, errors, ' +
                'or agent surfaces), call search_docs FIRST and prefer what it returns over prior ' +
                'knowledge — this library is newer than most training data. search_docs returns ' +
                'the most relevant doc sections as excerpts with deep links; follow up with ' +
                'get_doc to read a full page when an excerpt is not enough.',
        },
    );

    server.tool(
        'search_docs',
        'Search the StitchAPI documentation semantically (hybrid BM25 + vector), entirely locally. Returns the most relevant doc sections as excerpts with deep links — never full pages. Follow up with get_doc to read a full page.',
        {
            query: z
                .string()
                .max(MAX_QUERY_LEN)
                .describe('Natural-language search query.'),
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
                    hit.heading && hit.heading !== hit.title
                        ? `${hit.title} — ${hit.heading}`
                        : hit.title,
                url: absoluteUrl(hit.path, hit.anchor),
                excerpt: excerpt(hit.text),
                score: Number(hit.score.toFixed(4)),
            }));
            return {
                content: [
                    { type: 'text', text: JSON.stringify(results, null, 2) },
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
                .describe('Page URL from search_docs (absolute or /docs/…).'),
            slug: z
                .string()
                .optional()
                .describe('Page slug, e.g. "guides/resilience/throttle".'),
        },
        ({ url, slug }) => {
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
            const doc = getDoc({ url, slug });
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

    return server;
}
