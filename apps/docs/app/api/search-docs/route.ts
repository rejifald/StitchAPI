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
        // Degrade to "no results" rather than 500-ing the search box if the
        // index or model isn't available (e.g. index not built for this env).
        console.error('[search-docs] query failed:', error);
        return Response.json([]);
    }
}
