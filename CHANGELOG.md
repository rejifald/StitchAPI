# Changelog

All notable changes to the `stitchapi` core library (and the in-repo peer-dep
packages) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO-8601 and derived from the git history; entries without a published
npm release are grouped under the in-development version that introduced them.

## [Unreleased]

Nothing yet — the next change lands here.

## [1.0.0-rc.1] — 2026-06-17

The first **v1.0 release candidate** — the library, the interactive playground, and
the docs site as one public moment. It bundles the whole post-`0.7.0` cycle (the
former in-development `0.8.0` work plus the playground and docs reconciliation) into
the first published `1.0` line, and ships the `@stitchapi/*` companions (`nest`,
`redis`, `shell`, `fingerprint-*`) for the first time. Published under the `rc`
dist-tag — `latest` stays on `0.7.0` until `1.0.0` is promoted. See
[`docs/RELEASE.md`](docs/RELEASE.md) for the checklist.

### Added — playground & release hygiene

-   Playground: the trace DAG is back, rendered as a Mermaid SVG wired to real
    ADR 0007/0008 causality (dependency edges from `dependsOn`/`parentId`, retry and
    page annotations, shell `$ command` labels).
-   `CHANGELOG.md` and a runnable, offline `examples/` demo (a typed `stitch` with an
    `output` schema, run against an injected mock adapter).
-   `@stitchapi/sandbox-sim` now has a `test` script, so `pnpm -r test` covers its
    simulator suites.
-   Release guardrails (`pnpm check:release`): version lockstep across the publishable
    packages, prerelease-aware peer-range checks, scoped `publishConfig.access`,
    dist-tag safety (a prerelease never lands on `latest`), and a CHANGELOG entry —
    enforced in the verify + publish workflows and each package's `prepublishOnly`.

### Changed

-   Documentation reconciled with the shipped reality (READMEs and the docs
    banner flipped to an honest release-candidate (`1.0.0-rc.1`) framing —
    feature-complete and in real use, candid that stable 1.0 isn't stamped yet;
    ADRs 0002 / 0005 / 0006 / 0007 promoted from
    _Proposed_ to _Accepted_; OVERVIEW and RELEASE counts and status refreshed).

### Notes

-   Streaming follow-ups remain deferred and non-blocking: unframed `decode: 'json'`
    (#111), compile-time typed `delta` arrays (#115), and SSE reconnection /
    `Last-Event-ID` (#71).

### Added — library (the former in-development `0.8.0`)

The non-HTTP surfaces, composition causality, and the OpenAPI export, on top of the
surfaces and authoring model that landed earlier in the cycle:

-   **Non-HTTP surfaces (ADR 0008):** `llm` and `shell` as symmetric kinds, plus the
    `pipe()` primitive to compose heterogeneous stitches into one chain. A shell
    stitch maps a non-zero exit to `status >= 400`; an `llm` stitch carries a chat
    request. `pipe()`'s trace is a step→step chain under one run identity. (#165)
-   **Composition causality (ADR 0007):** a run-identity OTLP span tree
    (`runId` / `traceId` / `parentId`). A retry attempt and a page are each child
    spans with their own start/end/latency/outcome; a coalescing follower is neither;
    streaming `delta`s are values within the run span. (#163)
-   **Response streaming surfaces (ADR 0005, stages 5–7):** `sse()` and `stream()`
    surfaces with per-`delta` `output` validation; the fetch adapter hands back the
    live `ReadableStream`; the engine emits a `delta` per chunk; `stitch serve`
    forwards deltas over SSE. The `xhr` and `axios` adapters reject streaming by
    design. A buffered binary `download` surface returns `{ blob, filename }`.
    Every surface and the `xhr` adapter became a subpath export. (#99, #100, #101, #118)
-   **`stitch export --openapi`:** emit an OpenAPI 3.1 spec from the registry
    (paths/methods, RFC 6570 path & query params, body/response presence), with real
    body schemas via a bring-your-own `toJsonSchema` converter (`--schema-module`). (#126)
-   **`stitch diagram`:** render a Mermaid flowchart of a stitch's pipeline. (#128)
-   **`stitch drift generate`:** write snapshot baselines deliberately; drift
    `readonly` mode detects without writing. (#132, #140, #160)
-   **Auth:** OAuth2 `client_credentials` (token endpoint, cached access token,
    single-flight refresh, opt-in per-principal tenancy); `apiKey({ in: 'query' })`
    placement; `cookieSession` lifecycle hooks (`onAuthFailure` / `onRefresh`);
    optional credentials via `bearer(optionalEnv())` with info events; a
    `secretFrom()` resolver, and `env()` now rejects empty values. (#129, #139, #151, #153)
-   **Engine / adapter:** `acceptStatus` (treat non-2xx as a result) and a richer
    `StitchError` carrying `{ body, url }`; `safe()` / `unwrap()` call variants;
    a delegate-backoff rate-limit mode that surfaces `429` / `Retry-After` instead of
    retrying internally; per-stitch undici dispatcher/`Agent` passthrough in the
    fetch adapter. (#144, #150, #154, #158)
-   **Type inference:** call-argument types now infer across `extends` fragments,
    from RFC 6570 path-template vars, and from a GraphQL `input.variables` schema. (#114, #117, #122)
-   **`@stitchapi/redis`:** a Redis-backed `StitchStore` (`get`/`set`/`incr`/`close`)
    with `fromIoredis` + `fromNodeRedis` driver adapters and even-spaced distributed
    throttling, passing the store conformance kit. (#119)
-   **`@stitchapi/nest`:** first-class NestJS integration (ADR 0006) — `seam` as a DI
    primitive, a logger sink bridged to Nest's `Logger`, optional injection tokens,
    an exception filter, SSE, and multi-tenant scoping. (#103, #130)
-   **Logger-agnostic `loggerSink(logger, opts?)`** with per-instance `level` and
    `format` hooks. (#143)

### Changed — library

-   `StitchResult` exposes `.catch` / `.finally` and runs exactly once. (#141)
-   The call argument accepts `params` / `query` when a sibling slot is declared. (#142)

### Removed / Breaking

-   **`seam` is the multi-endpoint primitive (ADR 0002):** `defineStitch`, `preset`,
    and `keychain` were removed in favor of `seam` + principal-scoped auth; the
    principal boundary was hardened and `SeamConfig` narrowed. (#66, #92)
-   The fluent `Builder` was removed; authoring standardizes on the config-object
    model. (#90)

## [0.7.0] and earlier

Foundational work that established the runtime before the 0.8.0 surface and
causality push:

-   **Surfaces & authoring model (ADR 0005, stages 0–4):** a pluggable Surface plugin
    model replacing the closed `kind` union; nested multipart; the streaming-body +
    `onProgress` adapter contract; GraphQL reimplemented as a surface. (#89, #93, #96, #97, #98)
-   **Response cache (ADR 0003) + Standard-Schema fingerprint (ADR 0004):** a
    derived-key response cache with in-process request coalescing, with the schema
    fingerprint folded into the cache generation for zero-revalidation. (#74, #80, #81, #85)
-   **End-to-end type inference:** `Stitch<T>` from the `output` schema and
    call-argument types from `config.input`. (#72, #77)
-   **No side effects by default:** tracing (console / JSONL / OTLP) is off until
    opted in, with safe-by-default sink hardening (header denylist, URL credential
    scrub, body/result truncation). (#58)
-   **Engine foundations:** RFC 6570 Level-4 templates, nested query encoding,
    pluggable HTTP adapters, and `url` as an atomic alternative to `baseUrl`/`path`. (#35, #46)
-   **Conformance kit:** store / adapter / sink conformance contracts under
    `stitchapi/testing`. (#50, #59)
-   **Playground:** the browser Worker runner, handler registration, incremental
    streaming, and the trace → Mermaid DAG wiring.

[Unreleased]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/rejifald/StitchAPI/compare/v0.7.0...v1.0.0-rc.1
