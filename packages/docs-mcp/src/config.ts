// Shared configuration for the local docs-mcp server. Mirrors
// apps/docs/lib/search-index/config.ts verbatim for the model/schema constants
// — those two MUST agree, since this package restores an Orama index built by
// that file's pipeline (apps/docs/scripts/build-search-index.ts) and embeds
// queries with the same model. Kept as a separate copy (not a shared package)
// deliberately, see README.md "Keeping this in sync" — flagged the same way the
// aws-sigv4 package flags its own hand-mirrored encoder.

// Local-open embedding model (transformers.js) — must match
// apps/docs/lib/search-index/config.ts EMBED_MODEL exactly, or a query embeds
// into a different vector space than the bundled index was built in.
export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DTYPE = 'fp32' as const;
export const EMBED_DIM = 384;
export const VECTOR_FIELD = 'embedding';

export const HYBRID_WEIGHTS = { text: 0.2, vector: 0.8 };
export const FIELD_BOOST = { pageTitle: 3, heading: 2 };

// Same bound as the hosted MCP: an unbounded query tokenizes/embeds arbitrary
// input, which pins CPU/memory on whatever machine is running the server —
// here, the user's own, not ours, but the DoS shape is identical.
export const MAX_QUERY_LEN = 512;

// Bundled build artifacts, written by scripts/copy-bundle.mjs (a prebuild step)
// from apps/docs's `build:mcp-bundle` output. Committed to the npm tarball via
// package.json `files`, never to git — see .gitignore.
export const DATA_DIR = 'data';
export const INDEX_FILE = 'docs-index.json';
export const PAGES_FILE = 'docs-pages.json';
export const MANIFEST_FILE = 'manifest.json';
