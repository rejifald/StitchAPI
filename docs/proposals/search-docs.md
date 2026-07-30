# Proposal — `search_docs`: a hosted docs-retrieval MCP

**Status:** proposed · **Scope:** `apps/docs` (build-time index + `/api/search-docs` + `/api/mcp`); no `packages/core` change · **Target branch:** `main`
**Relates:** `content/docs/agents/llms-txt.mdx` ("Default: load the whole corpus"); the agent-native thesis (`DESIGN.md`, `FEATURE-LENSES.md`). **Complements, does not replace** the library MCP `stitchapi/mcp` (`run_stitch`).

> [!NOTE]
>
> A design record, not yet implemented. It folds in the one open design fork —
> the embedding model (local-open vs. hosted API) — and resolves it with a
> measured spike (§6), not a guess.

---

## TL;DR

Today an agent has two ways to consume our docs: scrape rendered HTML (wasteful),
or load `/llms-full.txt` — the **whole ~84k-token corpus** — into context every
turn. The second is correct (the corpus fits a 200k window) but expensive: it
costs prefill tokens on every turn and crowds out the agent's working memory. Our
existing site search (`/api/search`, Orama) is keyword-only **and not
agent-reachable**.

Propose a **hosted docs-retrieval MCP** at `stitchapi.dev`: a `search_docs` tool
that returns just the handful of relevant doc _sections_ for a query (~1k
tokens), plus `get_doc` to pull a full page when the agent wants it. Retrieval is
**hybrid** (BM25 + vector) layered onto the **Orama index we already build**, and
the chunk index is generated at deploy from the **same processed MDX that feeds
`llms.txt`** — so it cannot drift.

A measured spike over the live docs (§6) shows **~85× fewer tokens per lookup**
(≈990 vs ≈84k) at **~3.5 ms warm retrieval**, with genuinely semantic matches
(it found Throttle / circuit-breaker for _"stop hammering a flaky upstream"_ — no
shared keywords).

This is **not** `stitchapi/mcp`. That is a _library_ surface users run over
_their_ stitches; this is a _docs service_ we host. Together they close the loop:
`search_docs` (learn the API) → `get_doc` (read the page) → `run_stitch` (call
it).

---

## 1. Problem, and why now

- **Load-it-all has a per-turn tax.** `llms-full.txt` fits in context, so it is
  the right default today (and stays the default for small corpora — see §8). But
  an agent that reloads ~84k tokens every turn pays for them every turn, in money
  and in prefill latency, and has that much less room for its own reasoning. A
  targeted lookup returns ~1k tokens instead.
- **Orama is keyword-only and invisible to agents.** The site's human search
  can't match on meaning (a query phrased in the user's words misses the page
  that uses ours), and there is no tool an agent can call to reach it.
- **Dual value.** The same retrieval engine upgrades the **human** site search
  from keyword to semantic _and_ gives **agents** a context-frugal tool. That
  second beneficiary is why this is worth building before the corpus outgrows the
  window: §6's P2 stands on its own even if P3 never ships.

## 2. Not the same as `run_stitch`

|            | `stitchapi/mcp` (exists)                  | `search_docs` (this)          |
| ---------- | ----------------------------------------- | ----------------------------- |
| Audience   | The user's agent, calling the user's APIs | Any agent, learning StitchAPI |
| Runs where | The user's machine/server (stdio)         | We host it (stitchapi.dev)    |
| Over what  | The user's stitch registry                | Our docs corpus               |
| Transport  | stdio JSON-RPC                            | MCP Streamable HTTP           |

They are siblings, not substitutes. Documenting the distinction is part of P4 so
nobody wires the wrong one.

## 3. Architecture — four layers, reusing what we have

1. **Index pipeline (build-time).** A step in `next build` iterates
   `source.getPages()` → `page.data.getText('processed')` — the _same_ processed
   markdown `getLLMText` already emits for `llms.txt` — splits each page on H2/H3
   into self-contained chunks (`{ pageUrl, title, heading, anchor, text }`), and
   embeds each. Built from MDX every deploy, never committed → it can't drift,
   same cadence and source as `llms.txt`.
2. **Store — extend Orama, don't add a vector DB.** We already run Orama for
   `/api/search`. Add a vector field per chunk and persist the index
   (`@orama/plugin-data-persistence`) as a build artifact the route loads. Search
   runs Orama **hybrid** (BM25 + vector). No Pinecone, no external store — on
   brand with zero-infra. (Integration note: hybrid may require building the
   index against `@orama/orama` directly rather than the fumadocs search wrapper;
   confirm in P1.)
3. **Serving — one engine, two consumers.** `app/api/search-docs/route.ts`
   embeds the query, runs hybrid search, returns top-k `{ title, url#anchor,
excerpt, score }`. Point the existing human search UI at it too → semantic
   site search, free.
4. **MCP wrapper.** `app/api/mcp/route.ts` speaks **MCP Streamable HTTP**
   (network transport, unlike the library's stdio) and exposes the two tools.

## 4. Tool contract

```ts
// Context-frugal by design: excerpts + links, NOT full pages. That frugality is
// the entire reason this beats `llms-full.txt`.
declare function search_docs(input: {
    query: string;
    limit?: number; // default 5
}): Array<{ title: string; url: string; excerpt: string; score: number }>; // url incl. #anchor

// The "read the whole thing" escape hatch — wraps the existing /llms.mdx route.
declare function get_doc(input: { url: string } | { slug: string }): {
    title: string;
    markdown: string;
};
```

## 5. Decisions (recommended defaults)

| Decision        | Recommended                                                                         | Why                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Embedding model | **Local-open small** (MiniLM/`bge-small` via transformers.js); hosted API as opt-in | Self-contained, no external key/service. It's the _docs app_, not the shipped lib, so a build dep is fine. Validated in §6. |
| Retrieval       | **Hybrid (BM25 + vector)** over Orama                                               | Reuses infra; BM25 catches literal terms the small model misses (§6)                                                        |
| Chunking        | **Section-level (H2/H3) + page breadcrumb**                                         | Pages are already self-contained; precise, citeable anchors                                                                 |
| Transport       | **Both** — HTTP engine + MCP Streamable HTTP wrapper                                | One engine serves humans and agents                                                                                         |
| Index storage   | **Build-at-deploy, not committed**                                                  | No binary diffs; regenerates from MDX like `llms.txt`                                                                       |

## 6. The embedding model — measured, not assumed

A throwaway spike (transformers.js + `all-MiniLM-L6-v2`, 384-dim/~23 MB, over the
live 105-page corpus) settles the fork in favour of a **local-open** model:

| Metric                    | Result                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus                    | 105 pages → 451 section-chunks, ~84k tokens                                                                                                                                      |
| One-time index build      | model load ~22 s (incl. download) + embed ~11 s (25 ms/chunk) — **per deploy**                                                                                                   |
| Per-lookup latency (warm) | **median ~3.5 ms** (~2–3 ms query embed + <1 ms search)                                                                                                                          |
| Tokens per lookup         | **~990 avg vs ~84k full-load → ~85× reduction** (249× best case)                                                                                                                 |
| Relevance                 | semantic: _"stop hammering a flaky upstream"_ → Throttle, RateLimitError, circuit-breaker; _"agent call my API without exposing the secret"_ → bearer, capability-not-credential |

**What the spike also exposed (and why we still want hybrid):** the small model's
weakest query was _"cache responses and invalidate when the schema changes"_ — it
surfaced Drift/Validation before the literal **Cache** pages. BM25 catches the
exact term `cache`; a stronger model (`bge-small`/`gte-small`) lifts semantic
recall. Hybrid gets both — hence the §5 default.

**The one watch-item — serverless cold start.** Warm query-embed is ~2–3 ms, but
the model must be _loaded_ in the function; a cold start pays seconds. The index
build's ~11 s embed runs in **CI**, not per request, so it's amortized — only the
query path is affected. Mitigations, in order of preference: keep-warm / move to
an edge runtime; a smaller quantized model; or a hosted embedding API for
**queries only** (opt-in, the §5 fallback). Resolve during P3 with a real
cold-start measurement on Vercel.

## 7. Anti-drift & gates

- **Built from the one source.** The index derives from `getText('processed')`,
  same as `llms.txt` and the HTML — edit an MDX file and all three move together.
  Regenerated every deploy; nothing to hand-sync.
- **A build gate**, mirroring the `gen:docs` diff gate: CI fails if the index
  step errors or a chunk has no `description`/title (the manifest already makes
  descriptions mandatory).
- **No core impact.** Everything lives in `apps/docs`; `packages/core` gains no
  dependency and the bundle gates are untouched. (This is server-only docs infra,
  so the browser-first / bundle-frugal gates that govern the _library_ don't
  apply.)

## 8. What to hold the line on

- **Stay context-frugal.** `search_docs` returns excerpts + links, never full
  pages. The moment it dumps whole pages it's just a slower `llms-full.txt`.
- **Don't add an external vector DB.** Extend Orama. Self-contained is the brand.
- **Self-contained by default.** A local model means no key, no third-party
  service in the request path. A hosted embedding API is an opt-in upgrade, never
  the default.
- **Keep `llms.txt` / `llms-full.txt`.** `search_docs` is additive. For a corpus
  this size, "just load it all" remains the documented default (see the agents
  page); retrieval is the path for scale and per-turn frugality, not a
  replacement.
- **Don't conflate with `run_stitch`** (see §2).

## 9. Phasing (one PR each, stop between)

1. **P1** — Build-time index pipeline: chunk on H2/H3 from `getText('processed')`,
   embed locally, persist an Orama dump. No serving yet; verify chunk count +
   embedding determinism.
2. **P2** — `/api/search-docs` hybrid route **and swap the site search UI onto
   it.** Independently shippable: semantic search for human visitors.
3. **P3** — `/api/mcp` Streamable HTTP server exposing `search_docs` + `get_doc`;
   resolve the cold-start question with a real Vercel measurement.
4. **P4** — `agents/` docs page ("Search the docs over MCP") + drop-in `mcp.json`
   snippets (Claude/Cursor) + a one-line pointer in the `llms.txt` preamble.
