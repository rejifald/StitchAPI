# Changelog

All notable changes to the `stitchapi` core library (and the in-repo peer-dep
packages) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO-8601 and derived from the git history; entries without a published
npm release are grouped under the in-development version that introduced them.

## [Unreleased]

### Added

- **`parseDuration` is now exported from `stitchapi`.** The one shared duration parser
  (`5_000`, `'5s'`, `'1m'` → ms) that CONTRACT.md P17 requires every consumer-authored
  duration to go through. It was already the parser core used internally; exporting it
  lets a peer package accept `number | string` without mirroring the grammar and drifting
  from it. Additive — nothing else changes.

### Changed

- **BREAKING — `stream.maxBufferBytes` is renamed to `maxBufferChars`.** The cap never
  counted bytes. Every guard it feeds compares `.length` on a string the `TextDecoder` has
  already produced (`line-reader.ts`, `json-stream.ts`, `sse.ts`), so it measures characters
  of the decoded text — UTF-16 code units — not bytes off the socket:

    ```ts
    // before
    stream: { decode: 'json', maxBufferBytes: 8 * 1024 * 1024 }
    // after
    stream: { decode: 'json', maxBufferChars: 8 * 1024 * 1024 }
    ```

    Default and behaviour are unchanged; the name, its JSDoc, and the thrown error text
    (`… exceeded maxBufferChars (…)`) are all that move. The old name mattered because it
    understated the guard it exists to be: 8M code units of CJK is ~24 MB of UTF-8 on the wire
    and ~16 MB of string memory, so an OOM bound that read as "8 MB" was 2–3× looser than it
    looked. Per P1, `Bytes` already denotes bytes elsewhere on the surface (`ServeOptions.maxBodyBytes`,
    byte progress) and cannot also denote code units.

    No `@deprecated` alias: P19 scopes that obligation to the GA channel and this lands on `rc`.

- **BREAKING — `retry`'s backoff fields fold into one `backoff` envelope.**
  `RetryOptions.backoff` / `baseDelay` / `maxDelay` were three flat members configuring a
  single concept, two of them sharing a `Delay` suffix. They are now one envelope:

    ```ts
    // before
    retry: { attempts: 3, backoff: 'expo', baseDelay: 200, maxDelay: '10s' }
    // after
    retry: { attempts: 3, backoff: { curve: 'expo', base: 200, max: '10s' } }
    ```

    `backoff: 'expo-jitter'` still works — a bare curve is the shorthand for `{ curve }`, so
    the common case is unchanged. Only configs that set `baseDelay` or `maxDelay` need editing:
    move them under `backoff` as `base` / `max`. Inside the envelope the `Delay` suffix is
    redundant — there is only one thing there to measure. `backoff: {}` is a compile error;
    pass a curve, or set at least one bound.

    `@stitchapi/deno-kv`'s `retry.backoff` folds identically in the same release, so the
    store's compare-and-set policy and a stitch's retry policy keep spelling the same
    concept the same way.

- **BREAKING — `sse.reconnect.backoff` is renamed to `delay`.** It is a flat fallback
  duration, while `retry.backoff` is a curve policy — one token meaning two things, and since
  both accept strings, `backoff: 'expo'` and `backoff: '1s'` were indistinguishable by shape.
  `backoff` now means "the curve policy" everywhere; the reconnect fallback is a `delay`:

    ```ts
    sse: { reconnect: { attempts: 5, delay: '1s' } }
    ```

    Behaviour is unchanged — a server-sent `retry:` still wins, and with no `delay` the stitch's
    `retry.backoff` still supplies the wait.

    Neither carries a `@deprecated` alias: P19 scopes that obligation to the GA channel and this
    lands on `rc`.

- **BREAKING — `@stitchapi/deno-kv`'s `maxIncrRetries` becomes `retry`.** The
  compare-and-set budget for `increment` is now `retry?: number | AtLeastOne<DenoKvRetryOptions>`,
  speaking core's `retry` vocabulary rather than a second private spelling. A bare number
  is the attempts shorthand; the envelope adds a backoff curve the loop never had:

    ```ts
    denoKvStore(kv, { retry: 20 }); // ≡ { attempts: 20 }
    denoKvStore(kv, { retry: { attempts: 20, backoff: 'expo-jitter' } });
    ```

    Two things to know when migrating, beyond the rename:

    - **`attempts` counts total attempts, not retries.** `maxIncrRetries: 3` allowed four
      reads (the first plus three retries); `retry: 3` allows three. Add one to preserve the
      old budget exactly. The default moves from `100` retries to `100` attempts — one fewer
      read in the worst case, which no realistic contention notices.
    - **`{}` is a compile error.** The object form is `AtLeastOne<DenoKvRetryOptions>` per
      P20, so `retry: {}` (which reads as a no-op but would silently mean "defaults") is
      rejected; write `retry: 100` for the all-defaults case.

    `backoff` is **off by default**, preserving today's behaviour — the loop re-reads
    immediately on a lost race. Set `'expo'`, `'expo-jitter'` or `'fixed'` — or the
    `{ curve, base, max }` envelope, `base` 5ms and `max` 250ms — when many isolates contend
    on one key. No `@deprecated` alias:
    P19 scopes that obligation to the GA channel and this lands on `rc`.

- **BREAKING — the store contract speaks whole words: `incr` is now `increment`, and
  `RedisDriver.del` is now `delete`.** `StitchStore` — the interface every store
  implements — renames its atomic counter to `increment(key, ttl?)`, and
  `@stitchapi/redis`'s `RedisDriver` follows for both verbs. The house contracts are
  the vocabulary a consumer implements against, not bytes on a socket, so they use
  whole words (CONTRACT.md P18); the Redis **commands** are untouched — the Lua still
  calls `INCR`, and the `IoredisLike`/`NodeRedisLike`/`UpstashLike` mirrors still
  expose `del`, because a mirror keeps its SDK's spelling. Shipped **without
  `@deprecated` aliases** — CONTRACT.md P19 scopes the alias obligation to the GA
  channel, and this lands on `rc`. (They could not have carried one anyway: on an
  interface the consumer implements and core calls, an alias means typing both
  spellings optional forever and letting a store satisfy the type while implementing
  neither verb.)

    _Migration:_ rename the method on any custom store or driver — `incr` → `increment`,
    and on a `RedisDriver`, `del` → `delete`. The bundled stores (`memoryStore`,
    `@stitchapi/redis`, `@stitchapi/deno-kv`, `@stitchapi/cloudflare-kv`,
    `@stitchapi/react-native`, `@stitchapi/expo`) are already updated, so you only act
    if you hand-rolled one. TypeScript names every site.

- **BREAKING — `ttl` is now optional on `increment`.** `StitchStore.increment(key, ttl?)`
  and `RedisDriver.increment(key, ttl?)` match `set`: an absent `ttl` means **no
  window**, so the counter accumulates and never expires. Previously `ttl` was
  required on the counter but optional on `set` — the same parameter with two
  optionalities. Widening, so existing call sites are unaffected; an implementor whose
  signature typed `ttl` as required should relax it and handle the absent case.

## [1.0.0-rc.6] — 2026-07-23

### Changed

- **BREAKING — the `unwrap` config key is renamed to `pick`.** The response-shaping
  key that pulls a nested payload out of an envelope (`{ data: … }` → the value it
  wraps) is now spelled `pick`, the verb the guides already used for it, leaving
  `unwrap` to mean only the throwing call twin (`stitch.unwrap()`). Rename
  `unwrap: '<path>'` to `pick: '<path>'` in every stitch config — there is no
  deprecated alias. (#481)

- **BREAKING — `@stitchapi/next`'s `stitchErrorResponse` now returns
  `Response | undefined`.** It returns `undefined` for anything that is not a
  `StitchError` (previously it always produced a `Response`), so it composes inside
  a `catch` that must also rethrow non-stitch failures untouched:

    ```ts
    const mapped = stitchErrorResponse(err); // default status 502
    if (mapped) return mapped; // undefined → not a StitchError
    throw err;
    ```

    Callers that assumed a non-null `Response` must handle the `undefined` branch. (#475)

### Added

- **`throttle` string shorthand.** `throttle: '1/s'` is now accepted as shorthand for
  `throttle: { rate: '1/s' }`, matching the ergonomics of the other rate-shaped
  options. The object form is unchanged and is still required when you also set a
  `pool` (or any other throttle field). (#480)

## [1.0.0-rc.5] — 2026-07-08

### Changed

- **BREAKING — run-identity fields renamed to the OpenTelemetry names.** The
  `RunContext` struct and the `start` event now carry **`spanId`** and
  **`parentSpanId`** instead of `runId` and `parentId` (`traceId` is unchanged).
  The names now match what the OTLP exporter already emits, so the mapping is an
  identity and there is no translation seam. Custom trace sinks reading
  `ctx.runId` / `ctx.parentId` (or `event.runId` / `event.parentId`) must read
  `ctx.spanId` / `ctx.parentSpanId`. The `@stitchapi/sentry` integration now
  reports the failing run's id under a `spanId` tag. See
  [ADR 0017 Decision 7](docs/adr/0017-outbound-trace-context-propagation.md) and
  the new `concepts/run-identity` page.

### Added

- **Idempotency misuse nudges.** A stitch now logs a one-time construction
  warning when `idempotency` is set on a read (the key is sent on writes only —
  almost always a missing `method: 'POST'`) or with the random default key and no
  `retry` (it only dedupes the call's own retries). Both are respectful hints with
  an out — set `idempotency: { warn: false }` to silence them — and fire only on
  the default HTTP surface. New `IdempotencyOptions.warn` field.

- **`@stitchapi/docs-mcp` — local/offline docs search over MCP stdio.** The
  offline counterpart to the hosted `stitchapi.dev/api/mcp` server: the same
  `search_docs`/`get_doc` tools, with the docs corpus and embedding index bundled
  at build time so there is no per-query network call. For air-gapped or
  strict-egress environments.

## [1.0.0-rc.4] — 2026-06-29

### Added

- **GraphQL `operationName`.** The `graphql` surface now sends `operationName`
  alongside `{ query, variables }`, derived from the first named operation in
  the document (anonymous documents omit it, matching `graphql-request`). A new
  `operationName` config key overrides the derived value for multi-operation
  documents, or suppresses the field entirely with `''`. This restores parity
  with conventional GraphQL clients so servers, logs, APM, and request mocks
  that key on the operation name see it again.

## [1.0.0-rc.3] — 2026-06-21

### Added — the integration ecosystem

The first wave of `@stitchapi/*` ecosystem adapters — a stitch now drops into the
framework, runtime, and store you already use, each a thin typed seam over the
same core runtime (no new concepts; streaming-first where it applies):

- **Server frameworks:** `@stitchapi/elysia`, `@stitchapi/express`,
  `@stitchapi/fastify`, `@stitchapi/hono`, and `@stitchapi/next` — a
  request-scoped seam on the context/`req`, an SSE bridge for a streaming
  stitch, and `StitchError`→HTTP mapping. The Fetch-only adapters (`hono`,
  `elysia`, `next`) stay edge/multi-runtime safe.
- **Client & UI bindings:** `@stitchapi/react`, `@stitchapi/vue`,
  `@stitchapi/svelte`, `@stitchapi/solid`, and `@stitchapi/angular` —
  tearing-free `useStitch`/`useStitchStream` (and the framework-native
  equivalents) that re-render as `delta` chunks arrive, over the new shared
  `@stitchapi/query-core` reactive store, plus an optional TanStack Query
  `queryOptions` helper. `@stitchapi/react-native` adds the streaming XHR
  transport bare RN lacks and an AsyncStorage `StitchStore`, and
  `@stitchapi/expo` layers `expo/fetch` streaming and a secure-store token
  store on top.
- **Data-fetching libraries:** `@stitchapi/swr` (`useStitchSWR`) and
  `@stitchapi/rtk-query` (`stitchQueryFn` + `stitchStreamUpdater`) hand
  caching/revalidation to the host library while the stitch stays typed,
  validated, and traced.
- **State stores:** `@stitchapi/cloudflare-kv` (Workers KV) and
  `@stitchapi/deno-kv` (atomic `incr` for distributed throttle) join
  `@stitchapi/redis` as edge-/runtime-native `StitchStore` backends.
- **Auth:** `@stitchapi/aws-sigv4` — an `AuthStrategy` that signs each request
  with AWS SigV4 over edge-safe Web Crypto (AWS APIs, S3-compatible stores, any
  SigV4-protected endpoint).
- **Observability:** `@stitchapi/pino` and `@stitchapi/sentry` `TraceSink`s map
  the stitch event stream to structured logs and breadcrumbs/error capture —
  metadata-only, safe on a secret-bearing seam.
- **AI:** `@stitchapi/vercel-ai` exposes a stitch as a Vercel AI SDK `tool()`
  the model can call — it gets validated data, never the credential.

Each ships `publishConfig.access: public`, a README, and a LICENSE. A new package's
first publish is a one-time bootstrap (OIDC cannot publish a brand-new name); it
rides the OIDC publish workflow thereafter — see [`docs/RELEASING.md`](docs/RELEASING.md).

### Added — a published testing story

- **Mocking kit on `stitchapi/testing`:** helpers for testing your own stitches
  and the code that calls them, alongside the existing vendor conformance kit.
  `mockAdapter(routes)` injects a fake transport — status sequences (retry),
  abortable latency (timeouts), function responders (pagination), streaming
  bodies, and a request spy (`calls`/`callCount`/`lastRequest`) — so the real
  runtime runs against canned responses with no global-`fetch` monkeypatching.
  `stubStitch` / `failStitch` stand in for a real stitch when unit-testing
  calling code (a conformant `Stitch` with a call spy; pairs with a Nest
  `overrideProvider`). `streamOf` / `sseStream` / `streamThenError` /
  `gatedStream` / `streamAdapter` build streaming bodies, and
  `collectStitchEvents` drains a `.stream()` into its parts. Browser-safe.
  (GAP-AUDIT §2.9)
- **Injectable `Clock` (ADR 0010):** a stitch/seam `clock` makes retry backoff,
  throttle pacing, the per-attempt timeout, and circuit cooldown deterministic.
  Defaults to `systemClock` (no behaviour change); inject `manualClock()` from
  `stitchapi/testing` and drive time with `advance(ms)` — no real waiting, no
  fake-timer library. `Clock` + `systemClock` are exported from the main entry.
  (`timeout.total` and event timestamps stay on wall-clock.)

## [1.0.0-rc.2] — 2026-06-18

A pipeline release — **no library changes**. `1.0.0-rc.1` was bootstrapped with a
hand-run publish; `rc.2` is the first version published automatically through the
**OIDC trusted-publishing** workflow, so every tarball now carries a signed npm
**build-provenance** attestation. The library code is identical to `rc.1`.

## [1.0.0-rc.1] — 2026-06-18

The first **v1.0 release candidate** — the library, the interactive playground, and
the docs site as one public moment. It bundles the whole post-`0.7.0` cycle (the
former in-development `0.8.0` work plus the playground and docs reconciliation) into
the first published `1.0` line, and ships the `@stitchapi/*` companions (`nest`,
`redis`, `shell`, `fingerprint-*`) for the first time. Published under the `rc`
dist-tag — `latest` stays on `0.7.0` until `1.0.0` is promoted. See
[`docs/RELEASE.md`](docs/RELEASE.md) for the checklist.

### Added — agent adoption, streaming completion & release tooling

- **Agent-recommendation surfaces:** a `describe_stitch` MCP teaching tool,
  teaching-grade validation errors, an npm discovery signal, zod-default docs, an
  `llms.txt`, and **`stitch init`** (alias `stitch rules`) — which writes the
  canonical consumer rule ("declare a typed stitch, don't hand-roll `fetch`/`axios`")
  into the files an AI coding agent reads (`--format agents|cursor|claude|all`,
  default `all`: `AGENTS.md`, a Cursor `.cursor/rules/stitchapi.mdc`, and a marked,
  idempotent `## Using StitchAPI` section in `CLAUDE.md`; `--force` rewrites). (#175)
- **Resumable SSE:** an `sse()` stitch reconnects on `Last-Event-ID`, honoring the
  server's `retry:` backoff hint. (#180)
- **Structural streaming-JSON decoder (`decode: 'json'`):** decode an unframed JSON
  stream into typed `delta`s without SSE framing. (#179)
- **Compile-time typed `delta`:** the streamed `delta` element type is inferred from
  the `output` schema. (#178, #115)
- **Bundle-size budget gate:** a tree-shaken min+gzip budget enforced in CI
  (`pnpm size` / `check:size`), with the zero-deps/size numbers advertised across the
  READMEs and docs. (#170, #176)

### Security

- Eliminated 6 polynomial-ReDoS ("super-linear runtime") code-scanning alerts by
  rewriting the affected parsers to linear-time matching. (#177)

### CI / release hardening

- The npm publish workflow now waits on the real-browser Playwright e2e suite (sandbox
  CSP + Worker egress + trace→DAG) before publishing. (#171)
- Unbroke the frozen-lockfile install (an `esbuild` override floor drifted the
  lockfile) and added a lockfile-drift gate. (#172)
- A hermetic MCP-subprocess e2e exercises `run_stitch` round-trips over stdio. (#174)
- `check:release` now also asserts every publishable package ships a `LICENSE` and a
  `README.md`.

### Added — playground & release hygiene

- Playground: the trace DAG is back, rendered as a Mermaid SVG wired to real
  ADR 0007/0008 causality (dependency edges from `dependsOn`/`parentId`, retry and
  page annotations, shell `$ command` labels).
- `CHANGELOG.md` and a runnable, offline `examples/` demo (a typed `stitch` with an
  `output` schema, run against an injected mock adapter).
- `@stitchapi/sandbox-sim` now has a `test` script, so `pnpm -r test` covers its
  simulator suites.
- Release guardrails (`pnpm check:release`): version lockstep across the publishable
  packages, prerelease-aware peer-range checks, scoped `publishConfig.access`,
  dist-tag safety (a prerelease never lands on `latest`), and a CHANGELOG entry —
  enforced in the verify + publish workflows and each package's `prepublishOnly`.

### Changed

- Documentation reconciled with the shipped reality (READMEs and the docs
  banner flipped to an honest release-candidate (`1.0.0-rc.1`) framing —
  feature-complete and in real use, candid that stable 1.0 isn't stamped yet;
  ADRs 0002 / 0005 / 0006 / 0007 promoted from
  _Proposed_ to _Accepted_; OVERVIEW and RELEASE counts and status refreshed). (#173)

### Notes

- Deferred to v1.1 (non-blocking): pagination presets (`cursor()` / `offset()` /
  `linkHeader()`) with async iterators, and a published record/replay mock adapter.

### Added — library (the former in-development `0.8.0`)

The non-HTTP surfaces, composition causality, and the OpenAPI export, on top of the
surfaces and authoring model that landed earlier in the cycle:

- **Non-HTTP surfaces (ADR 0008):** `llm` and `shell` as symmetric kinds, plus the
  `pipe()` primitive to compose heterogeneous stitches into one chain. A shell
  stitch maps a non-zero exit to `status >= 400`; an `llm` stitch carries a chat
  request. `pipe()`'s trace is a step→step chain under one run identity. (#165)
- **Composition causality (ADR 0007):** a run-identity OTLP span tree
  (`runId` / `traceId` / `parentId`). A retry attempt and a page are each child
  spans with their own start/end/latency/outcome; a coalescing follower is neither;
  streaming `delta`s are values within the run span. (#163)
- **Response streaming surfaces (ADR 0005, stages 5–7):** `sse()` and `stream()`
  surfaces with per-`delta` `output` validation; the fetch adapter hands back the
  live `ReadableStream`; the engine emits a `delta` per chunk; `stitch serve`
  forwards deltas over SSE. The `xhr` and `axios` adapters reject streaming by
  design. A buffered binary `download` surface returns `{ blob, filename }`.
  Every surface and the `xhr` adapter became a subpath export. (#99, #100, #101, #118)
- **`stitch export --openapi`:** emit an OpenAPI 3.1 spec from the registry
  (paths/methods, RFC 6570 path & query params, body/response presence), with real
  body schemas via a bring-your-own `toJsonSchema` converter (`--schema-module`). (#126)
- **`stitch diagram`:** render a Mermaid flowchart of a stitch's pipeline. (#128)
- **`stitch drift generate`:** write snapshot baselines deliberately; drift
  `readonly` mode detects without writing. (#132, #140, #160)
- **Auth:** OAuth2 `client_credentials` (token endpoint, cached access token,
  single-flight refresh, opt-in per-principal tenancy); `apiKey({ in: 'query' })`
  placement; `cookieSession` lifecycle hooks (`onAuthFailure` / `onRefresh`);
  optional credentials via `bearer(optionalEnv())` with info events; a
  `secretFrom()` resolver, and `env()` now rejects empty values. (#129, #139, #151, #153)
- **Engine / adapter:** `acceptStatus` (treat non-2xx as a result) and a richer
  `StitchError` carrying `{ body, url }`; `safe()` / `unwrap()` call variants;
  a delegate-backoff rate-limit mode that surfaces `429` / `Retry-After` instead of
  retrying internally; per-stitch undici dispatcher/`Agent` passthrough in the
  fetch adapter. (#144, #150, #154, #158)
- **Type inference:** call-argument types now infer across `extends` fragments,
  from RFC 6570 path-template vars, and from a GraphQL `input.variables` schema. (#114, #117, #122)
- **`@stitchapi/redis`:** a Redis-backed `StitchStore` (`get`/`set`/`incr`/`close`)
  with `fromIoredis` + `fromNodeRedis` driver adapters and even-spaced distributed
  throttling, passing the store conformance kit. (#119)
- **`@stitchapi/nest`:** first-class NestJS integration (ADR 0006) — `seam` as a DI
  primitive, a logger sink bridged to Nest's `Logger`, optional injection tokens,
  an exception filter, SSE, and multi-tenant scoping. (#103, #130)
- **Logger-agnostic `loggerSink(logger, opts?)`** with per-instance `level` and
  `format` hooks. (#143)

### Changed — library

- `StitchResult` exposes `.catch` / `.finally` and runs exactly once. (#141)
- The call argument accepts `params` / `query` when a sibling slot is declared. (#142)

### Removed / Breaking

- **`seam` is the multi-endpoint primitive (ADR 0002):** `defineStitch`, `preset`,
  and `keychain` were removed in favor of `seam` + principal-scoped auth; the
  principal boundary was hardened and `SeamConfig` narrowed. (#66, #92)
- The fluent `Builder` was removed; authoring standardizes on the config-object
  model. (#90)

## [0.7.0] and earlier

Foundational work that established the runtime before the 0.8.0 surface and
causality push:

- **Surfaces & authoring model (ADR 0005, stages 0–4):** a pluggable Surface plugin
  model replacing the closed `kind` union; nested multipart; the streaming-body +
  `onProgress` adapter contract; GraphQL reimplemented as a surface. (#89, #93, #96, #97, #98)
- **Response cache (ADR 0003) + Standard-Schema fingerprint (ADR 0004):** a
  derived-key response cache with in-process request coalescing, with the schema
  fingerprint folded into the cache generation for zero-revalidation. (#74, #80, #81, #85)
- **End-to-end type inference:** `Stitch<T>` from the `output` schema and
  call-argument types from `config.input`. (#72, #77)
- **No side effects by default:** tracing (console / JSONL / OTLP) is off until
  opted in, with safe-by-default sink hardening (header denylist, URL credential
  scrub, body/result truncation). (#58)
- **Engine foundations:** RFC 6570 Level-4 templates, nested query encoding,
  pluggable HTTP adapters, and `url` as an atomic alternative to `baseUrl`/`path`. (#35, #46)
- **Conformance kit:** store / adapter / sink conformance contracts under
  `stitchapi/testing`. (#50, #59)
- **Playground:** the browser Worker runner, handler registration, incremental
  streaming, and the trace → Mermaid DAG wiring.

[Unreleased]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.6...HEAD
[1.0.0-rc.6]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.5...v1.0.0-rc.6
[1.0.0-rc.5]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.4...v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/rejifald/StitchAPI/compare/v0.7.0...v1.0.0-rc.1
