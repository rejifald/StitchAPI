# StitchAPI — Vision & Overview

> A strategy companion to [`DESIGN.md`](DESIGN.md) (the technical design) and
> [`FEATURE-LENSES.md`](FEATURE-LENSES.md) (the feature map — capabilities grouped by lens).
> This doc captures the **why**: positioning, pain points, competitive landscape,
> differentiation, scope, status, and open questions. Working draft · 2026-06.

---

## 1. What StitchAPI is (the 2026 pivot)

StitchAPI turns any API into a typed, resilient function — what we call **API stitching**. Its
core primitive, a _stitch_, takes a single endpoint and hands back a callable; `fetch`/axios are
pluggable adapters underneath, not something it replaces. It is agent-native by the same move:
the callable a human imports is the one an agent invokes — getting a capability, not a credential.

A **stitch** is a typed, declarative, composable unit: `input → validated output`, wrapped with
auth, retries, throttling, timeouts, lifecycle hooks, and observability. The primitive is
**kind-agnostic** — HTTP and GraphQL over the wire, plus shell and LLM as symmetric non-HTTP
surfaces (ADR 0008) — and stitches compose into bigger stitches, including across kinds via
`pipe()`.

Two market quadrants are empty, and StitchAPI targets both:

-   **Spec-less long tail** — every serious competitor needs an OpenAPI spec. A stitch needs one
    endpoint or one example.
-   **Heterogeneous + agent-native** — no lightweight library treats HTTP/GraphQL/shell/LLM as
    symmetric, declared, agent-consumable primitives.

---

## 2. "Agent-friendly," defined — and why raw bytes are the wrong result

"Agent-friendly" is **not** "ship an MCP server." It means agents are **first-class users**: they
invoke a stitch directly — without booting the whole app — and get a structured, validated,
observable, frugal, streamable, composable result. One definition is callable four ways:
**in-process function · CLI · HTTP · MCP tool**, and the caller gets a **capability, not a
credential**.

`fetch` was built for a browser rendering a page, not a model reasoning over results:

| `fetch` gives the agent…                           | …but the agent needs                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| Opaque bytes — the **whole body lands in context** | Frugal, model-ready results (field-select / summarize / return a handle) |
| No output contract                                 | Schema-validated results + re-prompt on mismatch                         |
| One failure, then it gives up                      | Retries w/ backoff + jitter, `Retry-After`, idempotency                  |
| One coarse timeout                                 | Layered total/step/chunk timeouts + `AbortSignal`                        |
| A raw byte stream                                  | SSE framing, delta concatenation, progress tokens, resumability          |
| Blocks until one response                          | Progress, partial results, human-in-the-loop                             |
| Zero traces                                        | `gen_ai.*` / `mcp.*` spans: tokens, cost, latency                        |

**The answer:** a stitch returns an **async iterable of typed events** (`start → progress → drift
→ result → done`), not `Promise<bytes>`. One shape generalizes HTTP progress/pagination _and_
(future) LLM token streaming — "more direct streaming than fetch."

---

## 3. The problem: pain points it targets

**Integrating one third-party API:**

-   **Silent breaking changes / schema drift (top):** a vendor renames or restructures a field with
    no version bump; health checks stay `200 OK` while consumers parse garbage for hours. Types are
    compile-time only — drift surfaces as a downstream `undefined`.
-   **Third-party observability (top):** you can't instrument inside a vendor. "The API is up but
    not working correctly."
-   **Reliability:** rate limits/quotas, latency spikes, flaky partial outages → backoff+jitter,
    `Retry-After`, idempotency, circuit breaking.
-   **Auth lifecycle:** token-refresh races, key rotation, cookie jars, soft (200-but-login-page)
    walls.
-   **Data shape:** pagination drift, inconsistent nulls, timezone/error-shape chaos.

**Composing several heterogeneous sources:** there is no uniform primitive across
HTTP/GraphQL/shell/LLM — each lives in a different tool, glued with bespoke code. The failures
live in the **seams**: passing typed data between steps, partial failure mid-chain, and one trace
across the whole chain.

**The payoff that ties it together:** because every stitch validates responses and emits an event
stream by default, StitchAPI detects **schema drift at runtime** _and_ measures **third-party
health** as a byproduct — the agent-native layer is also the integration-reliability layer.

---

## 4. Competitive landscape

**Named competitors**

-   **Massimo** (`massimohttp.dev`, Platformatic) — OpenAPI/GraphQL → typed TS client, dual
    undici+fetch runtime. **Spec-required**, no agent features.
-   **Requestly** — open-source HTTP interceptor + mocking + privacy-first API client (a Postman
    alternative). A developer/QA **tool**, not a client-library runtime.

**Closest competitor: Windmill (~85%)** — a git-backed platform where Bash/SQL/GraphQL are
first-class script kinds that compose into flows, each auto-exposed as REST/webhook/UI/CLI/MCP.
But it's a **heavy server platform**, and HTTP/LLM are "just code," not symmetric declared
primitives. Our wedge: **library, not platform** + symmetric kinds incl. LLM + agent-native
consumption.

**The field**

| Category                                | Players                                                                                       | Needs a spec? | Agent-ready?    |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | --------------- |
| Spec-based codegen                      | openapi-generator, Orval, Kubb, @hey-api/openapi-ts, openapi-fetch, oazapfts, Kiota           | ✅            | ❌              |
| Commercial SDK-as-a-service             | Speakeasy, Fern (→Postman), **Stainless (→Anthropic, winding down hosted)**, liblab, APIMatic | ✅            | ✅ (MCP gen)    |
| Runtime / contract clients (our family) | Zodios, ts-rest, Effect Platform, Feathers                                                    | ❌            | ❌              |
| Spec-less / inferred                    | OpenAPI DevTools, Optic, mitmproxy2swagger, reverse-api-engineer                              | produces one  | ⚠️ experimental |

**Agentic API tooling:** MCP is the dominant interface, but a **tool-overload backlash** is on
(naive MCP setups eat up to ~72% of context; tool-selection accuracy collapses). The industry
answer — Anthropic's Tool Search + **code-execution-with-MCP** — is to let the model write code
against tools on demand. Integration platforms (Composio, Arcade, Pipedream, Nango) handle auth
but don't give you a typed, resilient _library_.

**The empty quadrant: spec-less + agent-native.** That's the opening.

---

## 5. Where we win (differentiation)

1. **No spec required** — work from one endpoint or one example (curl/HAR/doc snippet).
2. **Agent-authorable** — the unit is a tiny `stitch({...})` an LLM can emit from one example; the
   library is the durable value, the agent writes thin declarations.
3. **Resilience built in** — retries/backoff/`Retry-After`, throttle, timeouts, pagination — not
   hand-rolled per integration.
4. **Auth-as-boundary** — the stitch holds the credential; the agent gets a capability, never the
   secret. (Security win and a capability win.)
5. **Context-frugal code-mode surface** — one `stitch` tool the agent drives in a sandbox, not
   one-tool-per-endpoint.
6. **Schema-flexible** — Standard Schema (Zod / Valibot / ArkType), not Zod-locked.
7. **Spec-optional & reversible** — ingest a spec when one exists; emit one from accumulated
   stitches when it doesn't.

---

## 6. The runtime: feature set

The v1 runtime (in `src/`, **zero runtime dependencies**):

-   **Primitive + composition** — `stitch()` with two interchangeable facades (`extends` /
    fluent builder) over one engine, plus `.with()` partial application; `seam` owns the
    fragment + shared runtime for a whole surface.
-   **Event-stream return** (`start → progress → drift → result → done`) + an `await` convenience.
-   **Flexible validation** (Zod _and_ Standard Schema) + **leveled drift** — schema-anchored, no
    snapshot: a required field missing/incompatible throws, soft drift (coerced/undeclared/defaulted)
    is non-fatal `warn`/`info`/`verbose` (ADR 0015).
-   **Resilience** — retry (backoff, `Retry-After`), throttle (rate + concurrency), timeout (abort).
-   **Auth-as-boundary** — bearer / apiKey / basic / cookieSession (auto-login, refresh-on-status,
    content-aware refresh) and **OAuth2 client_credentials** (token endpoint, cached access token,
    single-flight refresh).
-   **Pluggable state store** — in-memory default; a shared store makes throttle **distributed** and
    sessions **persistent/shared across workers** (the two "critical" gaps closed by one seam).
-   **Body encoding** (json/form/multipart), **GraphQL kind**, **static headers**, **transform**
    (e.g. scrape HTML → structured), **pagination** (auto-loop, aggregate).
-   **Zero-infra observability** — off by default; opt into the console stream, a JSONL file, or OTLP export with one flag (no side effects by default).

**Four surfaces from one definition:** in-process function · CLI (`stitch run`/`trace`) · HTTP
serve · MCP.

> For the complete feature inventory grouped by lens (runtime · authoring · data · reach) and
> mapped to source modules, see [`FEATURE-LENSES.md`](FEATURE-LENSES.md).

---

## 7. Coverage & scope — validated against two real apps

Audited end-to-end against two production apps (an auth-gated SaaS; a multi-provider aggregator).
A stitch is a **per-call primitive**, so coverage splits three ways:

-   **Covered** — auth header injection, cookie login + re-login, content-aware refresh, retry +
    `Retry-After`, throttle, timeout, form/multipart, validation + leveled drift, HTML-scrape
    transform, GraphQL, static headers, pagination, **distributed throttle + shared sessions** (via
    the store).
-   **Also shipped since this audit** — OAuth2 client_credentials, multi-cookie jar, binary/blob
    responses, circuit breaker, idempotency keys, OTLP export.
-   **Out of scope** — job queues, inbound webhooks, business/DB idempotency, multi-step
    rollback/compensation, app-level cache policy, broad fan-out orchestration. **A stitch is not a
    workflow/iPaaS engine** — absorbing these is how it would become the heavy platform it's
    positioned against.

**Verdict:** covers ~80–90% of what both apps reinvent at the integration layer, with a bounded,
mostly-additive list for the rest.

---

## 8. Principles & key decisions

**Principles:** progressive disclosure (zero-config to start, opt-in depth) · atomic stitches (no
global config) · composition over configuration · the stitch is the boundary · one definition,
many surfaces · the event stream is the spine · kind-agnostic core · browser-first (runs wherever
`fetch` does) · pay only for what you import (subpath exports, enforced tree-shaking) · contract,
not dependency (core ships seams + conformance kits; vendors live in peer-dep packages) ·
no side effects by default (state is in-memory and process-local; persistence, sharing, and
tracing are opt-in) · declarative spelling (every capability round-trips as JSON; functions
are sugar).

**Locked decisions:** library-first; HTTP-only but kind-abstraction-ready; event-stream return is
core; throttle and leveled drift are defaults, while observability and persistence are **off until
opted in**; state lives behind a **pluggable store**; validation is **Standard-Schema flexible** (Zod stays first-class);
third-party **service names stay out of public artifacts** (neutral archetypes).

---

## 9. Status — what's built

The core library is **feature-complete** and packaged as `stitchapi` (`1.0.0-rc.1` — the first
v1.0 release candidate, zero runtime deps). Full gate green — eslint, prettier, `tsc`, `attw`,
**581 tests / 71 suites**, `tsup` ESM+CJS+DTS build — and verified against synthetic scenarios
**and** two real apps' integration patterns.

-   **Primitive + composition** — `stitch()` (`extends` + fluent builder facades), `seam` with
    principal-scoped auth (ADR 0002), `.with()` partial application, deep fragment composition +
    hook chaining.
-   **Engine** — RFC 6570 Level-4 templates, nested query encoding, transform/unwrap, pagination;
    Zod **and** Standard Schema validation with schema-anchored leveled drift (ADR 0015).
-   **End-to-end type inference** — `Stitch<T>` inferred from the `output` schema **and** call
    arguments inferred from `config.input`, including graphql `variables`, path literals, and
    `extends`/compose typing (all now supported).
-   **Resilience** — retry (backoff modes, `Retry-After`), throttle (rate + concurrency, per-stitch
    **and** in-process host pooling), per-attempt **and** total timeout, store-backed circuit breaker.
-   **Auth-as-boundary** — bearer / apiKey / basic / cookieSession / **OAuth2 client_credentials**,
    call-time secret resolution, single-flight token refresh.
-   **Response cache** — derived-key cache + in-process request coalescing (ADR 0003 v1).
-   **Response streaming** — the fetch adapter exposes the live `ReadableStream`; the engine emits
    a `delta` per chunk with per-delta `output` validation; `sse()` / `stream()` surfaces frame and
    decode; `stitch serve` forwards deltas over SSE. (The `xhr` / `axios` adapters reject streaming
    by design.) Includes unframed structural `decode: 'json'`, the streamed `delta` element type
    inferred from `output`, and resumable SSE (`Last-Event-ID` reconnect with server-`retry`
    backoff).
-   **Non-HTTP surfaces** — `llm` and `shell` as symmetric kinds, plus `pipe()` to compose
    heterogeneous stitches with one causal trace across the chain (ADR 0008).
-   **Composition causality** — a run-identity OTLP span tree (`spanId` / `traceId` / `parentSpanId`):
    retries and pages are child spans with their own latency/outcome (ADR 0007).
-   **Observability** — console / JSONL / OTLP, secret redaction, **off by default**.
-   **Four surfaces, one definition** — in-process function · CLI (`stitch run`/`trace`/`export`/`diagram`) ·
    HTTP serve (+SSE) · MCP stdio, over a shared registry. Subpath exports for `serve` / `mcp` /
    `registry` / `testing` / `cache`.
-   **State + testing** — `memoryStore` + pluggable store seam (+ a Redis-backed store in
    `@stitchapi/redis`); store / adapter / sink **conformance kit**.
-   **Playground** — Node sandbox engine complete and green; the real-browser runner and
    real-run-trace → Mermaid DAG have shipped. The remaining Launch item is the **real-browser
    Playwright proof** of the worker's security behaviors (already covered by Node unit tests).
-   **Branch workflow:** feature branches → PR → **`main`** (the `develop` integration branch was
    retired).

---

## 10. Roadmap

The current target is **the Launch (v1.0)** — production-ready library **plus** the interactive
playground + docs site as one public moment. See [`RELEASE.md`](RELEASE.md) for the live checklist.

1. **The Launch (v1.0):** the last item is the playground's real-browser **Playwright proof** of
   the worker security behaviors (already green in Node unit tests). Core response streaming,
   the real-Worker trace → Mermaid DAG, the sandbox CI wiring, and release hygiene (CHANGELOG,
   runnable `examples/`, READMEs) have all landed.
2. **v1.1:** agent-grade MCP (per-stitch schemas, structured results, drift-in-error, progress) ·
   published record/replay mock adapter · pagination presets.
3. **Visual:** live trace overlay on the playground DAG (the `stitch diagram` Mermaid-from-definition
   exporter has shipped).

**Shipped since this roadmap was written:** non-HTTP `shell` / `llm` kinds + `pipe()` composition
(ADR 0008) · composition causality / run-identity span tree (ADR 0007) · ADR 0004 Standard-Schema
fingerprint folded into cache generation · companion packages — `@stitchapi/redis` (store),
`@stitchapi/nest` / `@stitchapi/fastify` / `@stitchapi/hono` (server bindings),
`@stitchapi/react` + `@stitchapi/query-core` (frontend hooks), `@stitchapi/pino` (trace sink) ·
`stitch export --openapi` · streaming polish (unframed `decode: 'json'`, typed `delta` arrays,
resumable SSE / `Last-Event-ID`).

---

## 11. Risks & open questions

-   **The moat.** If an LLM can write `fetch()`, why StitchAPI? Only valid answer: the **runtime**
    (retries/auth/pagination/validation/observability) is genuinely better than hand-rolled. If the
    runtime is mediocre, this collapses into "just write fetch." Everything rides on runtime quality.
-   **Scope creep → iPaaS.** "Stitch anything" wants to become Windmill/n8n. Hold the line: primitive
    -   library, composition is code, never a visual builder.
-   **Crowded runtime-client space.** Zodios/ts-rest/Effect own "typed client in TS." We must win on
    _spec-less + agent-native_, relentlessly — not "another typed client."
-   **Partial knowledge.** Spec-less means you discover an API endpoint-by-endpoint; frame it as
    _just-in-time_, not a comprehensive SDK.
-   **The LLM kind invites "is this LangChain/Mastra?"** Differentiate: uniform across LLM and
    non-LLM, mission is third-party reliability + agent consumption, not agent orchestration.
-   **Surface-area sequencing.** Four surfaces × N kinds × streaming × observability is a lot for a
    small lib; sequence it (it's why HTTP shipped first, abstraction-ready).

---

## 12. Target users & why now

**Users:** TypeScript/JS developers integrating undocumented or no-SDK third-party APIs; teams
building agents that must call real APIs reliably; anyone hand-rolling a `src/api/` folder of
fetch wrappers with bespoke auth/retry/rate-limit.

**Why now:** the agent era makes a resilient, typed, _agent-consumable_ integration primitive
valuable; the best spec-based generator (Stainless) was **acquired by Anthropic and is winding
down hosted products**, validating the space and opening room; MCP + code-execution is the
industry direction; and tool-overload pain is pushing toward exactly the context-frugal code-mode
surface a stitch provides.

---

## 13. How we'll know it works (success criteria)

-   One stitch replaces a provider's hand-rolled auth + retry + rate-limit + session code — proven
    on both dogfood apps.
-   An agent gets past a real **auth wall** (a cookie-walled endpoint) and returns data **without
    ever seeing the secret**.
-   **Drift catches a silent breaking change** (a markup/field rename) as a loud, leveled signal
    instead of a downstream `undefined`.
-   A **shared store** makes two workers share one login and one rate budget — distributed
    rate-limiting and persistent sessions become a config choice, not an architecture project.

---

_See [`DESIGN.md`](DESIGN.md) for the API design, composition model, and the §12 coverage matrix /
§13 store seam this overview summarizes._
