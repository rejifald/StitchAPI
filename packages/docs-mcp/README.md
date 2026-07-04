# @stitchapi/docs-mcp

[![npm](https://img.shields.io/npm/v/@stitchapi/docs-mcp?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/docs-mcp)

**StitchAPI documentation search, running entirely on your machine.** The docs
corpus and its semantic search index ship bundled inside this package — no
network call per query, no query or doc content ever sent anywhere. This is
the local/offline counterpart to the hosted
[`stitchapi.dev/api/mcp`](https://stitchapi.dev/docs/agents) server: same two
tools, same schemas, same responses — just a different transport (stdio
instead of Streamable HTTP) and a different data source (bundled files instead
of a live index).

Point an MCP-capable agent/host at the `stitchapi-docs-mcp` command:

```json
{
    "mcpServers": {
        "stitchapi-docs": {
            "command": "npx",
            "args": ["-y", "@stitchapi/docs-mcp"]
        }
    }
}
```

## Why local

The hosted server is simpler to add (just a URL) and always current. This
package exists for the cases where that's not an option:

-   **No third-party network dependency.** Every `search_docs`/`get_doc` call
    runs against the bundled index and the bundled Markdown — nothing you
    search for, and nothing in your docs, is ever transmitted. The only
    network activity is a one-time download of the embedding model
    (`Xenova/all-MiniLM-L6-v2`, via `transformers.js`) into a local OS cache
    directory on first use; every call after that is fully offline.
-   **Air-gapped / strict egress environments.** Since content is bundled at
    publish time (not fetched at runtime), the only network dependency at all
    is the ordinary `npm install` / `npx` resolution — the same as any npm
    package. There's no bespoke endpoint to allowlist.
-   **A Docker path for Dockerfile-based MCP catalogs.** See `Dockerfile` in
    this package — it builds from the monorepo, not from a published npm
    version, so it stays honest about what it's running.

## Tools

Identical contract to the hosted server:

-   **`search_docs({ query, limit? })`** — hybrid (BM25 + vector) search over
    the docs. Returns the most relevant sections as `{ title, url, excerpt,
score }` — never full pages.
-   **`get_doc({ url?, slug? })`** — fetches a full page as Markdown, given
    either a `url` (as returned by `search_docs`) or a bare `slug` like
    `"guides/resilience/throttle"`.

## Keeping docs fresh

This package's `data/` snapshot is produced at **build time**, not fetched at
runtime — `scripts/copy-bundle.mjs` (a `prebuild` step) runs apps/docs's own
`build:mcp-bundle` pipeline and copies the result in. That means freshness is
tied to _when this package was last published_, not a live check: every
lockstep release (see `.github/workflows/npm-publish.yml`) rebuilds this
package from whatever `apps/docs/content` looks like on the released commit,
so `@stitchapi/docs-mcp@X` is a reproducible, auditable snapshot — you can
always know exactly what docs a given version contains. The tradeoff: if
`apps/docs` content changes between releases, this package doesn't pick it up
until the next one ships. There's no live-fetch fallback by design — that
would reintroduce the network dependency this package exists to avoid.

## Keeping this in sync

A handful of files here are deliberately-flagged **mirrors** of
`apps/docs/lib/search-index/*`, not derivations:

-   `src/config.ts` — the embedding model/dtype/dim and hybrid-search
    weights **must** match `apps/docs/lib/search-index/config.ts` exactly, or
    a query embeds into a different vector space than the bundled index was
    built in.
-   `src/doc-path.ts` — a verbatim copy (that file has no fumadocs
    dependency either, so it's a straight copy, not a re-derivation).

This is the same hand-mirrored-constant tradeoff `@stitchapi/aws-sigv4` flags
for its `formEncode` helper — update both together, or search silently drifts
from the hosted server's results.

## Public API

-   `createServer()` → an `McpServer` (for embedding in a custom host instead
    of running the `stitchapi-docs-mcp` bin)
-   `searchDocs(query, options?)`, `getDoc({ url?, slug? })` — the underlying
    retrieval functions

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
