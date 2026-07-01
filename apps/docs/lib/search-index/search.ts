// Hybrid (BM25 + vector) search over the persisted docs index. Restores the
// Orama dump built by scripts/build-search-index.ts (once, cached), embeds the
// query with the SAME local model the index used, and runs Orama in hybrid mode.
// Consumed by app/api/search-docs/route.ts (P2) and the MCP server (P3).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AnyOrama, type SearchParams, search } from '@orama/orama';
import { restore } from '@orama/plugin-data-persistence';

import { INDEX_DIR, INDEX_FILE, VECTOR_FIELD } from './config';
import { embedOne } from './embed';
import { type DocSearchHit } from './sorted-result';

// Hybrid retrieval knobs, kept as named exports so the search-eval harness can
// sweep them and the CI ratchet pins the shipped values.
//
// Vector-dominant at 0.8: BM25 still adds literal recall (error codes, fn names
// the small model misses), but at the earlier 0.3 a common token — "API" in a
// title like `apiKey` — pulled that page to #1 for unrelated resilience/agent
// queries. Lowering BM25's share demotes that spurious literal match while
// leaving the boosts (a page *about* a term beats a passing mention) intact.
// Swept over the golden set: R@1 0.880→0.920, MRR 0.927→0.953, no regressions.
export const HYBRID_WEIGHTS = { text: 0.2, vector: 0.8 };
export const FIELD_BOOST = { pageTitle: 3, heading: 2 };

/** Options for {@link searchDocs}. Weights/boosts default to the shipped values. */
export interface SearchOptions {
    limit?: number;
    hybridWeights?: { text: number; vector: number };
    boost?: { pageTitle: number; heading: number };
}

let cached: Promise<AnyOrama> | undefined;

function indexPath(): string {
    // this file: apps/docs/lib/search-index/search.ts → apps/docs/.search-index/<file>
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', INDEX_DIR, INDEX_FILE);
}

/** Restore (once) the persisted Orama index. Throws if it hasn't been built. */
export function loadIndex(): Promise<AnyOrama> {
    if (!cached) {
        cached = restore('json', readFileSync(indexPath(), 'utf8'));
    }
    return cached;
}

/** Hybrid (BM25 + vector) search; returns the top section hits for a query. */
export async function searchDocs(
    query: string,
    {
        limit = 8,
        hybridWeights = HYBRID_WEIGHTS,
        boost = FIELD_BOOST,
    }: SearchOptions = {},
): Promise<DocSearchHit[]> {
    const term = query.trim();
    if (!term) return [];

    const db = await loadIndex();
    const vector = await embedOne(term);
    const params: SearchParams<AnyOrama> = {
        mode: 'hybrid',
        term,
        vector: { value: vector, property: VECTOR_FIELD },
        properties: ['pageTitle', 'heading', 'text'],
        // Vector-dominant: semantic match leads (equal weighting let BM25
        // stop-word noise top the results), while BM25 still adds literal-term
        // recall (error codes, fn names) the small model misses. Title/heading
        // are boosted so a page that is *about* the term beats a passing mention
        // in body text. See HYBRID_WEIGHTS / FIELD_BOOST for the tuned values.
        hybridWeights,
        boost,
        similarity: 0,
        includeVectors: false,
        limit,
    };
    const results = await search(db, params);

    return results.hits.map((hit) => {
        const doc = hit.document as unknown as Omit<DocSearchHit, 'score'>;
        return { ...doc, score: hit.score };
    });
}
