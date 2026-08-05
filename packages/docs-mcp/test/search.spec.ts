// Ported from apps/docs/test/search-query-cap.spec.ts (see that file's header
// for the DoS-defense rationale — searchDocs() caps at this shared seam so
// every caller is bounded even if a caller's own schema guard is missing),
// plus a hit-mapping shape test new to this package. The model + Orama index
// are mocked so this stays a pure unit test.
import { MAX_QUERY_LEN } from '../src/config';
// Import after the mocks are registered.
import { searchDocs } from '../src/search';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const embedOne = vi.fn(async (_text: string): Promise<number[]> => [0, 0, 0]);
vi.mock('../src/embed', () => ({
    embedOne: (text: string) => embedOne(text),
}));

vi.mock('node:fs', () => ({
    readFileSync: vi.fn(() => '{}'),
}));

const searchMock = vi.fn(async (..._args: unknown[]) => ({
    hits: [] as unknown[],
}));
vi.mock('@orama/orama', () => ({
    search: (...args: unknown[]) => searchMock(...args),
}));
vi.mock('@orama/plugin-data-persistence', () => ({
    restore: vi.fn(async () => ({})),
}));

describe('searchDocs query cap (DoS defense at the shared seam)', () => {
    beforeEach(() => {
        embedOne.mockClear();
        searchMock.mockClear().mockResolvedValue({ hits: [] });
    });

    it('truncates an over-long query before it reaches the embedder', async () => {
        const huge = 'a'.repeat(5000);
        await searchDocs(huge);

        expect(embedOne).toHaveBeenCalledTimes(1);
        const termSent = embedOne.mock.calls[0]?.[0];
        expect(termSent?.length).toBe(MAX_QUERY_LEN);
    });

    it('passes a normal-length query through unchanged', async () => {
        const normal = 'how do I configure retries?';
        await searchDocs(normal);

        expect(embedOne).toHaveBeenCalledTimes(1);
        expect(embedOne.mock.calls[0]?.[0]).toBe(normal);
    });

    it('still short-circuits an empty query without embedding', async () => {
        expect(await searchDocs('   ')).toEqual([]);
        expect(embedOne).not.toHaveBeenCalled();
    });
});

// Mirror of the MCP `search_docs` tool's `query` schema (server.ts). Asserts
// the early-rejection bound so a too-long query never even reaches searchDocs
// over the wire.
describe('MCP search_docs query schema (.max cap)', () => {
    const querySchema = z.string().max(MAX_QUERY_LEN);

    it('rejects a query longer than MAX_QUERY_LEN', () => {
        expect(
            querySchema.safeParse('a'.repeat(MAX_QUERY_LEN + 1)).success,
        ).toBe(false);
    });

    it('accepts a query at the cap', () => {
        expect(querySchema.safeParse('a'.repeat(MAX_QUERY_LEN)).success).toBe(
            true,
        );
    });
});

describe('searchDocs hit mapping', () => {
    beforeEach(() => {
        embedOne.mockClear();
    });

    it('maps every Orama hit field through to DocSearchHit unchanged, alongside the hit score', async () => {
        searchMock.mockResolvedValueOnce({
            hits: [
                {
                    document: {
                        pageUrl: '/docs/guides/x',
                        pageTitle: 'X Guide',
                        heading: 'Retries',
                        anchor: 'retries',
                        text: 'body text',
                    },
                    score: 0.123456,
                },
            ],
        });

        const hits = await searchDocs('anything');

        expect(hits).toEqual([
            {
                pageUrl: '/docs/guides/x',
                pageTitle: 'X Guide',
                heading: 'Retries',
                anchor: 'retries',
                text: 'body text',
                score: 0.123456,
            },
        ]);
    });

    it('returns an empty array when Orama returns no hits', async () => {
        searchMock.mockResolvedValueOnce({ hits: [] });
        expect(await searchDocs('anything')).toEqual([]);
    });
});
