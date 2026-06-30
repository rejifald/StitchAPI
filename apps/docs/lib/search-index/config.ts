// Shared configuration for the build-time semantic docs index (P1) and the
// retrieval route that will consume it (P2). Kept in one place so the build
// pipeline and the serving path can never disagree on the model, the vector
// dimension, or the Orama schema.
//
// See docs/proposals/search-docs.md.

// Local-open embedding model (transformers.js). Self-contained: no API key, no
// third-party service in the build. all-MiniLM-L6-v2 is 384-dim and is what the
// proposal's §6 spike measured.
export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

// fp32 (not a quantized variant) so the same text embeds to the same vector
// build-to-build — the determinism the index build asserts. Quantization is a
// P3 cold-start lever, not a P1 default.
export const EMBED_DTYPE = 'fp32' as const;

// all-MiniLM-L6-v2 emits 384-dim sentence embeddings.
export const EMBED_DIM = 384;

// The Orama field that holds each chunk's embedding. Hybrid search (P2) reads
// BM25 over the text fields and ANN over this one.
export const VECTOR_FIELD = 'embedding';

// Orama collection schema. The text fields back BM25; `embedding` backs vector
// search. `as const` keeps `vector[384]` a literal so it satisfies Orama's
// `vector[${number}]` field type. Reused verbatim by the P2 route when it
// restores the persisted index.
export const ORAMA_SCHEMA = {
    pageUrl: 'string',
    pageTitle: 'string',
    heading: 'string',
    anchor: 'string',
    text: 'string',
    embedding: 'vector[384]',
} as const;

// Build artifact location, relative to apps/docs. Regenerated every deploy from
// the MDX (same source as llms.txt) and never committed — see .gitignore.
export const INDEX_DIR = '.search-index';
export const INDEX_FILE = 'docs-index.json';
export const MANIFEST_FILE = 'manifest.json';
