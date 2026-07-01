// TEMPORARY diagnostic for the search_docs infra outage. Gated behind ?key= so
// it is not an open debug endpoint (404 without the key). Reports ONLY which
// server-only imports resolve and whether a search runs — it never reads
// process.env, secrets, request headers/cookies/body, or user data. The error
// strings it returns are module-resolution errors (may include internal file
// paths, no secrets). Delete once /api/mcp + /api/search-docs are healthy.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Throwaway obscurity gate. Server-only (route handler source is never sent to
// the browser); rotated/removed with this route.
const DIAG_KEY = 'd1ag-9k2m7q4x8z';

interface Probe {
    mod: string;
    ok: boolean;
    code?: string;
    message?: string;
}

async function probe(
    mod: string,
    load: () => Promise<unknown>,
): Promise<Probe> {
    try {
        await load();
        return { mod, ok: true };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return {
            mod,
            ok: false,
            code: err.code,
            message: String(err.message).slice(0, 400),
        };
    }
}

export async function GET(request: Request): Promise<Response> {
    if (new URL(request.url).searchParams.get('key') !== DIAG_KEY) {
        return new Response('Not found', { status: 404 });
    }

    const probes: Probe[] = [
        await probe(
            '@huggingface/transformers',
            () => import('@huggingface/transformers'),
        ),
        await probe(
            'onnxruntime-node',
            () =>
                // @ts-expect-error -- transitive native dep, no types; load-only probe
                import('onnxruntime-node'),
        ),
        await probe('@orama/orama', () => import('@orama/orama')),
        await probe(
            '@orama/plugin-data-persistence',
            () => import('@orama/plugin-data-persistence'),
        ),
        await probe(
            '@/lib/search-index/search',
            () => import('@/lib/search-index/search'),
        ),
        await probe(
            '@/lib/search-index/get-doc',
            () => import('@/lib/search-index/get-doc'),
        ),
    ];

    let search: unknown;
    try {
        const { searchDocs } = await import('@/lib/search-index/search');
        const hits = await searchDocs('retry flaky upstream', { limit: 2 });
        search = { ok: true, hitCount: hits.length, first: hits[0]?.pageUrl };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        search = {
            ok: false,
            code: err.code,
            message: String(err.message).slice(0, 500),
            stack: String(err.stack ?? '')
                .split('\n')
                .slice(0, 5),
        };
    }

    return Response.json({ node: process.version, probes, search });
}
