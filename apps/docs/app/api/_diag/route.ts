// TEMPORARY diagnostic for the search_docs infra outage. Reports, from inside the
// deployed serverless function, which server-only imports resolve and whether a
// real search runs end-to-end — so a Vercel-only import/trace failure is visible
// without runtime-log access. Every probe is wrapped so this route itself never
// 500s (unlike /api/mcp + /api/search-docs, whose crash is at module import).
// Remove once those two routes are confirmed healthy.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
            message: String(err.message).slice(0, 300),
        };
    }
}

export async function GET(): Promise<Response> {
    const probes: Probe[] = [
        await probe(
            '@huggingface/transformers',
            () => import('@huggingface/transformers'),
        ),
        await probe(
            'onnxruntime-node',
            () =>
                // onnxruntime-node is a transitive native dep of transformers with no
                // type decls resolvable from apps/docs; we only probe that it loads.
                // @ts-expect-error -- no types, load-only probe
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
        search = {
            ok: true,
            hitCount: hits.length,
            first: hits[0]?.pageUrl,
        };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        search = {
            ok: false,
            code: err.code,
            message: String(err.message).slice(0, 400),
        };
    }

    return Response.json({
        node: process.version,
        cwd: process.cwd(),
        probes,
        search,
    });
}
