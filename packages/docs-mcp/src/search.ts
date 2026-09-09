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

/**
 * One document as the BUNDLED INDEX stores it — Orama's spelling, because these are the schema
 * fields the index was built with: the dump itself, the `properties` search list and `boost`
 * ({@link FieldBoost}) all key on them. This is the layer that MEETS Orama (CONTRACT P18/P22),
 * so it is the layer the mirror rule pins — and it is deliberately NOT exported, because a
 * consumer of this package never handles one. {@link searchDocs} converts it at the edge.
 */
interface IndexedDoc {
    pageUrl: string;
    pageTitle: string;
    heading: string;
    anchor: string;
    text: string;
}

/**
 * A single section hit from the hybrid search engine — house vocabulary, converted from
 * {@link IndexedDoc} at the one point the index is read.
 *
 * `path`, not `url`: the value is site-relative (`/docs/…`), and `anchor` addresses the section
 * within it — the two compose into an absolute URL at the MCP boundary. Naming it `url` beside
 * an `anchor` would promise a whole address and hand back half of one.
 */
export interface DocSearchHit {
    /** Site-relative path of the page (`/docs/…`); `anchor` addresses the section within it. */
    path: string;
    /** The page's own title; `heading` is the section within it, when there is one. */
    title: string;
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
    // `undefined` means the optional `@huggingface/transformers` peer is not installed, so there is
    // no query vector to search with. Degrade to BM25 over the same bundled index rather than
    // failing: full-text still answers the question, just without the semantic half. Installing the
    // peer restores hybrid scoring with no other change.
    const vector = await embedOne(term);
    const common = {
        term,
        properties: ['pageTitle', 'heading', 'text'],
        // Fresh object literal, not the interface value: named interfaces get
        // no implicit index signature (unlike the anonymous type this replaced),
        // so FieldBoost isn't directly assignable to Orama's
        // Partial<Record<string, number>>. Same fields, identity pass-through.
        boost: { ...boost },
        limit,
    };
    // `similarity` and `includeVectors` are vector-search knobs — Orama's `SearchParamsFullText`
    // does not accept them, so they live in the hybrid arm rather than the shared half.
    const params: SearchParams<AnyOrama> =
        vector === undefined
            ? { ...common, mode: 'fulltext' }
            : {
                  ...common,
                  mode: 'hybrid',
                  vector: { value: vector, property: VECTOR_FIELD },
                  hybridWeights,
                  similarity: 0,
                  includeVectors: false,
              };
    const results = await search(db, params);

    // The ONE conversion point between the index's vocabulary and the house one (P18/P22:
    // convert at the edge). This used to be a `{ ...doc, score }` spread behind an
    // `as unknown as Omit<DocSearchHit, 'score'>` cast, which asserted the stored document and
    // the published hit were the same object — that is what let the index's field names leak
    // onto the published type, and it would have gone on typechecking the day the schema
    // changed. Naming the stored shape and mapping field by field makes both layers typed and
    // the boundary visible.
    return results.hits.map((hit) => {
        const doc = hit.document as unknown as IndexedDoc;
        return {
            path: doc.pageUrl,
            title: doc.pageTitle,
            heading: doc.heading,
            anchor: doc.anchor,
            text: doc.text,
            score: hit.score,
        };
    });
}
