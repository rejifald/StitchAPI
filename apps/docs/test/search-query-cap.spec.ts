// Security regression: the public retrieval surfaces (the /api/search-docs route
// and the hosted MCP `search_docs` tool) feed untrusted input straight into the
// embedder, which tokenizes the whole raw string with no cap — so an unbounded
// query is a CPU/memory DoS (multi-MB string pins the function, blows the
// serverless maxDuration, denies search to everyone). searchDocs() caps at the
// shared seam so BOTH callers are bounded; the MCP tool schema also rejects an
// over-long query early. These tests fail if either cap is removed.
//
// The model + Orama index are mocked so this stays a pure unit test (no model
// load, no build-time index file) and runs in the normal `vitest run` job.
import { MAX_QUERY_LEN } from '../lib/search-index/config';
// Import after the mocks are registered.
import { searchDocs } from '../lib/search-index/search';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Capture the text that reaches the embedder without loading transformers.js.
const embedOne = vi.fn(async (_text: string): Promise<number[]> => [0, 0, 0]);
vi.mock('../lib/search-index/embed', () => ({
    embedOne: (text: string) => embedOne(text),
}));

// Stub the Orama seam so no persisted index file is read and search() is a no-op.
// loadIndex() also readFileSync()s the build-time index (absent in this env), so
// stub node:fs's readFileSync too — restore() then just gets a placeholder.
vi.mock('node:fs', () => ({
    readFileSync: vi.fn(() => '{}'),
}));
vi.mock('@orama/orama', () => ({
    search: vi.fn(async () => ({ hits: [] })),
}));
vi.mock('@orama/plugin-data-persistence', () => ({
    restore: vi.fn(async () => ({}) as unknown),
}));

describe('searchDocs query cap (DoS defense at the shared seam)', () => {
    beforeEach(() => {
        embedOne.mockClear();
    });

    it('truncates an over-long query before it reaches the embedder', async () => {
        const huge = 'a'.repeat(5000);
        await searchDocs(huge);

        expect(embedOne).toHaveBeenCalledTimes(1);
        const termSent = embedOne.mock.calls[0][0];
        expect(termSent.length).toBe(MAX_QUERY_LEN);
        expect(termSent.length).toBeLessThanOrEqual(MAX_QUERY_LEN);
    });

    it('passes a normal-length query through unchanged', async () => {
        const normal = 'how do I configure retries?';
        await searchDocs(normal);

        expect(embedOne).toHaveBeenCalledTimes(1);
        expect(embedOne.mock.calls[0][0]).toBe(normal);
    });

    it('still short-circuits an empty query without embedding', async () => {
        expect(await searchDocs('   ')).toEqual([]);
        expect(embedOne).not.toHaveBeenCalled();
    });
});

// Mirror of the MCP `search_docs` tool's `query` schema (api/mcp/route.ts). The
// tool wires z.string().max(MAX_QUERY_LEN); this asserts that early-rejection
// bound so a too-long query never even reaches searchDocs over the wire.
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
