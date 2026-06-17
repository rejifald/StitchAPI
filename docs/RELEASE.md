# StitchAPI — Release plan: **the Launch (v1.0)**

> Working checklist for the first public release. Companion to
> [`OVERVIEW.md`](OVERVIEW.md) §9 (status) and §10 (roadmap). Update the
> checkboxes as items land; this file is the single source of truth for "what's
> left."
>
> For the standing, repeatable publish runbook (how to cut _any_ release), see
> [`RELEASING.md`](RELEASING.md).

## The bar

**One public moment:** ship `stitchapi` **v1.0** as a production-ready library
**and** launch the interactive playground + docs site together. The library is
the product and is feature-complete — core response streaming has landed (the
engine emits live `delta`s with per-chunk validation), and the playground's
real-browser security **proof** is green (#168). The first publish is
**`1.0.0-rc.1`** under the npm `rc` dist-tag — `latest` stays on `0.7.0` until the
RC soak promotes it to `1.0.0`.

Decision: the playground is **not** decoupled into a later release — it ships
with v1.0. (Bar chosen 2026-06-14.)

Legend: `[x]` done · `[ ]` outstanding · 🔴 critical path · 🟡 parallel.

---

## ✅ Done — ships as-is (no code work)

The entire core library (`stitchapi`, currently `1.0.0-rc.1`), verified against
`src/` + `test/` (71 spec files / 581 tests green):

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
-   [x] **Populate `RunResult.trace` from the real Worker** — a traced `stitch`
        ([`docs/sandbox/runtime/trace-collector.ts`](../docs/sandbox/runtime/trace-collector.ts))
        injects a core trace sink per call and emits `StitchTraceEntry`s through
        the worker progress relay → `ResultMessage.trace` → `RunResult.trace`, so
        the Mermaid DAG renders from real runs. Proven end-to-end in a real
        browser ([`e2e/sandbox-trace.spec.ts`](../apps/docs/e2e/sandbox-trace.spec.ts)) + unit ([`trace-collector.test.ts`](../docs/sandbox/runtime/trace-collector.test.ts)).
        Follow-ups: dependency EDGES (`dependsOn`, needs the composition graph)
        and `seam`-created stitches.
-   [x] **Playwright harness — landed (#168).** The remaining security _behaviors_
        now have real-browser (Chromium) proof: non-HTTP egress shims (SEC-04),
        fresh-worker isolation / no state-bleed (SEC-36/37), and preemptive
        timeout/kill (SEC-20..22), on top of the egress confinement + CSP
        enforcement (SEC-10..13) that was already green. **11/11 e2e specs green**
        in [`apps/docs/e2e/`](../apps/docs/e2e/).
-   [x] **Wire sandbox-sim suites into CI** — `packages/sandbox-sim` now has a
        `test` script (the five `*.test.ts` `tsx` scripts), so `pnpm -r test`
        covers them; the `@stitchapi/sandbox` smoke job in
        [`verify.yml`](../.github/workflows/verify.yml) continues to gate the
        browser/server runner separately.

### B. Core response streaming ✅ — shipped

-   [x] **Live `delta` stream, end to end.** The fetch adapter hands back the live
        `ReadableStream` unbuffered when a stream is requested
        ([`packages/core/src/http-adapter.ts`](../packages/core/src/http-adapter.ts));
        the engine's `runStreaming` path emits a `delta` event per chunk and runs
        per-delta `output` validation via the surface's `contractValue` hook; the
        `sse()` and `stream()` surfaces ([`sse.ts`](../packages/core/src/sse.ts) +
        [`stream.ts`](../packages/core/src/stream.ts)) frame and decode the body;
        and `serve.ts` forwards each `delta` over SSE. The `xhr` and `axios`
        adapters **reject** streaming by design (neither exposes an incremental
        body). **57 streaming tests green.**
-   Follow-ups (all non-blocking; see the v1.1 list below): unframed
    `decode: 'json'` ([#111](https://github.com/rejifald/StitchAPI/issues/111)),
    compile-time typed `delta` arrays
    ([#115](https://github.com/rejifald/StitchAPI/issues/115)), and SSE
    reconnection / `Last-Event-ID`
    ([#71](https://github.com/rejifald/StitchAPI/issues/71)).

### C. Release hygiene 🟡 (~1 day, parallel to A/B)

-   [x] Rewrite [`OVERVIEW.md`](OVERVIEW.md) §9–10 (was stale: `develop` branch,
        "OAuth2 in progress", "42 tests")
-   [x] Add a `CHANGELOG.md` (Keep-a-Changelog, reconstructed from git + the ADRs)
-   [x] Flip [`README.md`](../README.md) and [`packages/core/README.md`](../packages/core/README.md)
        off "not recommended for production" → an honest release-candidate
        (`1.0.0-rc.1`) framing (feature-complete and in real use; not yet
        stamped stable 1.0)
-   [x] Commit a runnable `examples/` demo (git-tracked `examples/` was empty) —
        a deterministic, offline typed `stitch` with an `output` schema, run
        against an injected mock adapter ([`examples/`](../examples/))
-   [x] Doc reconciliations: `delta` is a live event (the "reserved" framing is
        gone); the cache bypass-event taxonomy now matches the impl — an
        uncacheable call emits a `progress` event with `phase: 'cache'` and a
        `bypass: …` detail (ADR 0003 §3 corrected: `warning` was never a member
        of the `StitchEvent` union)

---

## 🔜 Next release (v1.1) — safe to defer past the Launch

-   [ ] Agent-grade MCP — per-stitch JSON Schemas, structured results,
        drift-in-error payloads, progress notifications
-   [ ] Published record/replay mock adapter
-   [ ] Pagination presets (`cursor()` / `offset()` / `linkHeader()`) + async
        iterators
-   [ ] Streaming polish (all non-blocking, deferred from §B): unframed
        `decode: 'json'` ([#111](https://github.com/rejifald/StitchAPI/issues/111)),
        compile-time typed `delta` arrays
        ([#115](https://github.com/rejifald/StitchAPI/issues/115)), SSE
        reconnection / `Last-Event-ID`
        ([#71](https://github.com/rejifald/StitchAPI/issues/71))

**Already shipped (was listed here):**

-   [x] **ADR 0004 Standard-Schema fingerprint** (PR #81) — **folded into cache
        generation** (PR #85), so a sound vendor fingerprint skips revalidation.
-   [x] **`@stitchapi/redis`** — the package exists ([`packages/redis/`](../packages/redis/)):
        a Redis-backed `StitchStore` (`get`/`set`/`incr`/`close`) with
        `fromIoredis` + `fromNodeRedis` driver adapters, passing
        `verifyStoreContract` against a hermetic in-repo Redis engine. Makes "two
        workers share one login + rate budget" work out of the box. Not yet
        published to npm (version `0.0.0`).
-   [x] **`stitch export --openapi`** — `toOpenApi` + the `export` CLI subcommand
        ship in core (paths/methods, RFC 6570 path & query params, body/response
        presence, plus real body schemas via a BYO `toJsonSchema` converter).

---

## Go / no-go gate

Launch is **go** when, in a real browser via the Playwright harness:

1. The playground loads and runs a snippet against the sandbox.
2. An attempted **external-origin fetch from inside the sandbox is blocked**
   (egress confinement holds with the shim _and_ the CSP backstop).
3. The Mermaid DAG renders from a **real** run's trace.
4. Tokens render incrementally from an SSE stitch (streaming has shipped in core;
   this is the playground wiring proof).

## Sequencing

All gate items are green: the browser security **proof** (Section A) landed in #168
(11/11 e2e specs), and core streaming (former Section B) and hygiene (Section C) are
done. What remains is mechanical — tag `v1.0.0-rc.1` and publish the workspace under
the `rc` dist-tag, guarded by `pnpm check:release`.
