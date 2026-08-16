// Regression coverage for how /api/search-docs reports a *broken* search, and
// for the memoized-rejection trap behind it.
//
// Both matter for the same user-visible symptom: the fumadocs search dialog
// renders nothing at all when a request fails, so any failure here reads as
// "search is broken, it shows nothing" with no error anywhere on the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/search-index/search', () => ({
    searchDocs: vi.fn(),
}));

// transformers.js resolves its Node backend to a native onnxruntime addon at
// import; stub the module so this spec stays in the pure vitest job.
vi.mock('@huggingface/transformers', () => ({
    env: {},
    pipeline: vi.fn(),
}));

const { searchDocs } = await import('@/lib/search-index/search');
const { pipeline } = await import('@huggingface/transformers');
const { getEmbedder } = await import('@/lib/search-index/embed');
const { GET } = await import('@/app/api/search-docs/route');

const mockedSearchDocs = vi.mocked(searchDocs);
const mockedPipeline = vi.mocked(pipeline);

function request(query: string): Request {
    return new Request(
        `https://stitchapi.dev/api/search-docs?query=${encodeURIComponent(query)}`,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('/api/search-docs failure reporting', () => {
    it('answers 503 — not 200 [] — when the engine throws', async () => {
        // 200 [] made a broken index indistinguishable from a query with no
        // matches: uptime checks read the outage as healthy, and fumadocs'
        // fetch client memoizes per-URL for the page's lifetime, so the empty
        // array stuck to that query even after the backend recovered.
        mockedSearchDocs.mockRejectedValueOnce(
            new Error("ENOENT: .search-index/docs-index.json doesn't exist"),
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(request('retry'));

        expect(res.status).toBe(503);
        expect(res.ok).toBe(false);
    });

    it('still answers 200 [] for a blank query', async () => {
        const res = await GET(request('   '));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual([]);
        expect(mockedSearchDocs).not.toHaveBeenCalled();
    });

    it('answers 200 with results on the happy path', async () => {
        mockedSearchDocs.mockResolvedValueOnce([
            {
                pageUrl: '/docs/guides/resilience/retry',
                pageTitle: 'Retry & backoff',
                heading: 'Options',
                anchor: 'options',
                text: 'body',
                score: 1,
            },
        ]);

        const res = await GET(request('retry'));

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual([
            {
                id: 'page:/docs/guides/resilience/retry',
                url: '/docs/guides/resilience/retry',
                type: 'page',
                content: 'Retry & backoff',
            },
            {
                id: 'hit:0:/docs/guides/resilience/retry#options',
                url: '/docs/guides/resilience/retry#options',
                type: 'heading',
                content: 'Options',
            },
        ]);
    });
});

describe('getEmbedder', () => {
    it('does not memoize a rejected load', async () => {
        // The load can still fail with the weights shipped alongside the
        // function — a bad @huggingface/transformers import is the case the
        // deferred import in embed.ts exists for. Memoizing that rejection
        // would leave every later query on the same warm instance awaiting the
        // same settled promise — a permanent, silent search outage on that
        // instance, recoverable only by a recycle, which is the instance-wide
        // failure the deferral was meant to prevent.
        mockedPipeline.mockRejectedValueOnce(new Error('model load failed'));

        await expect(getEmbedder()).rejects.toThrow('model load failed');

        // A second call must retry rather than hand back the settled rejection.
        const reloaded = { name: 'reloaded' };
        mockedPipeline.mockResolvedValueOnce(reloaded as never);
        await expect(getEmbedder()).resolves.toBe(reloaded);
        expect(mockedPipeline).toHaveBeenCalledTimes(2);
    });
});
