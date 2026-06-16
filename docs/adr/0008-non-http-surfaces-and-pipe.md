# ADR 0008 — Non-HTTP surfaces (`llm`, `shell`) & the `pipe()` primitive

-   **Status:** Proposed (DRAFT — pending review; no code yet)
-   **Date:** 2026-06-16
-   **Tags:** surfaces, transport, llm, shell, composition, pipe, security, browser-first, peer-dependency

> [!NOTE]
>
> A **design draft to review before any code** — roadmap item #7. It depends on [ADR 0007](./0007-composition-causality-and-run-identity.md) (#5a): `pipe()` makes each step a child run, so run identity lands first. The shell surface's security model is the load-bearing decision and the part I most want signed off — it follows the same "structural, not advisory" bar that rejected `inferBearer` in #6.

## Context

A `Surface` ([ADR 0005](./0005-surfaces-and-the-authoring-model.md), [`surface.ts`](../../packages/core/src/surface.ts)) shapes a request **around a mandatory HTTP call**: `buildRequest` patches the engine's built `AdapterRequest`, `interpret` reads the buffered `AdapterResponse`, `stream` decodes a live body — but the call itself is always `rt.adapter(req)` ([`engine.ts`](../../packages/core/src/engine.ts) `attemptLoop`), i.e. HTTP over fetch/axios/xhr. There is no way for a surface to **replace the transport**. So two kinds of call the roadmap wants — an **LLM** call and a **shell** command — have no home: the LLM is HTTP (it fits today, just needs a preset), but a shell command is not HTTP at all.

The thing a non-HTTP kind must NOT lose is the **resilience chain**: `retry` → `throttle` → `circuit` → per-attempt `timeout`/`signal` → `auth`/`hooks` → `trace`, all of which live in `attemptLoop`/`attemptWithCircuit`/`runFrom` and wrap the single `rt.adapter(req)` call. If a non-HTTP transport ran _outside_ that chain it would silently lose retry, throttling, breaker, timeout, cancellation, and tracing. So the transport-replacing hook must be called at **exactly** the adapter call site, inside the chain.

`pipe()` — chaining calls so one's output feeds the next — is the third piece. It is composition, and each step is logically a sub-call of the pipe, which is exactly the parent/child run relation ADR 0007 introduces. That coupling is why 0007 is foundational and lands first.

## Decision (proposed — to firm up before coding)

1.  **A transport-replacing `Surface.execute?` hook, called inside the resilience chain.** Add `execute?: Adapter` to `Surface` (same `(req: AdapterRequest) => Promise<AdapterResponse>` shape the engine already speaks). At the adapter call site the engine picks `cfg.kind?.execute ?? rt.adapter`, still wrapped by `withTimeout` and the per-attempt `signal` — so retry/throttle/circuit/timeout/trace/auth/hooks apply **uniformly and unchanged**. A surface with `execute` is a custom transport, so the engine **bypasses the absolute-URL guard** for it (just as it does today when `cfg.adapter` is set). The surface owns its wire shape end to end: its `buildRequest` packs whatever the transport needs, its `execute` runs it and returns an `AdapterResponse`, its `interpret` maps that to a value — after which `transform`/`unwrap`/`output`/drift/cache all run as usual.

2.  **`execute` is bound to the surface; `adapter` stays the user's HTTP client.** `cfg.adapter` is the **BYO HTTP transport** (axios/xhr/fetch — one slot, last-writer-wins). `Surface.execute` is **the protocol's own transport**, selected by `kind` and bundled with the surface's `buildRequest`/`interpret` as one identity. A shell surface must not usurp the user's choice of HTTP client, and `shell.stitch({…})` should wire all three hooks from one import. They never collide: a surface with `execute` ignores `adapter` (it is not making an HTTP call).

3.  **`llm` is an HTTP preset — no `execute` hook.** An LLM call _is_ HTTP, so `llm` proves the model from the other side: it is a `buildRequest` (map a normalised `{ model, messages, … }` input onto the provider's request body + `POST`) + `interpret` (lift the completion + usage out of the response) preset over the **http** surface, with bearer `auth`, `retry`, `throttle`, and (later) the shipped `sse`/`stream` surfaces for token streaming all applying for free. Core takes **no LLM SDK dependency**: the provider request/response mapping is BYO config (contract-not-dependency), so a provider is a plain config object, not an `npm` dep. (Which providers ship as built-in mappings is **Q2**.)

4.  **`shell` is a Node-only, security-gated peer package — injection-proof by construction.** It ships as `@stitchapi/shell` (a peer package like `@stitchapi/nest`), **never imported by core** (browser-first), providing a `shell` `Surface` whose `execute` runs a subprocess. The security model is non-negotiable and **structural, not advisory** (the bar that rejected host-inferred bearer tokens in #6):

    -   **Static executable.** The binary is fixed in the stitch config at construction (`shell.stitch({ command: 'git' })`), **never** taken from call input — exactly as a credential is bound at construction, not passed by the caller.
    -   **`argv` is an ARRAY, never a string.** Arguments are a `string[]` passed as the `args` array to `child_process.execFile`/`spawn`. There is **no shell**: no `shell: true`, no `/bin/sh -c`, so shell metacharacters (`;` `|` `$()` `` ` `` `>` `*`) are **inert data**, never interpreted. Command injection is not "mitigated by escaping" — it is **structurally impossible**, because no string is ever handed to a shell to parse.
    -   **No interpolation, ever.** The surface never builds a command line by substitution; each `argv` element is one process argument, verbatim. An `input` schema (`z.array(z.string())`, or an enum of allowed flags) can _further_ constrain values, but the array boundary is the security guarantee, not the schema.
    -   **Env/cwd are explicit and fail-closed by default** (the subprocess does not inherit the parent's full environment, so a secret in `process.env` can't leak into a child — **Q3**).
    -   **Timeout + cancellation come free** from the resilience chain (the per-attempt `timeout` and caller `signal` reach `execute`, which forwards them to `execFile`) — the concrete payoff of putting `execute` _inside_ the chain (Decision 1).
    -   A non-zero exit maps to `status >= 400` (a `StitchError`, or a normal result via `acceptStatus`); `stdout` is the body (parsed per `responseType`), `stderr` rides the error. The `argv` travels in `req.body` — the same precedent as `graphqlSurface` packing `{ query, variables }` into `body` — so no core `AdapterRequest`/`StitchInput` field is added for a peer-package surface (**Q1**).

5.  **`pipe()` — linear composition, each step a child run.** `pipe(stepA, stepB, …)` runs steps in order, feeding each result to the next, and is itself one run whose `RunContext` (ADR 0007) is the **parent** of each step's run — so the trace/DAG shows `pipe → stepA → stepB` edges. v1 is **linear** (a sequence); fan-out/DAG composition is future. The step-to-step **mapping** is a closure (`(prev) => nextCallInput`) and is acknowledged non-serializable **sugar**, in the exact category as `transform` / `paginate.next` / `cache.key`; the pipe's **structure** (the ordered member stitches, each of which round-trips) does serialize, so the contract gate holds at the "structure round-trips, mapping is sugar" line the library already draws. Fail-fast on the first step error (the `StitchError` becomes the pipe run's error; `.safe()` works as usual).

6.  **Staged rollout, one reviewable PR each, stop between** (the ADR 0005 cadence): **(0)** this ADR → **(1)** the `execute?` hook + engine wiring + a test surface → **(2)** `llm` preset (core/subpath, HTTP) → **(3)** `@stitchapi/shell` peer package + the security suite → **(4)** `pipe()` (on top of ADR 0007's run identity) → **(5)** docs. Each stage is independently shippable; (4) blocks on 0007 being implemented.

## Consequences

-   The surface model gains a fourth verb (`execute`) alongside `buildRequest`/`interpret`/`stream`, and "all common comms in one lib" extends past HTTP to subprocesses and LLMs — without a second resilience implementation, because everything still flows through the one chain.
-   `shell` is the first capability that is **deliberately not browser-safe**; it is quarantined in a peer package so core stays browser-first and `import { stitch }` pulls in no `child_process`.
-   `pipe()` is the first multi-run composition; it is the consumer that makes ADR 0007's parent/child identity pay off, and the first place a trace is a genuine tree rather than a list.
-   New surface area is small: one optional hook on `Surface`, one engine call-site change (+ guard bypass), one preset, one peer package, one composition helper.

## Open questions (where I want to stop for your input)

-   **Q1 — `execute` request carrier.** Reuse `req.body` for surface-specific request data (the `graphqlSurface` precedent — zero core change), or add a typed, surface-namespaced slot to `AdapterRequest`? I recommend reuse-`body`.
-   **Q2 — `llm` providers.** Ship a couple of built-in provider mappings (e.g. Anthropic Messages / OpenAI chat) as **plain config objects, no SDK dep**, or keep `llm` a pure BYO-mapping preset and let providers live in docs/recipes? And does `llm` warrant its own subpath/package or sit in core (it is just HTTP)?
-   **Q3 — `shell` env/cwd policy.** Fail-closed by default (empty/explicit env, explicit cwd — my lean, matching the security posture) vs. inherit `process.env`/`cwd` for convenience? An optional bin **allowlist** at the seam level — in v1 or later?
-   **Q4 — `pipe()` placement & shape.** Core vs. a `stitchapi/pipe` subpath (bundle-frugal)? Confirm **linear-only** v1 with mapping closures as acknowledged sugar (fan-out/DAG deferred)?
-   **Q5 — Staging.** Is the 6-stage split right, and do you want each stage to **stop for review** as ADR 0005 did, or run (1)–(4) as one feature once the design is signed off?

## Alternatives considered

-   **Make `shell` a user `adapter` instead of a surface `execute`.** Rejected: `adapter` is the user's HTTP-client slot; overloading it for subprocesses conflates "which HTTP client" with "which protocol", loses the one-import `shell.stitch({…})` bundling of buildRequest/interpret, and muddies redaction. `execute` keeps transport replacement a surface concern.
-   **A shell _string_ with escaping/quoting.** Rejected outright: escaping is advisory and a single missed quote is RCE. The argv-array + no-shell rule makes injection structurally impossible — the same "don't rely on getting the dangerous path right" stance as the `inferBearer` rejection.
-   **`AsyncLocalStorage` to thread `pipe()` step identity.** Rejected: Node-only, breaks browser-first; ADR 0007's explicit `RunContext` threading is portable.
-   **Bundle an LLM SDK / shell helpers into core.** Rejected: violates browser-first and bundle-frugal and pins vendor deps; BYO mapping (llm) + a peer package (shell) keep core clean.

## Gates

-   **browser-first** — `execute` is a plain function field on `Surface`; `llm` is HTTP; `shell` is a **Node-only peer package** core never imports, so `child_process` never reaches a browser bundle (guarded by the existing `browser-bundle.spec` matrix).
-   **bundle-frugal** — `execute` adds one optional field; `llm`/`pipe` are core-subpath/opt-in; `shell` is out-of-core entirely. `import { stitch }` pulls none of it.
-   **contract-not-dependency** — the surface `id` round-trips as JSON (the live `execute` hook is redacted like every surface, Decision 11 of ADR 0005); `llm` provider mappings and the shell command are BYO config, not vendor deps.
-   **security (shell)** — injection is **structurally impossible** (static bin + argv array + no shell + no interpolation), not escaped; secrets do not leak to subprocesses (fail-closed env); timeout/cancel are enforced by the resilience chain.
