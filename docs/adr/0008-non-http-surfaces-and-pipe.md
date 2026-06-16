# ADR 0008 — Non-HTTP surfaces (`llm`, `shell`) & the `pipe()` primitive

-   **Status:** Accepted (decisions resolved in the 2026-06-16 review of PR [#164](https://github.com/rejifald/StitchAPI/pull/164); implemented in PR [#165](https://github.com/rejifald/StitchAPI/pull/165))
-   **Date:** 2026-06-16
-   **Tags:** surfaces, transport, llm, shell, composition, pipe, security, browser-first, peer-dependency

> [!NOTE]
>
> The five open questions are now **resolved** (review of PR #164, recorded below). [ADR 0007](./0007-composition-causality-and-run-identity.md) (#5a) — the run-identity dependency `pipe()` builds on — has since landed, and #7 is implemented in PR [#165](https://github.com/rejifald/StitchAPI/pull/165). The shell surface's security model is the load-bearing decision — it follows the same "structural, not advisory" bar that rejected `inferBearer` in #6.

## Context

A `Surface` ([ADR 0005](./0005-surfaces-and-the-authoring-model.md), [`surface.ts`](../../packages/core/src/surface.ts)) shapes a request **around a mandatory HTTP call**: `buildRequest` patches the engine's built `AdapterRequest`, `interpret` reads the buffered `AdapterResponse`, `stream` decodes a live body — but the call itself is always `rt.adapter(req)` ([`engine.ts`](../../packages/core/src/engine.ts) `attemptLoop`), i.e. HTTP. There is no way for a surface to **replace the transport**. So two kinds of call the roadmap wants have no home: an **LLM** call is HTTP (it fits today, just needs a preset), but a **shell** command is not HTTP at all.

The thing a non-HTTP kind must NOT lose is the **resilience chain**: `retry` → `throttle` → `circuit` → per-attempt `timeout`/`signal` → `auth`/`hooks` → `trace`, all of which wrap the single `rt.adapter(req)` call. A transport running _outside_ that chain would silently lose retry, throttling, breaker, timeout, cancellation, and tracing. So the transport-replacing hook must be called at **exactly** the adapter call site, inside the chain.

`pipe()` — chaining calls so one's output feeds the next — is the third piece. Each step is a sub-call of the pipe, which is exactly the parent/child run relation ADR 0007 introduces; that coupling is why 0007 is foundational and lands first.

## Decision (resolved 2026-06-16)

1.  **A transport-replacing `Surface.execute?` hook, called inside the resilience chain.** Add `execute?: Adapter` to `Surface` (the same `(req: AdapterRequest) => Promise<AdapterResponse>` shape the engine already speaks). At the adapter call site the engine picks `cfg.kind?.execute ?? rt.adapter`, still wrapped by `withTimeout` and the per-attempt `signal` — so retry/throttle/circuit/timeout/trace/auth/hooks apply **uniformly and unchanged**. A surface with `execute` is a custom transport, so the engine **bypasses the absolute-URL guard** for it (just as it does today when `cfg.adapter` is set). The surface owns its wire shape end to end: its `buildRequest` packs whatever the transport needs **into `req.body`** (the precedent `graphqlSurface` sets with `{ query, variables }` — **no new `AdapterRequest`/`StitchInput` field**, resolving Q1), its `execute` runs it and returns an `AdapterResponse`, its `interpret` maps that to a value — after which `transform`/`unwrap`/`output`/drift/cache all run as usual.

2.  **`execute` is bound to the surface; `adapter` stays the user's HTTP client.** `cfg.adapter` is the **BYO HTTP transport** (axios/xhr/fetch — one slot, last-writer-wins); `Surface.execute` is **the protocol's own transport**, selected by `kind` and bundled with `buildRequest`/`interpret` as one identity. A shell surface must not usurp the user's HTTP client, and `shell.stitch({…})` wires all three hooks from one import. They never collide: a surface with `execute` ignores `adapter`.

3.  **`llm` is contract-first: a provider-mapping contract, with first-party Anthropic + OpenAI mappings, customer-overridable** (resolves Q2). The primitive is an **`LlmProvider` mapping contract** — how to turn a normalised `{ model, messages, … }` input into a provider's HTTP request body, and how to lift `{ text, usage, raw, … }` out of its response — exactly the `buildRequest`/`interpret` pair specialised for LLMs. This is the **contract-not-dependency** pattern (the fingerprint per-vendor contract + the BYO `axiosAdapter`), applied to LLMs: the contract is the foundation, a customer can always supply their own mapping, and **StitchAPI authors first-party mappings for Anthropic and OpenAI** that implement it — shipped as **plain config objects, no SDK dependency**, behind a `stitchapi/llm` subpath (bundle-frugal). `llm` itself is a preset over the **http** surface (no `execute` hook — an LLM call is HTTP), so bearer `auth`, `retry`, and `throttle` all apply for free. (Token streaming is a follow-up, not free today: `kind` is a single slot the buffered llm surface fills, so the shipped `sse`/`stream` surfaces only compose once the llm surface grows its own `stream` hook.) The first-party Anthropic mapping targets the current Messages API and **current Claude models** (e.g. `claude-opus-4-8` / `claude-sonnet-4-6`) as defaults; the model is always caller-set.

4.  **`shell` is a Node-only, security-gated peer package — injection-proof by construction.** It ships as `@stitchapi/shell` (a peer package like `@stitchapi/nest`), **never imported by core** (browser-first), providing a `shell` `Surface` whose `execute` runs a subprocess. The security model is non-negotiable and **structural, not advisory** (the bar that rejected host-inferred bearer tokens in #6):

    -   **Static executable.** The binary is fixed in the stitch config at construction (`shell.stitch({ command: 'git' })`), **never** taken from call input — as a credential is bound at construction, not passed by the caller.
    -   **`argv` is an ARRAY, never a string.** Arguments are a `string[]` passed as the `args` array to `child_process.execFile`/`spawn`. There is **no shell**: no `shell: true`, no `/bin/sh -c`, so shell metacharacters (`;` `|` `$()` `` ` `` `>` `*`) are **inert data**. Command injection is not "mitigated by escaping" — it is **structurally impossible**, because no string is ever handed to a shell to parse.
    -   **No interpolation, ever.** Each `argv` element is one process argument, verbatim. An `input` schema (`z.array(z.string())`, or an enum of allowed flags) can _further_ constrain values, but the array boundary is the guarantee, not the schema.
    -   **Fail-closed env** (resolves Q3). The subprocess inherits **no** `process.env` by default — you pass exactly the vars it needs, so a secret in the parent environment can't leak into a child. A **bin allowlist is deferred** (the executable is already static per stitch — Q3); it can be added at the seam level later as defense-in-depth.
    -   **Timeout + cancellation come free** from the resilience chain (the per-attempt `timeout` and caller `signal` reach `execute`, which forwards them to `execFile`) — the concrete payoff of Decision 1.
    -   A non-zero exit maps to `status >= 400` (a `StitchError`, or a normal result via `acceptStatus`); `stdout` is the body (parsed per `responseType`), `stderr` rides the error. The `argv` travels in `req.body` (Decision 1).

5.  **`pipe()` — a `stitchapi/pipe` subpath; linear, each step a child run** (resolves Q4). `pipe(stepA, stepB, …)` runs steps in order, feeding each result to the next. Each step runs under a `RunContext` (ADR 0007) that is a **child of the previous step's** — the first step is the root run, step N is a child of step N-1 — so the trace/DAG shows the chain `stepA → stepB → stepC`, the step-to-step data dependency drawn as causality. There is **no separate `pipe` span**: the pipeline _is_ its chain of step runs, sharing one `traceId`; the first step's run is the chain's root. It ships behind its **own `stitchapi/pipe` subpath** (bundle-frugal, like cache/graphql), so `import { stitch }` stays lean. v1 is **linear** (fan-out/DAG deferred); the step-to-step **mapping** is a closure (`(prev) => nextCallInput`), acknowledged non-serializable **sugar** in the exact category as `transform`/`paginate.next`/`cache.key`, while the pipe's **structure** (its ordered member stitches, each of which round-trips) does serialize — so the contract gate holds at the line the library already draws. Fail-fast on the first step error (the `StitchError` becomes the pipe run's error; `.safe()` works as usual).

6.  **Build #7 as one push, single review, after 0007 lands** (resolves Q5). Implementation order within that one feature: the `execute?` hook + engine wiring → `llm` preset (the `LlmProvider` contract + Anthropic/OpenAI mappings) → `@stitchapi/shell` peer package + its security suite → `pipe()` (on ADR 0007's run identity) → docs. It is a large surface (a core hook + two subpaths + a new peer package), delivered and reviewed together rather than staged — `pipe()` is the only part that hard-blocks on 0007.

## Resolved questions

-   **Q1 — `execute` request carrier (resolved: reuse `req.body`).** Surface-specific request data rides `req.body`, the `graphqlSurface` precedent — zero core-contract change, no new field on `AdapterRequest`/`StitchInput`.
-   **Q2 — `llm` providers (resolved: contract-first + first-party mappings + override).** An `LlmProvider` mapping contract is the primitive; StitchAPI ships first-party Anthropic + OpenAI mappings (plain config, no SDK dep) implementing it; a customer can always override with their own. See Decision 3.
-   **Q3 — `shell` env/cwd (resolved: fail-closed env; allowlist deferred).** No inherited `process.env` by default; the static-per-stitch bin makes a v1 allowlist unnecessary (deferrable to a later seam-level option).
-   **Q4 — `pipe()` placement & shape (resolved: `stitchapi/pipe` subpath, linear v1).** Own subpath (bundle-frugal); linear sequence; mapping closures as acknowledged sugar; fan-out/DAG deferred.
-   **Q5 — Staging (resolved: one push, single review).** The execute-hook → llm → shell → pipe sequence is built together and reviewed once, after 0007 lands.

## Consequences

-   The surface model gains a fourth verb (`execute`) alongside `buildRequest`/`interpret`/`stream`, and "all common comms in one lib" extends past HTTP to subprocesses and LLMs — without a second resilience implementation, because everything still flows through the one chain.
-   `shell` is the first capability that is **deliberately not browser-safe**; it is quarantined in a peer package so core stays browser-first and `import { stitch }` pulls in no `child_process`.
-   `llm` proves the contract-not-dependency pattern a third time (after fingerprint and adapter): a vendor capability becomes a BYO contract with first-party conveniences, never a hard dependency.
-   `pipe()` is the first multi-run composition and the consumer that makes ADR 0007's parent/child identity pay off — the first place a trace spans more than one run (a linear chain of step runs under one `traceId`).
-   New surface area: one optional hook on `Surface`, one engine call-site change (+ guard bypass), the `stitchapi/llm` subpath (contract + two mappings), the `@stitchapi/shell` peer package, and the `stitchapi/pipe` subpath.

## Alternatives considered

-   **Make `shell` a user `adapter` instead of a surface `execute`.** Rejected: `adapter` is the user's HTTP-client slot; overloading it conflates "which HTTP client" with "which protocol", loses the one-import `shell.stitch({…})` bundling, and muddies redaction.
-   **A shell _string_ with escaping/quoting.** Rejected outright: escaping is advisory and one missed quote is RCE. The argv-array + no-shell rule makes injection structurally impossible — the same "don't rely on getting the dangerous path right" stance as the `inferBearer` rejection.
-   **Ship an LLM SDK (or hardcode one provider) in core.** Rejected: violates browser-first/bundle-frugal and pins a vendor dep. The `LlmProvider` contract + first-party plain-config mappings give turn-key Anthropic/OpenAI with neither a dependency nor provider lock-in.
-   **`AsyncLocalStorage` to thread `pipe()` step identity.** Rejected: Node-only, breaks browser-first; ADR 0007's explicit `RunContext` threading is portable.

## Gates

-   **browser-first** — `execute` is a plain function field on `Surface`; `llm` is HTTP with plain-config mappings; `shell` is a **Node-only peer package** core never imports, so `child_process` never reaches a browser bundle (guarded by the existing `browser-bundle.spec` matrix).
-   **bundle-frugal** — `execute` adds one optional field; `llm`/`pipe` are subpath-exported; `shell` is out-of-core entirely. `import { stitch }` pulls none of it.
-   **contract-not-dependency** — the surface `id` round-trips as JSON (the live `execute`/provider hooks are redacted like every surface); the `LlmProvider` mapping and the shell command are BYO config, not vendor deps.
-   **security (shell)** — injection is **structurally impossible** (static bin + argv array + no shell + no interpolation), not escaped; secrets do not leak to subprocesses (fail-closed env); timeout/cancel are enforced by the resilience chain.
