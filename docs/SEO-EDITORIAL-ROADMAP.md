# SEO Editorial Roadmap

**Status:** living plan · **Created:** 2026-06-28 · **Scope:** `apps/docs` (docs site + `/blog`)
**Companion:** [MESSAGING.md](./MESSAGING.md) · **Technical SEO shipped:** per-page structured data ([#332](https://github.com/rejifald/StitchAPI/pull/332)) + JSON-LD hardening ([#336](https://github.com/rejifald/StitchAPI/pull/336))

> [!NOTE]
>
> This is a content plan, not a spec. It maps where organic-search upside is and
> which posts capture it. Update the "Status" column on each pillar as posts ship.

---

## Diagnosis

The docs are comprehensive and the blog (16 posts as of 2026-06-28) is high quality —
but it skews **shareable**: thought-leadership and product-mechanism explainers framed
in StitchAPI's own vocabulary ("the seam", "make-a-flaky-call-succeed"). That serves
people who already found the project.

The gap is **searchable content that captures existing demand** — readers searching the
generic problem before they know StitchAPI exists. Three under-served intents:
**comparisons** (consideration), **"how to [task] in TypeScript"** (implementation), and
**definitions** (awareness + AI citation). Search order: capture demand first.

## Content pillars

| #   | Pillar                                        | Owns                                                          | Mode                               | Status                                                                                           |
| --- | --------------------------------------------- | ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | **Resilient API calls in TypeScript**         | retry / timeout / throttle / circuit-breaker / caching how-to | Searchable (implementation)        | mechanisms covered shareably; generic-query spokes missing                                       |
| 2   | **Agent-native API access (MCP & code-mode)** | "give an agent a tool", MCP, code-mode, credential-safe       | Shareable → Searchable (awareness) | strong opinion pieces; awareness/definition layer missing                                        |
| 3   | **Typed API clients without codegen**         | vs axios / ky / openapi-fetch / Orval, validation, drift      | Searchable (consideration)         | 2 comparisons exist; alternatives/"best" space open. **`axios-alternatives` shipped 2026-06-28** |
| 4   | **One definition, every surface**             | function ↔ CLI ↔ HTTP ↔ MCP, framework integrations           | Shareable + use-case               | well covered — maintain, add integration use-cases                                               |

Pillars 1–3 hold the SEO upside. Pillar 4 is the differentiation moat — keep feeding it,
but it is not the traffic engine.

## Priority topics (scored)

Scoring model: Customer Impact (40%), Content-Market Fit (30%), Search Potential (20%),
Resources (10%).

| Topic (working title)                                                 | Pillar | Mode   | Stage          | Target query                | Impact | Fit | Search | Res | Total   |
| --------------------------------------------------------------------- | ------ | ------ | -------------- | --------------------------- | ------ | --- | ------ | --- | ------- |
| Axios alternatives in 2026 (zero-dep, typed, resilient) — **shipped** | 3      | Search | Consideration  | "axios alternatives"        | 9      | 9   | 9      | 7   | **8.8** |
| How to retry a failed fetch in TypeScript (the right way)             | 1      | Search | Implementation | "retry fetch typescript"    | 9      | 9   | 8      | 8   | **8.7** |
| Code mode vs tool calling: giving an agent many tools                 | 2      | Both   | Awareness      | "code mode mcp"             | 9      | 9   | 8      | 6   | **8.4** |
| How to rate-limit / throttle API calls in Node & edge                 | 1      | Search | Implementation | "rate limit api calls node" | 8      | 9   | 8      | 7   | **8.2** |
| Type-safe API client without OpenAPI codegen                          | 3      | Search | Consideration  | "type-safe api client"      | 8      | 9   | 8      | 7   | **8.1** |
| How to add a timeout to fetch (total ≠ per-try)                       | 1      | Search | Implementation | "fetch timeout typescript"  | 8      | 8   | 8      | 9   | **8.0** |
| Validate an API response with Zod / Standard Schema                   | 1/3    | Search | Implementation | "validate api response zod" | 8      | 9   | 7      | 7   | **7.9** |
| What is schema drift? (glossary + how to detect it)                   | 3      | Both   | Awareness      | "what is schema drift"      | 7      | 9   | 7      | 8   | **7.6** |
| How to call an API from a Claude / MCP agent safely                   | 2      | Search | Awareness      | "call api from llm agent"   | 8      | 8   | 7      | 6   | **7.5** |
| Best way to handle pagination in TypeScript (into one array)          | 1      | Search | Implementation | "typescript paginate api"   | 7      | 8   | 7      | 8   | **7.4** |
| Circuit breaker pattern in Node/TypeScript (glossary + impl)          | 1      | Search | Awareness      | "circuit breaker nodejs"    | 7      | 8   | 7      | 7   | **7.3** |
| Hey API / Orval vs runtime stitching                                  | 3      | Search | Consideration  | "orval alternative"         | 7      | 8   | 7      | 7   | **7.3** |

**The pattern for every searchable spoke:** rank for the _generic_ problem ("retry fetch
in TypeScript"), teach it honestly and completely, _then_ show the one-line StitchAPI way.
The product-framed version already exists in Recipes — these blog spokes are the
keyword-framed front doors that link into them.

## Topic cluster map

```
Pillar 1 — Resilient API calls in TypeScript  (HUB: /docs/guides/resilience/*)
├── retry fetch in TypeScript        → /docs/recipes/make-a-flaky-call-succeed
├── rate-limit / throttle API calls  → /docs/recipes/one-rate-limit-across-workers
├── add a timeout to fetch           → /docs/errors/stitch-timeout
├── circuit breaker in Node          → [blog] circuit-breakers-and-layered-timeouts
└── paginate into one array          → /docs/recipes/paginate-into-one-array

Pillar 2 — Agent-native API access  (HUB: /docs/agents)
├── code mode vs tool calling        → [blog] one-tool-per-endpoint
├── call an API from an MCP agent    → /docs/surfaces/mcp
├── what is MCP / one server vs many → [blog] you-might-not-need-an-mcp-server-per-integration
└── credential-safe agent tools      → [blog] auth-as-a-capability-not-a-credential

Pillar 3 — Typed clients without codegen  (HUB: /docs/concepts/the-stitch)
├── axios alternatives               → [blog] axios-alternatives  ✅ shipped
├── type-safe client w/o OpenAPI     → /docs/guides/validation
├── validate response with Zod       → /docs/guides/validation
├── Hey API / Orval vs stitching     → [blog] stitch-vs-codegen-api-clients
└── what is schema drift             → /docs/errors/stitch-drift

Pillar 4 — One definition, every surface  (HUB: [blog] one-definition-four-front-doors)
└── per-framework use-cases (Express/Hono/Next/React…) → /docs/integrations/*
```

Each blog spoke links **down** into the relevant Recipe/Guide/Error doc, and the doc
links **back up** to the explainer — the interlinking compounds authority.

## Quick wins (priority order)

1. **Axios alternatives** — highest commercial intent; differentiates on zero-deps + the
   "layer above fetch/axios" framing. **Shipped 2026-06-28** (`content/blog/axios-alternatives.mdx`).
2. **"How to retry a failed fetch in TypeScript"** — evergreen, steady volume, near-zero
   research cost (the mechanism already exists in the docs).
3. **Code mode vs tool calling** — rides current MCP search momentum; the project already
   holds the strongest opinion in the space.

These are low-effort/high-return because the engineering content already lives in the
docs — the work is re-framing around the search query.

## Backlog — uncovered angles (added 2026-06-29)

The 2026-06-29 coverage push shipped 15 posts across 5 PRs (#355–#360): the migration
cluster (fetch/axios), the adapter/transport seam, React Query, incremental adoption,
GraphQL, testing with `mockAdapter`, idempotency keys, safe tracing/redaction,
scaffold-from-curl, upload progress, typed errors, edge/Cloudflare, LLM-as-function,
OpenAPI export, non-JSON responses, and `pipe` composition. The angles below are the
remaining gaps — each maps to a shipped feature with no blog post yet. Same pattern as
above: rank for the generic problem, teach it honestly, then show the one-line stitch way.

| Topic (working title)                                       | Pillar | Target query                                          | Maps to (feature)                                                             |
| ----------------------------------------------------------- | ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Session auth that logs itself back in                       | 1      | "refresh token on 401", "session auth fetch"          | `cookieSession` (`refresh`/`loginInput`) + `oauth2`                           |
| Multi-tenant API calls from one definition                  | 4      | "multi-tenant api client"                             | `seam.as(principal)` + `oauth2` `tenancy`, per-tenant credentials             |
| Tap into every request with hooks (interceptor alternative) | 1      | "fetch interceptor alternative", "http middleware ts" | request/response/error/retry `hooks`                                          |
| Use any validator (Standard Schema)                         | 3      | "valibot api validation", "standard schema"           | validator-agnostic core; Zod/Valibot/ArkType/Effect/Typebox via `toValidator` |
| Expose a stitch as an HTTP endpoint                         | 4      | "turn a function into an http endpoint"               | the `serve` surface (`stitchapi/serve`, `stitch serve`)                       |
| Give an agent a stitch as an MCP tool                       | 2      | "build an mcp server typescript"                      | the `mcp` surface (`stitchapi/mcp`, `stitch mcp`)                             |
| Run a stitch from the command line                          | 4      | "call an api from the terminal"                       | the CLI `run` surface                                                         |
| Download a file as a stitch (with progress)                 | 1      | "download file typescript"                            | the `download` surface (Content-Disposition filename + progress)              |
| Visualize your stitches as a diagram                        | 4      | "visualize api calls"                                 | `stitch diagram` / `toMermaid` call graph                                     |

Lower priority / niche (capture only if a search angle emerges): the `shell` surface
(run a command as a stitch), `delegate` backoff and `verdict` as standalone
resilience guides, and typed iframe↔parent RPC (`stitchapi/postmessage`, ADR 0009).

## Notes & guardrails

- **Honesty bar.** Every comparison names where the alternative wins (see the "when a
  fetch wrapper is the right call" section in `axios-alternatives.mdx`). This is what
  makes the posts credible and matches the [EDITORIAL.md](../apps/docs/EDITORIAL.md) standard.
- **No fabricated claims.** Do not assert specific third-party security incidents or
  invented metrics; frame around verifiable properties (dependency tree, transitive
  surface). Same reason the structured data omits fabricated `datePublished` dates.
- **Slugs stay evergreen.** Keep the target keyword in the slug (`axios-alternatives`),
  carry the year in the title only, and refresh content yearly rather than re-slugging.

## References

- TypeScript HTTP-client landscape 2026 — <https://reintech.io/blog/axios-vs-fetch-vs-ky-http-client-comparison-2026>
- Cloudflare, "Code Mode: the better way to use MCP" — <https://blog.cloudflare.com/code-mode/>
- Anthropic, "Code execution with MCP" — <https://www.anthropic.com/engineering/code-execution-with-mcp>
