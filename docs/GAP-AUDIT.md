<!-- Generated 2026-06-12 by a multi-agent gap audit (47 findings, each adversarially
     verified against the code). Untracked on purpose — commit or delete as you see fit. -->

# StitchAPI — Functionality Gap Audit: Synthesis & Recommendations

All paths are relative to `/Users/rejifald/Development/StitchAPI`.

## State of the project

The core library (`packages/core`, published as `stitchapi` v0.7.0, zero runtime deps) is broad and mostly genuinely implemented: a full authoring layer (`stitch()`, `defineStitch`, `preset`, `graphql`, fluent builder, `.with()`, deep fragment composition with hook chaining); an engine with RFC 6570 Level-4 templates and qs-style nested queries; Zod/Standard Schema validation folded into leveled drift detection with snapshots; transform/unwrap, pagination, idempotency keys; resilience (retry/backoff, Retry-After, per-attempt timeouts, throttles, store-backed circuit breaker); five auth strategies with call-time secret resolution; pluggable transports (fetch + axios); console/JSONL/OTLP tracing; and three front doors (CLI, HTTP serve with SSE, MCP stdio) over a shared registry. 132 behavioral vitest tests pass, asserting wire-level effects against a real mock server. The gaps below are therefore mostly edges — but several are places where shipped documentation promises behavior the runtime does not deliver, which is the first thing to fix for a project whose pitch is trustworthy contracts.

---

## 1. Documented or promised but missing

These break user trust: the docs state behavior the code does not have.

### 1.1 `timeout.total` is not a total deadline — and is dead config in the documented example

The docs promise a hard cross-retry budget ("`total` caps the sum of all tries plus their backoff waits"), but `engine.ts:270-272` computes `perAttemptMs = perAttempt ?? total`: `total` is only a per-attempt fallback, and when both knobs are set (the docs' own examples) `total` is read nowhere at all. There is no cumulative deadline anywhere — backoff sleeps (`engine.ts:318,356`), throttle waits, and pagination loops are unbounded, so `retry.attempts: 5` + `total: '30s'` can run for minutes; the only test (`packages/core/test/resilience.spec.ts:146-160`) is single-attempt, where the two semantics are indistinguishable.
**Build:** a wall-clock deadline in `execute()`/`attemptLoop` (clamp each attempt's signal to `min(perAttempt, remaining)`, count backoff/throttle waits, also cover `paginated()` and `executeRaw()`), plus specs pinning both knobs. The docs already define the desired semantics, so implement rather than rewrite.
**Evidence:** `packages/core/src/engine.ts:270-272`, `packages/core/src/resilience.ts:124-146`, `apps/docs/content/docs/guides/resilience/timeout.mdx:22-39`, `apps/docs/content/docs/errors/stitch-timeout.mdx:8-50`, `packages/core/README.md:336`.
**Fixed** (2026-08-04). `totalBudget()` arms a wall-clock deadline threaded through the backoff sleeps, throttle waits and pagination loops, and each attempt is clamped to `min(each, remaining)` — a `min` of two independent budgets, not the `??` fallback described above. Pinned by `packages/core/test/gaps/timeout-total.spec.ts` (5 tests, including both knobs set together and a throttle wait counting against `total`). The per-attempt field is spelled **`each`** as of the same date; the `perAttempt` above is the pre-rename code this audit was written against.

### 1.2 `toValidator()` plain-predicate support throws at runtime

Four doc pages plus the file's own header promise predicate coercion, and `reference/helpers.mdx` ships a copy-paste example — `toValidator((v) => typeof v === 'string')` — that throws `'Unsupported schema passed to toValidator()'` (empirically verified against the built lib). The published typing (`schema: unknown`) gives no compile-time warning either.
**Build:** the ~8-line predicate branch (wrap `(v) => boolean` as a Validator with one generic issue), improve the throw message to name what was received, and add a spec for the unsupported path.
**Evidence:** `packages/core/src/validator.ts:1-2,77`; `apps/docs/content/docs/reference/helpers.mdx:108-119`, `guides/validation/validation.mdx:44`, `guides/validation/standard-schema.mdx:8,34`, `errors/stitch-validation.mdx:58`.

### 1.3 `delta` documented as one of "the seven variants" but never emitted

`events.mdx` lists `delta` on equal footing with the six live events, but it exists only as a type declaration (`types.ts:141`) and a trace-formatting comment (`trace.ts:61`); both adapters fully buffer bodies, so no code path can produce a chunk. Users writing sinks that branch on `delta` get dead code.
**Build:** until streaming lands (see §2.2), add a one-line "reserved, not yet emitted" callout to `events.mdx`.
**Evidence:** `apps/docs/content/docs/reference/events.mdx:22-34`, `packages/core/src/types.ts:141`, `packages/core/src/http-adapter.ts:51-77`.

### 1.4 `throttle scope:'host'` does not pool across stitches as documented

`throttle.mdx` claims "'host' pools the budget across every stitch hitting the same host" and that "throttle state lives in the stitch store." Reality: without a configured store, each stitch instance gets its own closure-local throttle map — `scope` only changes the key inside that private map — and the test suite pins this ("default (separate) stores do NOT share the rate budget"). The sibling `distributed-throttle.mdx` page is accurate (modulo saying "per process" where it's per instance), so the docs contradict each other.
**Build:** correct `throttle.mdx` to require a shared store for pooling and add the store to the example (or move in-memory throttle state to a module-level registry for genuine in-process pooling).
**Evidence:** `apps/docs/content/docs/guides/resilience/throttle.mdx:18,33-38`, `packages/core/src/stitch.ts:184-189`, `packages/core/src/resilience.ts:64`, `packages/core/test/store.spec.ts:170-188`, `guides/state/distributed-throttle.mdx`.

### 1.5 "Runs anywhere fetch does" vs a Node-coupled hot path and always-on file tracing

`installation.mdx` promises Node/browser/edge, but the published bundle has bare `node:crypto`/`node:fs` imports on the stitch path (`engine.ts:40`, `trace.ts:5-6`, `otlp.ts:7`, plus `auth.ts`/`drift.ts`), `getTrace()` reads `process.env` on every `makeStitch()` (`stitch.ts:128-137,190`), and the package has no browser export condition. The sandbox B1 spike had to shim all of this downstream (`docs/sandbox/runtime/build-sandbox-worker.mjs:93-100`); nothing was upstreamed.
**Build:** `globalThis.crypto.randomUUID` with fallback, guarded env reads, lazy/no-op fs in the trace sink, and a real off switch — note any fix must cover `otlp.ts` too, not just `engine.ts`/`trace.ts`.
**Evidence:** `apps/docs/content/docs/getting-started/installation.mdx:7-8`, `docs/FEATURE-LENSES.md:124-126`, `docs/sandbox/B1-SPIKE.md`, `packages/core/lib/index.mjs` (retained bare imports).

### 1.6 GraphQL "errors[] fails the call" silently skips the paginated path

Both GraphQL doc pages state the guarantee unconditionally, but the check lives only in the non-paginated branch (`engine.ts:570-585`); `paginated()` never inspects per-page bodies, so with the default `unwrap:'data'` a failed page silently truncates or pollutes the aggregate — exactly the silent failure the feature exists to prevent. No test covers graphql + paginate.
**Build:** hoist the errors[] check into the per-page pipeline and add a paginated-GraphQL-error spec.
**Evidence:** `packages/core/src/engine.ts:432-520,539-542,570-585`, `apps/docs/content/docs/errors/stitch-graphql.mdx:39-41`, `guides/data/graphql.mdx`.

### 1.7 Two copy-paste doc examples are wrong

(a) `surfaces/mcp.mdx:23-28` shows a `run_stitch` call with no stitch `name` in the tool arguments; `mcp.ts:106-108` hard-requires it, so the example errors. Fix to the nested form already shown in `agents/run-stitch-tool.mdx:26`. (b) `errors/stitch-graphql.mdx:24` passes variables as `body: { variables: {...} }`, producing double-nested variables on the wire (`engine.ts:156-160`); it "works" only because it accidentally reproduces the error the page documents. Fix to the correct shape while still demonstrating the failure deliberately (e.g. `variables: {}` with a comment) — note the naive fix `variables: { id: '42' }` would make the example succeed and stop illustrating the error.

### 1.8 `keychain()` is a plaintext-JSON spike with a security-grade name and zero tests

`auth.ts:29-48` reads unencrypted JSON from `~/.stitch/secrets.json` with env fallback — no OS keychain anywhere. The docs honestly describe the file mechanics but never state it is unencrypted, and `secret-resolvers.mdx`'s only callout actively steers users toward it; `basic()` and `keychain()` have zero test coverage (an asymmetry — oauth2 and cookieSession have dedicated specs).
**Build:** rename to `secretsFile()` (or implement the OS keychain via `security`/libsecret/Credential Manager behind the same contract), add an explicit plaintext warning, and add specs for `basic()` encoding and `keychain()` resolution order.
**Evidence:** `packages/core/src/auth.ts:29-48,69-79`, `apps/docs/content/docs/guides/auth/secret-resolvers.mdx:44-59`, `docs/FEATURE-LENSES.md:50`, `docs/DESIGN.md:522-528`.

---

## 2. High-value additions

Prioritized for the stated audience: humans and AI agents consuming third-party APIs.

### 2.1 End-to-end type inference from schemas

Every comparable tool (Zodios, ts-rest, openapi-fetch, Hono client) infers request/response types from the contract; here `Stitch<T>` is whatever the caller asserts, `toValidator(schema: unknown)` erases the schema's static type immediately, and the call signature is loosely-typed `StitchInput` — runtime validation exists, static typing does not. The docs even instruct users to manually keep `stitch<T>` and the schema in sync (and `standard-schema.mdx`'s frontmatter over-promises "inferred types").
**Build:** make `stitch()`/`defineStitch` generic over config — infer T via `StandardSchemaV1.InferOutput` from `output`/`drift()`, derive typed input from the `input.{params,query,body,headers}` validators plus RFC 6570 template variables, `unknown` fallback when no schema.
**Evidence:** `packages/core/src/types.ts:5-11,154-159,235-241`, `packages/core/src/stitch.ts:233-302`, `packages/core/src/validator.ts:15-20`, `apps/docs/content/docs/getting-started/quickstart.mdx:53`.

### 2.2 Response-body streaming (emit `delta` for real)

The lifecycle event spine is live (`.stream()`, serve forwards events as SSE), but inbound body streaming does not exist: both adapters buffer fully, `ResponseType` has no `'stream'`, and `sandbox-sim` already serves SSE/chunked endpoints the core client cannot consume incrementally. This blocks the playground's token-streaming acceptance line and the future LLM kind, and is table stakes for the agent audience.
**Build:** an opt-in `responseType: 'stream'`/SSE path in `fetchAdapter` (read `response.body` via `getReader`, SSE framing for `text/event-stream`), emit `delta` through the engine generator, concatenate for the `await` form; `serve.ts:58-79` then forwards deltas for free, and MCP progress can follow.
**Evidence:** `packages/core/src/http-adapter.ts:51-77`, `packages/core/src/types.ts:41,141`, `packages/core/src/serve.ts:58-79`, `packages/sandbox-sim/src/handlers/streaming-llm.ts`, `docs/sandbox/SANDBOX-STATUS.md` §5.1.

### 2.3 Trace redaction and a first-class off switch

The `start` event carries the caller's full input (including per-call `Authorization` headers and body) and resolved URL; `result` carries the entire response body; `trace.ts:88-91` appends all of it unencrypted to `~/.stitch/runs/proto.jsonl` by default. There is no `trace` field on `StitchConfig`, and `STITCH_TRACE_FILE=0` would literally write to a file named `0` (`stitch.ts:128-137`) — the only escape is `STITCH_TRACE_FILE=/dev/null`. Peer observability tooling redacts auth headers by default.
**Build:** default denylist redaction (authorization, cookie, set-cookie, x-api-key, proxy-authorization), body/result truncation by default with opt-in full capture, and `trace: false` / a real env off switch. (OTLP needs only `url.full` scrubbing — it never exports headers/bodies, `otlp.ts:91-160`.)
**Evidence:** `packages/core/src/trace.ts:66-91`, `packages/core/src/engine.ts:448-455,512-518`, `packages/core/src/stitch.ts:128-137`, `apps/docs/content/docs/guides/observability/trace-sinks.mdx:14-16`.

### 2.4 Agent-grade MCP: per-stitch schemas, structured results, progress, self-correction

The MCP front door is a headline surface, but `run_stitch` has a fully generic inputSchema, `list_stitches` returns only name/method/path (url-style stitches list an empty path), results are one `JSON.stringify` text block, the stitch is awaited so progress/drift events are dropped, and an output-validation failure surfaces as the bare string `'contract violation (drift)'` — even though leveled drift findings already exist in the event stream (the fix is wiring, not new detection). `StitchConfig` has no `description` field at all. OVERVIEW §2's promised "context-frugal" answers (field-select, re-prompt on mismatch, gen*ai.*/mcp.\_ spans) have no code or roadmap entry.
**Build (cheapest first):** (1) derive per-stitch JSON Schemas from input validators + path variables and enrich `list_stitches`/add descriptions; (2) return drift findings in the MCP (and serve, `serve.ts:94-101`) error payload; (3) `structuredContent` alongside text, a `fields` selector, and progress notifications from stitch events. Move handles/summarize/human-in-the-loop to an explicit roadmap so OVERVIEW §2 stops reading as shipped.
**Evidence:** `packages/core/src/mcp.ts:39-55,70-74,116,123-135,162`, `packages/core/src/stitch.ts:140-159`, `packages/core/src/engine.ts:493-510`, `packages/core/src/otlp.ts:54`, `docs/OVERVIEW.md:41-47`.

### 2.5 Export serve/MCP/registry programmatically; harden serve

`package.json` exposes a single `'.'` entry and `index.ts` exports none of `createServeHandler`/`serve`/`createMcpServer`/`serveStdio`/registry helpers — despite `serve.ts:106-108` saying createServeHandler is "exposed so it can be mounted in an existing server," and the in-repo sandbox MCP having to deep-import via relative source paths. Serve also has no auth, no CORS, and an unbounded body read (`serve.ts:37-47`), mitigated only by the 127.0.0.1 default.
**Build:** subpath exports (`stitchapi/serve`, `stitchapi/mcp`, `stitchapi/registry` — consistent with ADR 0001) plus an optional bearer token and body-size cap on serve. Note: exporting `TimeoutError`/`CircuitOpenError` only helps the hooks path today — awaited callers deliberately receive renamed `StitchError`s (`stitch.ts:154`), pending the error-taxonomy refactor.
**Evidence:** `packages/core/src/index.ts`, `packages/core/package.json:8-19`, `packages/core/src/serve.ts:37-47,106-108`, `docs/sandbox/mcp/server.ts:10-16`, `docs/adr/0001-package-naming-and-distribution.md`.

### 2.6 Single-flight token refresh (and circuit half-open CAS)

OVERVIEW names "token-refresh races" as a target pain, but `oauth2`'s get→check→fetch is non-atomic with no in-flight coalescing — concurrent cold calls or simultaneous 401s each POST the token endpoint (the engine's `refreshed` flag dedupes only within one call). The circuit breaker's half-open has the same read-then-act race: all concurrent callers pass as "trials."
**Build:** an in-process `Map<key, Promise>` single-flight for refresh; add `setIfAbsent`/CAS to `StitchStore` to cover cross-process dedupe and the half-open trial.
**Evidence:** `packages/core/src/auth.ts:122-175,235-256`, `packages/core/src/engine.ts:274,328,391`, `packages/core/src/resilience.ts:189-193`, `docs/OVERVIEW.md:66`.

### 2.7 Pagination presets and incremental consumption

`paginate.next()` is fully manual, all pages aggregate in memory with a single final `result`, the empty-page stop is silent (`engine.ts:487`), and progress events carry no machine-readable items — just a human string. Octokit/Stripe-style iteration is the ecosystem norm.
**Build:** `cursor()`/`offset()`/`pageNumber()`/`linkHeader()` presets plus `stitch.pages()`/`stitch.items()` async iterators with per-page validation, keeping the aggregate await path.
**Evidence:** `packages/core/src/types.ts:196-209`, `packages/core/src/engine.ts:432-520`, `apps/docs/content/docs/guides/data/pagination.mdx`.

### 2.8 Configurable query array format

`buildQuery` hardcodes qs-indices (`ids[0]=1`). Repeat style (`?ids=1&ids=2`) is achievable today only via the undocumented RFC 6570 explode operator in `params` (`{?ids*}`, tested at `test/url-query.spec.ts:50`) — which bypasses the `validate.query` slot — and literal bracket style is impossible. DESIGN §15 flags this as open.
**Build:** `arrayFormat: 'indices' | 'brackets' | 'repeat'` (default indices), wire-level specs per format, and document the explode escape hatch.
**Evidence:** `packages/core/src/util.ts:244-270`, `docs/DESIGN.md:527`.

### 2.9 A shipped testing story (mock adapter)

Nothing public helps users test code that calls stitches; the productizable artifact already exists in-repo — `packages/core/test/support/mock-server.ts` has route patterns, status sequences, latency knobs, and call spies — but is unpublished, and `sandbox-sim` is private. `types.ts:2` even references a "mock-server" consumer that doesn't ship.
**Build:** publish a `mockAdapter({handlers})` (the exported transport type is `Adapter`, `types.ts:56`) or productize the mock server, optionally with record/replay to fixtures, plus a testing guide.

### 2.10 CI contract gate + shape-based drift snapshots

DESIGN §7/§14.7 promise CI replay of committed sample payloads; no such command exists, and the drift spike stores the full response body (the docs tell users to commit it — real user data in git), samples arrays from element `[0]` only, and silently overwrites corrupt snapshots. Live `stitch run` exit codes partially cover CI but require hitting the real API.
**Build:** derived shape snapshots (path → type/nullable), multi-element array sampling, error on corrupt snapshots, and `stitch check` with `--strict` exit-code semantics.
**Evidence:** `packages/core/src/drift.ts:6-7,33-34,94-101`, `packages/core/src/engine.ts:256`, `packages/core/src/cli.ts:549-557`, `apps/docs/content/docs/guides/validation/drift.mdx:36`.

### 2.11 First-party persistent store; align throttle semantics

The store seam is fully built and tested, but only `memoryStore` ships — `@stitchapi/redis` would make success criterion #4 (two workers share one login and one rate budget) demonstrable out of the box. Undocumented today: pacing behavior silently changes from even-spacing to fixed-window (boundary bursts) the moment a store is attached.
**Build:** a Redis adapter with atomic INCR+EXPIRE, sliding-window alignment with the in-memory limiter, and a doc note on the pacing change (distributed concurrency staying in-process is already documented).
**Evidence:** `packages/core/src/store.ts:8,47-48,86-101`, `packages/core/src/stitch.ts:187-189`, `apps/docs/content/docs/guides/state/pluggable-store.mdx`.

### 2.12 Close the untested-surface holes (the b06cf00 lesson)

Commit b06cf00's rebuild silently dropped three documented capabilities because no regression net pinned them; the same exposure persists: zero tests for backoff modes (`expo`/`fixed`), `maxMs`, jitter bounds, Retry-After HTTP-date, `timeout.perAttempt`, transport-error retry, and the `onError`/`onRetry` hooks; the entire CLI `main()` dispatch and `traceCommand` are untested — including a real bug where an unparseable `--since` silently becomes `cutoff = now` and filters out all records with exit 0 (`cli.ts:349-356,447`); and the collector-facing OTLP path (`otlpHttpExporter`, `toOtlpJson`) has zero tests while swallowing every failure with no diagnostic outlet (`otlp.ts:75-85,263-265`).
**Build:** cheap pure-function specs for the resilience knobs and hooks chaining; `main()` specs with injected IO; fix `--since` to exit 2 on unparseable input; an OTLP spec against a local `node:http` listener asserting valid OTLP/JSON, plus a one-time stderr warning on first export failure (note `STITCH_TRACE_CONSOLE` cannot reveal export failures — a new mechanism is needed).

### 2.13 Prove the browser sandbox security model before the playground ships

All five real-browser security invariants (SEC-04, SEC-10..13: CSP confinement, Worker isolation, fetch egress interception) are deferred; no Playwright-class harness exists; `apps/docs` currently ships zero CSP headers (no `headers()` in `next.config.mjs`, no middleware); the browser fetch-shim is a code-identical but separately-untested duplicate of the node adapter that has never run in a real Worker; and there is no browser-Worker memory cap (accepted as time-bounded-only risk).
**Build:** the harness `SANDBOX-STATUS.md` §7 itself calls for, real CSP headers in the docs app, at least one browser-environment test of `packages/sandbox-sim/src/adapters/browser.ts`, and resolution of checklist Appendix A items A (memory) and B (pinned CSP) first.
**Evidence:** `docs/sandbox/SANDBOX-STATUS.md:29-45`, `docs/sandbox/SANDBOX-SECURITY-CHECKLIST.md:209-247`, `apps/docs/next.config.mjs`.

### 2.14 Commit runnable examples

`git ls-files examples/` is empty (`examples/get-users` holds only node_modules; the source sits untracked in the sandbox worktree) while the README warns the project "may break without notice" — a clonable example is the cheapest adoption and regression artifact the repo lacks.
**Build:** commit the get-users demo with a README and `pnpm i && pnpm start`, and smoke-run it in CI against `sandbox-sim`'s `/users` fixture so examples double as integration tests.

---

## 3. Lower priority / nice to have

- **OpenAPI emission first, ingestion later.** `stitch export --openapi` walking the registry (method/path/templates/input schemas via the same Standard Schema → JSON Schema converter as §2.4) is mostly mechanical and makes the "reversible" claim true; ingestion stays roadmap. Note `packages/core/README.md:69` says spec ingestion is "on the roadmap" but neither OVERVIEW §10 nor DESIGN §14 actually lists it — add the roadmap entry or soften the README. (`docs/OVERVIEW.md:127-128`)
- **Lifecycle hooks docs page.** `Hooks`/`HookContext` payloads, firing points relative to auth/retry (`engine.ts:289-355`), onRequest mutation semantics, and the base→child / child→base chaining order (`stitch.ts:47-69`) are documented nowhere beyond one sentence in `extends.mdx:39-41` and a one-line auto-table row.
- **Port README coverage to the docs site.** `axiosAdapter` (documented at `packages/core/README.md:468-476`, zero hits in `apps/docs/content/docs`) and a "URLs, templates & query" guide for RFC 6570 operators + nested-query wire format (README:160-176, `docs/DESIGN.md:66-68`) — both can be adapted nearly verbatim; add `axiosAdapter` to `helpers.mdx`'s export list.
- **Land the playground WIP and wire sandbox tests.** The working integration (playground pages, worker entry, node runner, sandbox MCP) exists only as untracked files; `sandbox-sim`'s 5 suites have a manual runner (`docs/sandbox/tests/run-all.mjs`) wired to no package.json script, lefthook, or CI. Run the SANDBOX-STATUS §6 checklist once, commit, and add a `test` script so `pnpm -r test` covers them.
- **Wire real trace data to the playground DAG, then `stitch diagram`.** The worker never populates `RunResult.trace` (`docs/sandbox/runtime/worker-protocol.ts:78-99`), so the shipped DAG never renders from real runs; close that loop first, then Mermaid-from-definition can reuse the same walk. `stitch trace` already covers summary stats; defer `stitch top`.
- **Auth inference.** DESIGN §5 tags it `[proposed]` and the published docs make no claim, so no trust break — if pursued, start with the narrowest signal (host-matched `*_TOKEN` env var → bearer, announced via an info-level event) and tag cookbook 8a as future until then. (`docs/DESIGN.md:179,358-361`)
- **Shell/LLM kinds and `pipe()`.** Honestly roadmapped nearly everywhere; the only present-tense leak is the competitive-wedge prose (`docs/OVERVIEW.md:24,93`) — soften those two lines, fix stale `DESIGN.md:40` (still lists graphql as future), and when ready, extract the `KindExecutor` seam the docs call "abstraction-ready" (today graphql is inline conditionals in `engine.ts`).
- **Multi-tenant / per-call credential context.** One stitch = one identity (static oauth2/cookieSession cache keys, `auth.ts:114,204`); serve/MCP cannot bind callers to tenant credentials, and per-call Authorization headers work only when no auth strategy is configured. Either thread a connection/tenant context through `AuthContext` and store keys, or document multi-tenancy as an explicit non-goal — today it's neither.
- **Conditional revalidation only, if anything.** TTL response caching is an explicit, repeatedly documented non-goal (`docs/DESIGN.md:476`); the defensible subset is protocol-level ETag/`If-None-Match` with 304-as-hit, which is wire mechanics rather than the excluded app-level cache policy.
- **Webhooks: keep out of scope, say so in the public docs.** Inbound webhooks are a stated non-goal in four places; at most add a docs recipe showing how to verify signatures alongside stitches rather than absorbing it into core.
