# StitchAPI — Feature Ideas

> The backlog of **forward-looking feature ideas** — things we might build, captured before
> they're committed. This is upstream of [`OVERVIEW.md`](OVERVIEW.md) §10 (the _sequenced_
> roadmap): an idea lives here while it's still a sketch, and **graduates to the §10 roadmap**
> when we commit to building it. Keep entries honest about status; an idea is not a promise.
> Working draft · 2026-06.

Every idea must answer the same questions, so they stay comparable and we never lose the
"why." Use the template below.

```markdown
## <Idea name>

-   **Status:** idea | exploring | accepted → §10
-   **Date:** YYYY-MM
-   **Tags:** …
-   **Gates:** browser-first? · bundle-frugal? (the two gates — FEATURE-LENSES)

**Problem / why** — what's painful or missing today.
**Sketch** — what it is, concretely.
**Backed by / builds on** — existing primitives it reuses.
**Open questions** — what we'd need to resolve before committing.
```

---

## Studio — the visual surface

-   **Status:** idea
-   **Date:** 2026-06
-   **Tags:** surface, visual, authoring, observability, DX
-   **Gates:** browser-first ✅ (it _is_ the FE surface) · bundle-frugal — must not pull weight
    into the core import; ships as its own surface, not bundled into `stitch()`.

**Problem / why** — Two pains share one missing surface. (1) You can't _see_ what a stitch is
doing — traces, drift, and health are JSONL today, not a picture. (2) Authoring a stitch still
means hand-writing the validation shape, even though the spec-less promise is "one example."

**Sketch** — A browser app with two halves over the same runtime:

-   **Inspect** — see what's happening: live trace overlay, drift/health signals, and
    Mermaid-from-definition (git-friendly) for any stitch. _(This supersedes and expands the
    §10 "Visual" roadmap line.)_
-   **Author from a request** — fire a real call, **infer the validation shape** from the
    response, and emit copy-paste `stitch({...})` code. The spec-less "one example" promise
    (OVERVIEW §1, §5.1) made visual: request → inferred schema → ready-to-paste stitch, no
    hand-written types.

**Backed by / builds on** — the event stream (trace overlay), leveled drift (health signals),
the existing playground/sandbox surface, and Standard-Schema validation (the inferred shape
emits as Zod/Valibot/ArkType).

**Open questions** — Where does it run (docs-site embed vs standalone vs CLI-served local)?
How is the inferred schema kept honest as the API drifts — does Studio round-trip into a drift
snapshot? How much of the inspect half is just the planned trace overlay vs net-new?

---

## `seam` — a primitive stitches belong to

-   **Status:** exploring → see [`adr/0002`](adr/0002-seam-primitive-and-principal-scoped-auth.md)
-   **Date:** 2026-06
-   **Tags:** authoring-surface, auth, security, multi-tenant, agents, runtime
-   **Gates:** browser-first — must hold without an OS keychain (vault default = memory/opaque
    in-browser); principal binding + sealing are pure runtime, no lint. · bundle-frugal —
    reuses `extends`/store keying/sink flush; avoid a _second mandatory_ storage backend.

**Problem / why** — Shared defaults (baseUrl, throttle, retry, sink) get threaded into every
`stitch()` by hand; `defineStitch` shares **config** but not **runtime**, so "this third-party
API has one global limit across all my calls" needs a shared `store` passed everywhere — the
same boilerplate, error-prone to forget. Deeper: on a long-lived shared surface, `cookieSession`
mints a per-login session into the shared store keyed by **cookie name, not principal**, so user
A's session can be served to user B (bleed); the live store is also reachable via public
`__config` (exfil-at-rest) and the cookie lands in traces (exfil-at-use).

**Sketch** — A long-lived **entity** (not a factory) that owns a shared fragment, shared runtime
(`store` + sink), and a registry/lifecycle (`flush`/`close`). Its decisive job: the **trusted
principal boundary** — `const userApi = seam.as(req.user.id)` binds identity in the closure, so
the agent/caller can never name another principal (the principal is **never** in `StitchInput`).
Auth/session is principal-scoped; throttle/circuit stay host/app-scoped (separate sessions, one
shared bucket). Storage splits into `store` (sharable, inspectable) and a `vault` namespace
(off `__config`, redacted from traces, read only by auth strategies, keyed by scope) — split by
**visibility, not backend**; both can be distributed. Per-stitch overrides may only **tighten** a
shared budget, never escape. `defineStitch` retires; raw `stitch()` stays as the standalone peer.

**Backed by / builds on** — `extends`/`flatten` composition, `createStoreThrottle` store keying,
the `AuthStrategy` + `StitchStore` contracts, trace-sink `flush()`. Net-new is mostly plumbing.

**Open questions** — Threading a principal into `AuthContext` on a path `StitchInput` **can't**
write to (forgery is the whole risk); making `cookieSession.key`/`oauth2.key` principal-aware
(static strings today); throttle **chaining** for tighten-only; `StitchStore.close()` + vault
TTL/eviction (per-principal in-memory grows unbounded); `__config` redaction; nested-seam
teardown order + GC. Dropped along the way: request dedup, abandoned-request cancellation, a
`strict` boolean, and ESLint-based enforcement (see ADR 0002 §7).

---

## response cache & request coalescing — derived keys

-   **Status:** exploring → see [`adr/0003`](adr/0003-derived-key-response-cache-and-coalescing.md)
-   **Date:** 2026-06
-   **Tags:** caching, performance, resilience, multi-tenant, agents, runtime
-   **Gates:** browser-first — sync browser-safe body hash, no `node:*`; uncacheable (stream)
    calls warn-and-pass-through, never crash. · bundle-frugal — subpath export, off until a
    `cache` block exists; reuses the `StitchStore` `get/set/incr` contract, grows no new backend.
    · declarative — `cache: { ttl, scope, vary?, methods?, maxEntries? }` round-trips as JSON;
    `key()` is sugar over the derived default.

**Problem / why** — "two calls with the same key and variables should resolve to the same
response," modelled on react-query — but react-query is a **UI-bound** cache above the transport
(needs a retained `QueryClient` + reactive tree). A stitch runs where react-query cannot (agents,
CLI, server), and — unlike react-query — it can **derive** the key from the request itself, so the
caller never authors (and never mis-authors) one. This also revives the **request coalescing** ADR
0002 §7 dropped for the cross-principal hazard, now safe because the principal folds into the key.

**Sketch** — Opaque **derived** key (method + URL + canonicalised body/GraphQL variables + vary
headers + principal), **exact-match only** (no hierarchy). Cache only **validated** responses;
hits skip re-validation. **Principal-scoped, fail-closed**; `scope: 'app'` opts into sharing.
**Coalescing** is full cross-process via an `incr`-based lease lock — retries serialised, failures
not shared, aborts ref-counted. Placement is **outermost** (a hit short-circuits
throttle/circuit/network). **Invalidation**: exact = `set(key, undefined)` delete; bulk =
generation-counter bump (no enumeration). LRU/max-entries live in the **cache layer**. Works on a
bare `stitch()`; the seam just provisions the shared store. Subpath export, off by default.

**Backed by / builds on** — `StitchStore` `get/set/incr` + TTL, ADR 0002 principal-keying, the
shared-store-makes-it-distributed pattern (throttle/circuit), the trace event stream, output
validation + drift. Net-new runtime dependency count stays zero.

**Open questions** — Freeze + version the key-derivation algorithm (shared store outlives a
deploy); pick a sync browser-safe body hash + collision stance (oversized/stream bodies
warn-and-skip); the cross-process lock protocol (lease TTL, poll backoff, leader-finished-without-
cache signal); GraphQL query-vs-mutation opt-in classification; conformance-kit addendum for
`incr`-as-lock correctness; `__config`/trace redaction of cached values + lock keys (extends ADR
0002 §6). Dropped: hierarchy, SWR/background refresh, mutation-driven cross-stitch invalidation
(= app-level cache policy, out of scope — see ADR 0003 §12).

---

## Playground trace DAG — `extends` derivation overlay

-   **Status:** idea
-   **Date:** 2026-06
-   **Tags:** playground, visual, observability, DX, trace
-   **Gates:** browser-first ✅ (renders client-side in the existing playground; mermaid is
    lazy-loaded, off the SSR / initial-bundle path) · bundle-frugal — stays inside the
    `docs/sandbox` playground surface, never pulled into the core `stitch()` import.

**Problem / why** — The playground DAG now renders one node per executed `stitch()` call
(labelled `METHOD /path`, or `$ command` for a `shell` surface), **with real edges**: ADR 0007's
run-identity span tree means a child run carries its parent's id, so the collector draws true
**runtime-causality** edges — a `cookieSession` login → the call that triggered it, a `pipe()`
`stepA → stepB → stepC` chain — plus per-iteration annotations (`↻` retries, `⊞` pages). What the
DAG still **cannot** show is the **static `extends` derivation** — _which fragment a stitch was
composed from_. That is a different axis the runtime collector can't see (ADR 0007 Q4 scoped it
out), so siblings derived from one base still appear as independent call nodes.

**Sketch** — A derivation **overlay**: render the `extends` tree alongside (or as a toggle on) the
runtime-causality DAG — `api → getUser`, `api → listNames`, `api → flaky`, … — the structural
relationship a config-object author expresses. Base stitches never called directly still appear as
parent nodes; the `METHOD /path` labels stay on the leaf (call) nodes. A distinct edge style keeps
derivation edges visually separate from the runtime-causality edges this PR already draws.

**Backed by / builds on** — the shipped client-side Mermaid rendering + `traceToMermaid`
(`component/output-format.ts`) and the now-real `StitchTraceEntry.dependsOn` causality edges. Net-new
is surfacing the **static** derivation relationship (which fragment, via `extends`/`flatten`), which
the runtime trace deliberately does not carry.

**Open questions** — Where does the derivation graph come from — does `stitch()`/`seam` emit parent
identity statically, or is it inferred from the snippet AST? Do base (never-called) stitches get
nodes, and how are they de-duped across calls? Overlay vs. toggle vs. a separate panel relative to
the runtime-causality edges? (Down-payment on the Studio "Mermaid-from-definition" line; see the
`docs/sandbox` A2 trace follow-up noted in `RELEASE.md`.)
