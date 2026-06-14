# StitchAPI — Release plan: **the Launch (v1.0)**

> Working checklist for the first public release. Companion to
> [`OVERVIEW.md`](OVERVIEW.md) §9 (status) and §10 (roadmap). Update the
> checkboxes as items land; this file is the single source of truth for "what's
> left."

## The bar

**One public moment:** ship `stitchapi` **v1.0** as a production-ready library
**and** launch the interactive playground + docs site together. The library is
the product and is already feature-complete; the playground's real-browser
wiring and core response-streaming are the load-bearing remainder.

Decision: the playground is **not** decoupled into a later release — it ships
with v1.0. (Bar chosen 2026-06-14.)

Legend: `[x]` done · `[ ]` outstanding · 🔴 critical path · 🟡 parallel.

---

## ✅ Done — ships as-is (no code work)

The entire core library (`stitchapi`, currently `0.7.0`), verified against
`src/` + `test/` (29 spec files / 211 tests green):

-   [x] Authoring — `stitch()`, `seam()`, `graphql()`, fluent builder, `.with()`,
        `extends` composition + hook chaining
-   [x] Engine — RFC 6570 Level-4 templates, nested query encoding, transform /
        unwrap, pagination
-   [x] Validation — Zod + Standard Schema, leveled drift, drift snapshots
-   [x] Type inference — output type **and** call-argument type from the contract
        (graphql-variables typing + extends/compose typing deferred, by design)
-   [x] Resilience — retry/backoff modes, `Retry-After`, per-attempt **and** total
        timeout, throttle (per-stitch + in-process host pooling), circuit breaker
-   [x] Auth — bearer / apiKey / basic / oauth2 / cookieSession, call-time secret
        resolution, single-flight token refresh
-   [x] Transports — fetch + axios adapters
-   [x] Tracing — console / JSONL / OTLP, secret redaction, **off by default**
-   [x] Surfaces — CLI (`run`/`trace`), HTTP serve (+SSE), MCP stdio
-   [x] Store — `memoryStore` + pluggable store seam + conformance kit
-   [x] Cache — derived-key response cache + in-process coalescing (ADR 0003 v1,
        42 tests green)
-   [x] Testing kit — store / adapter / sink conformance contracts
-   [x] Playground **Node engine** — sandbox-sim + browser runner + worker entry
        complete and green (manual `docs/sandbox/tests/run-all.mjs`)

---

## 🔧 In progress — required to clear the v1.0 bar

### A. Playground browser Phase-2 🔴 (schedule risk — the browser model is unproven)

-   [x] **CSP headers** in [`apps/docs/next.config.mjs`](../apps/docs/next.config.mjs)
        — `connect-src 'self'` egress backstop, `worker-src 'self' blob:`, eval
        confined to the worker via a per-route policy on `/sandbox/*`. Lives in
        [`apps/docs/lib/security-headers.mjs`](../apps/docs/lib/security-headers.mjs);
        served headers verified, egress block proven in a real browser.
-   [ ] **Populate `RunResult.trace` from the real Worker** — emit
        `StitchTraceEntry` chunks from `stitch-browser.ts` so the Mermaid DAG
        renders from real runs, not test fixtures
-   [ ] **Playwright harness** ([`apps/docs/e2e/`](../apps/docs/e2e/)) — egress
        confinement + CSP enforcement (SEC-10..13) **proven** (4/4 green). Broaden
        to SEC-04 (non-HTTP egress), Worker isolation / no state-bleed (SEC-36/37),
        and preemptive timeout/kill (SEC-20..22).
-   [ ] **Wire sandbox-sim suites into CI** — add `test` scripts so `pnpm -r test`
        covers them (today only a manual runner)

### B. Core response streaming 🔴 (gates the live-token-stream demo)

-   [ ] **`responseType: 'stream'` + emit `delta` for real** in
        [`packages/core/src/http-adapter.ts`](../packages/core/src/http-adapter.ts)
        — both adapters buffer fully today; `serve.ts` forwards deltas for free
        once the engine emits them
-   [ ] _Scope lever:_ if streaming slips, the playground can launch showing
        complete responses and live streaming becomes a fast-follow. Decoupling it
        de-risks the date.

### C. Release hygiene 🟡 (~1 day, parallel to A/B)

-   [x] Rewrite [`OVERVIEW.md`](OVERVIEW.md) §9–10 (was stale: `develop` branch,
        "OAuth2 in progress", "42 tests")
-   [ ] Add a `CHANGELOG.md` (none exists)
-   [ ] Flip [`README.md`](../README.md) off "not recommended for production"
-   [ ] Commit a runnable `examples/` demo (git-tracked `examples/` is empty)
-   [ ] Doc reconciliations: `delta` becomes a live event (drop the
        "reserved" framing); reconcile the cache bypass-event taxonomy
        (impl emits `progress`, ADR 0003 §3 says `warning`)

---

## 🔜 Next release (v1.1) — safe to defer past the Launch

-   [ ] Agent-grade MCP — per-stitch JSON Schemas, structured results,
        drift-in-error payloads, progress notifications
-   [ ] ADR 0004 Standard-Schema fingerprint (PR #81) → fold into cache generation
        for zero-revalidation (cache is already sound via the v1 fallback ladder)
-   [ ] `@stitchapi/redis-store` — makes "two workers share one login + rate
        budget" demonstrable out of the box
-   [ ] Published record/replay mock adapter
-   [ ] `stitch export --openapi`
-   [ ] Pagination presets (`cursor()` / `offset()` / `linkHeader()`) + async
        iterators

---

## Go / no-go gate

Launch is **go** when, in a real browser via the Playwright harness:

1. The playground loads and runs a snippet against the sandbox.
2. An attempted **external-origin fetch from inside the sandbox is blocked**
   (egress confinement holds with the shim _and_ the CSP backstop).
3. The Mermaid DAG renders from a **real** run's trace.
4. (If streaming is in-scope) tokens render incrementally from an SSE stitch.

## Sequencing

Start **A1–A3** (browser security spike) first — it is the load-bearing unknown;
if Worker isolation / CSP doesn't hold in a real browser it reshapes everything.
Run **C** (hygiene) and **B** (streaming) in parallel; both are well-understood.
