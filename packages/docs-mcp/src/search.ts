// Hybrid (BM25 + vector) search over the BUNDLED docs index — the local
// counterpart to apps/docs/lib/search-index/search.ts. Restores the Orama dump
// shipped in data/docs-index.json (built ahead of time by apps/docs's
// build:mcp-bundle, copied in at package build time — see scripts/copy-bundle.mjs),
// embeds the query with the same local model the index used, and runs Orama in
// hybrid mode. No network call for the search itself.
import {
    DATA_DIR,
    FIELD_BOOST,
    HYBRID_WEIGHTS,
    INDEX_FILE,
    MAX_QUERY_LEN,
    VECTOR_FIELD,
} from './config';
import { embedOne } from './embed';

import { type AnyOrama, type SearchParams, search } from '@orama/orama';
import { restore } from '@orama/plugin-data-persistence';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A single section hit from the hybrid search engine. */
export interface DocSearchHit {
    pageUrl: string;
    pageTitle: string;
    heading: string;
    anchor: string;
    text: string;
    score: number;
}

/**
 * Relative weight of each retrieval mode in hybrid scoring. Identity
 * pass-through to Orama's `hybridWeights` slot, so the field names are
 * Orama's, not house vocabulary (CONTRACT P18/P22).
 */
export interface HybridWeights {
    text: number;
    vector: number;
}

/**
 * Per-field full-text score boost. Identity pass-through to Orama's `boost`
 * slot; the field names are the bundled index's schema fields (CONTRACT
 * P18/P22).
 */
export interface FieldBoost {
    pageTitle: number;
    heading: number;
}

export interface SearchOptions {
    limit?: number;
    hybridWeights?: HybridWeights;
    boost?: FieldBoost;
}

let cached: Promise<AnyOrama> | undefined;

function indexPath(): string {
    // this file: packages/docs-mcp/src/search.ts (dev) or lib/index.mjs (built) →
    // packages/docs-mcp/data/<file> either way, since both are one level from
    // the package root.
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', DATA_DIR, INDEX_FILE);
}

/**
 * Restore (once) the bundled Orama index. Throws if the bundle is missing or
 * corrupt. This process is long-lived (a stdio server), so a corrupt-index
 * failure must not wedge every later search_docs call: reset the cache on
 * rejection so the next call retries the restore instead of replaying the
 * same stale rejection forever.
 */
export function loadIndex(): Promise<AnyOrama> {
    if (!cached) {
        let raw: string;
        try {
            raw = readFileSync(indexPath(), 'utf8');
        } catch (e) {
            throw new Error(
                `docs-mcp: bundled index not found at ${indexPath()}. ` +
                    `This package ships prebuilt at data/${INDEX_FILE} — a corrupt ` +
                    `install, not something to build locally. Reinstall @stitchapi/docs-mcp.`,
                { cause: e },
            );
        }
        cached = restore('json', raw).catch((e: unknown) => {
            cached = undefined;
            throw new Error(
                `docs-mcp: bundled index at ${indexPath()} is corrupt or unreadable. ` +
                    `Reinstall @stitchapi/docs-mcp.`,
                { cause: e },
            );
        });
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
    const term = query.trim().slice(0, MAX_QUERY_LEN);
    if (!term) return [];

    const db = await loadIndex();
    const vector = await embedOne(term);
    const params: SearchParams<AnyOrama> = {
        mode: 'hybrid',
        term,
        vector: { value: vector, property: VECTOR_FIELD },
        properties: ['pageTitle', 'heading', 'text'],
        hybridWeights,
        // Fresh object literal, not the interface value: named interfaces get
        // no implicit index signature (unlike the anonymous type this replaced),
        // so FieldBoost isn't directly assignable to Orama's
        // Partial<Record<string, number>>. Same fields, identity pass-through.
        boost: { ...boost },
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
