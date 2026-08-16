// Semantic docs search (search_docs P2). Hybrid BM25 + vector retrieval over the
// build-time index, returned as fumadocs' SortedResult[] so the site's search
// dialog renders it (see RootProvider `search.options.api` in app/layout.tsx).
//
// The MCP wrapper (P3) reuses the same searchDocs() engine with its own tool
// shape. Deploy-time index build + runtime model loading / cold-start are
// hardened in P3.
import { MAX_QUERY_LEN } from '@/lib/search-index/config';
import { searchDocs } from '@/lib/search-index/search';
import { toSortedResults } from '@/lib/search-index/sorted-result';

// transformers.js + onnxruntime-node + fs — Node runtime, never prerendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A cold instance pays the embedding model's *load* before it can answer any
// query. The weights ship with the function now, so that load reads from disk
// rather than re-fetching ~87 MB from the HF CDN per cold start, and the
// measured cost is seconds, not the tens the CDN fetch cost. The ceiling is
// headroom either way, not a fix for a specific timeout: `/api/mcp` already
// takes 60 for the identical load, and the two paths should not disagree about
// how long that load is allowed to take. The fumadocs dialog renders nothing at
// all on a failed request, so whatever does exceed the ceiling reads to a
// visitor as "search is broken".
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
    // Truncate before doing any work: the embedder tokenizes the whole raw
    // string, so an unbounded `query` param is a CPU/memory DoS. searchDocs caps
    // again at the shared seam (defense in depth); bounding here also keeps the
    // huge string from being held for the request's lifetime. See MAX_QUERY_LEN.
    const query =
        new URL(request.url).searchParams
            .get('query')
            ?.trim()
            .slice(0, MAX_QUERY_LEN) ?? '';
    if (!query) return Response.json([]);

    try {
        const hits = await searchDocs(query, { limit: 8 });
        return Response.json(toSortedResults(hits));
    } catch (error) {
        // A missing index or a failed model load is infrastructure being down,
        // not a query with no matches — say so with a status. Answering 200 []
        // instead made the two indistinguishable in every direction that
        // matters: uptime checks read a broken search as healthy, and fumadocs'
        // fetch client memoizes per-URL for the page's lifetime, so the cached
        // empty array kept the query blank even after the instance warmed up.
        // A non-ok response is not cached, so the user's next keystroke retries.
        console.error('[search-docs] query failed:', error);
        return Response.json({ error: 'search unavailable' }, { status: 503 });
    }
}
