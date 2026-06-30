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

---

## Frontend reactive bindings — Vue · Svelte · Solid

-   **Status:** idea
-   **Date:** 2026-06
-   **Tags:** integration, frontend, reactivity, streaming, DX
-   **Gates:** browser-first ✅ (it _is_ a FE surface) · bundle-frugal ✅ — a thin per-framework
    binding over the shared `@stitchapi/query-core`, never a re-implementation.

**Problem / why** — `@stitchapi/react` (shipped) gives `useStitch`/`useStitchStream` over a
framework-agnostic reactive store. React is ~45% of the market, but Vue/Svelte/Solid users have no
first-party binding — and the streaming-first story (re-render as `delta` chunks arrive) is exactly
where each framework's native fine-grained reactivity shines.

**Sketch** — One ~100-line binding per framework over the same `createStitchQuery`
`subscribe`/`getSnapshot` store: a Vue composable (`shallowRef` + `onScopeDispose`), a Svelte 5
`$state`/`$derived` rune (readable store for Svelte 4), a Solid `createResource`-style signal. The
same `queryOptions` POJO helper so each composes with its TanStack `*-query` adapter. Astro is **not**
a separate target — you use these as islands inside Astro, so it's covered for free.

**Backed by / builds on** — the just-shipped `@stitchapi/query-core` (the keystone — designed so these
are cheap follow-ons; PR #189) and the SSE/stream surfaces (ADR 0005). Mirrors TanStack Query's own
shared-core + per-framework-binding model.

**Open questions** — One package each (`@stitchapi/vue`, …) or a single `@stitchapi/query-*` family?
SSR/hydration story per meta-framework (Nuxt / SvelteKit / SolidStart)? Ship the TanStack adapter per
framework, or leave it to the POJO `queryOptions`?

---

## Edge-KV stores — Upstash · Cloudflare KV · Deno KV

-   **Status:** idea
-   **Date:** 2026-06
-   **Tags:** integration, storage, edge, StitchStore
-   **Gates:** browser-first ✅ (HTTP / Web-API drivers, edge-safe) · bundle-frugal ✅ — a peer-dep
    package implementing the existing `StitchStore` contract, zero core change.

**Problem / why** — `@stitchapi/redis` makes "two workers share one login + rate budget"
demonstrable, but it's Node/TCP. The edge story (Workers / Deno / Vercel + `@stitchapi/hono`) needs an
HTTP/Web-API-native store so distributed throttle + shared sessions/cache work where there is no TCP
socket. "Edge caching is eating Redis's lunch" — Upstash (HTTP Redis), Cloudflare Workers KV, Deno KV.

**Sketch** — Thin `StitchStore` implementations (`get`/`set`/`incr`/`close?`) over each driver, same
shape as `@stitchapi/redis`: `upstashStore(redis)` (Redis-command-compatible — `incr` is atomic),
`cloudflareKvStore(KVNamespace)` (CF-KV has **no atomic `incr`** → rate-limiting needs Durable Objects;
document the gap or expose a DO-backed variant), `denoKvStore(kv)` (atomic ops available). Each ships
against the `stitchapi/testing` store conformance kit.

**Backed by / builds on** — the `StitchStore` contract (`types.ts`), the `@stitchapi/redis` skeleton
(driver-adapter + conformance pattern), and `@stitchapi/hono` (the edge backend they pair with).

**Open questions** — `@stitchapi/redis` already takes any Redis-shaped driver — does Upstash just need
a `fromUpstash` adapter there, or a dedicated package? How to expose the CF-KV `incr` gap without a
footgun? **Postgres-as-KV is explicitly rejected** — KV-on-RDBMS is an anti-pattern and Redis already
covers the `StitchStore` contract; it is not the storage gap worth filling.

---

## More backend adapters — Express · Elysia

-   **Status:** idea
-   **Date:** 2026-06
-   **Tags:** integration, backend, seam, lifecycle
-   **Gates:** browser-first n/a (a companion inherits its **host's** environment — the browser-first
    gate binds _core_ only; Node/Bun is fine here) · bundle-frugal ✅.

**Problem / why** — Nest (DI), Fastify (plugin), and Hono (edge) are shipped. Express still has the
largest install base (mostly legacy); Bun-native Elysia is rising. Neither has a first-party seam
binding, so users hand-wire lifecycle + per-request principal + SSE today.

**Sketch** — Express: a thin `stitch()` middleware attaching a request-scoped `seam.as(principal)` to
`req`, plus an SSE helper and an error-mapping middleware — shallower than Fastify (Express has no
plugin/lifecycle/logger structure to bridge), so a small, broad-reach add. Elysia: a plugin over its
`decorate`/`derive` + lifecycle hooks, closer to the Fastify shape. The five backend concerns
(lifecycle · principal · SSE→response · logger · error→HTTP) are identical across all of them — a tiny
shared helper would make each new framework cheap.

**Backed by / builds on** — the `seam` primitive and the shipped `@stitchapi/nest` /
`@stitchapi/fastify` / `@stitchapi/hono` (copy their lifecycle + `seam.as` + SSE-bridge patterns).

**Open questions** — Is Express worth a first-party package given how thin the bridge is, or better as
a docs recipe? Extract the shared backend helper now, or after a 4th framework proves the pattern?
Elysia priority vs. waiting for a clearer Bun-server adoption signal?

---

## Parallel composition — `all` · `any` · `race`

-   **Status:** IMPLEMENTED + green (2026-06, in branch — not yet released). `all`/`any`/`race` in
    `packages/core/src/pipe.ts` (subpath `stitchapi/pipe`), returning the shared `Composable` so they
    NEST. `all` takes EITHER a named object (→ named result, merges into a pipe `ctx`) OR a positional
    array (→ a `readonly` tuple, the `Promise.all` shape) — additive overloads, `const` type param for
    tuple inference. Decisions baked in: **no `allSettled`** (no separate combinator, no flag on `all` — for
    best-effort, compose `.safe()` members by hand); **auto-cancel** losers via a per-group
    `AbortSignal` (`all` aborts siblings on first failure, `any` on first success, `race` on first
    settle); the pipe builder gains an **inline parallel bag** `.step({ k: node })` that merges keys
    into `ctx`. Tests: `test/combinators.spec.ts` + `test-d/combinators.test-d.ts`
    (tsc/eslint/tsd/1110 unit/bundle-size all pass). Article: blog `compose-pipe-all-any-race`.
-   **Date:** 2026-06
-   **Tags:** composition, pipe, parallel, subpath
-   **Gates:** browser-first ✅ (just `Promise.all`/`race`/`any` over child runs) · bundle-frugal ✅
    (reached only through a composition subpath, like `stitchapi/pipe`) · contract-not-dependency ✅
    (members are an ordered/named list of stitches that round-trips — arguably _cleaner_ than `pipe`,
    which leans on per-step `input` closures).

**Problem / why** — `pipe` (ADR 0008) composes **dependent** calls: step N+1's input is derived from
step N's result, so it must run sequentially. The complement — **independent** calls you want to run
**concurrently** — has no primitive today. "Fetch the user, their settings, and their feature flags at
once" forces users back to a hand-rolled `Promise.all`, which drops the run-identity/trace story and
the typed-result shape that `pipe` gives a dependent chain.

**Sketch** — a parallel family living alongside `pipe`:

-   **`all`** — run independent stitches concurrently, resolve when all succeed, fail fast on the first
    rejection (`Promise.all` semantics). Members are **sibling child runs of one parent** (ADR 0007
    `parentId` already models fan-out), so the trace/DAG draws a fan instead of a line. Proposed shape
    favours a **named object** over a tuple for ergonomics + JSON-friendliness:
    `all({ user: fetchUser, settings: fetchSettings })` → `(input) => Promise<{ user, settings }>`.
    This is the high-value one and composes inside `pipe` (a pipe step could be an `all`).
-   **`any`** — first to **succeed** wins; collect failures into an `AggregateError` if all fail
    (`Promise.any`). Use case: cross-_provider_ **failover** (primary → mirror). Distinct from a
    stitch's built-in retry (which re-hits the _same_ endpoint), so it earns its place — but lower
    demand than `all`.
-   **`race`** — first to **settle** (resolve _or_ reject) wins (`Promise.race`). Use case: hedged /
    fastest-mirror requests. Least justified: a power-user trick that doubles load and overlaps the
    resilience each stitch already owns.

**Recommendation** — build **`all` first**; design `any`/`race` as a follow-on "first-wins" family
only if real demand appears, with `any` the more defensible of the two.

**Backed by / builds on** — the `pipe` subpath (`packages/core/src/pipe.ts`) for the combinator +
child-run pattern (`__runWith` / `newRunContext`), and ADR 0007 run identity for the sibling-fan trace.

**Open questions** — Named-object vs. tuple results (lean named). How does each member receive input —
the shared pipe input verbatim, or a per-member mapper from it? One subpath (`stitchapi/parallel`) for
the whole family or one per combinator? Does `any`'s failover overlap enough with per-stitch retry to
defer it indefinitely?

---

## Nestable composition — combinators that compose, not a `compose` keyword

-   **Status:** IMPLEMENTED + green (2026-06, in branch) — the `Composable` contract + child-run
    nesting shipped with the parallel family above (combinators and pipe steps both run via `__runWith`
    under a supplied run); a `pipe` step accepts any `Node` (stitch or combinator), and an inline
    `{ k: node }` step is the pipe-native parallel fan. No top-level `compose` keyword (as designed).
-   **Date:** 2026-06
-   **Tags:** composition, pipe, parallel, algebra, contract-not-dependency
-   **Gates:** browser-first ✅ · bundle-frugal ✅ (one shared composable contract, reached through the
    composition subpaths) · contract-not-dependency ⚠️ — **this is where the idea lives or dies** (see
    open questions): the _tree of nodes_ round-trips as JSON; the per-edge input mappers stay the same
    acknowledged sugar as `pipe` today.

**Problem / why** — Real flows mix sequential and parallel: fetch the order, then **in parallel** its
shipment + invoice, then sequentially the tracking for the shipment. Today `pipe` steps must be
**stitches** — it casts each step to `__runWith` (`pipe.ts`) — and a nested `pipe(...)` / `all(...)`
returns a plain `(input) => Promise`, which is _not_ a stitch. So the combinators **don't nest**, and
you can't express a mixed flow as one traced value. That's the actual gap behind "a `compose` that
mixes `all`/`race`/`any`/`pipe` in one pipeline."

**Sketch** — the answer is **not** a new top-level `compose` keyword (that drifts toward a workflow
DSL, which StitchAPI explicitly is not — see the [runtime-stitching-vs-workflow-platforms] post).
Instead, give every combinator a **shared `Composable` contract** so composition is just **nesting**:

-   A `Composable` is a callable `(input?) => Promise<Out>` that _also_ carries the child-run protocol
    (`__runWith` / `newRunContext`) **and** a serialisable structure descriptor (`{ kind, members }`).
    A `stitch` is the leaf; `pipe` / `all` / `any` / `race` are nodes; **any node can hold any node.**
-   Then this Just Works, no new primitive — composition = nesting an algebra of stitches:

    ```ts
    const flow = pipe(
        fetchOrder,
        all({
            shipment: { stitch: fetchShipment, input: (o) => ... },
            invoice: { stitch: fetchInvoice, input: (o) => ... },
        }),
        { stitch: fetchTracking, input: ({ shipment }) => ... },
    );
    ```

-   The trace/DAG falls out for free: the tree of nodes maps onto ADR 0007 run identity (sequential =
    parent→child line, parallel = sibling fan), so the playground draws the real graph.

**Recommendation** — ship `all` first (its own entry), then make the combinators return a `Composable`
so they nest. **Do not** add a `compose` keyword. Hold the workflow-engine line hard: **static tree
only** — no conditionals, loops, dynamic step generation, persistence, or cross-node retry. The shape
is fixed at definition time; data flows through mappers; fail-fast. Keep that discipline and it's still
stitching, not Temporal/Inngest.

**Backed by / builds on** — `pipe.ts` (`__runWith`, `newRunContext`, `PipeStep`), the parallel family
above, and ADR 0007 run identity. Mostly a **refactor of the step contract** (accept any `Composable`,
not just `Stitch`) plus the structure descriptor, rather than net-new machinery.

**Open questions** — **The threading model is the crux** (now designed — see
[Ancestor-readable pipe input](#ancestor-readable-pipe-input--frozen-lexical-context)). `pipe` threads
only the _previous_ result; real DAGs often want an earlier ancestor too (the tracking step wants the
order _and_ the shipment). The resolved answer is a **fenced** version of path (b): an opt-in,
**frozen, read-only, lexically-scoped** accumulating context handed as a _second_ mapper argument —
powerful enough for two-hops-back + initial-input, but append-only/single-pass so it does not become a
mutable run-state bag. Still open at the composition level: does the structure descriptor stay fully
serialisable once nodes nest arbitrarily? Where exactly is the line past which this stops being a
composition primitive and becomes an orchestrator we said we wouldn't build?

---

## Ancestor-readable pipe input — frozen lexical context

-   **Status:** Phase 1 IMPLEMENTED + green (2026-06, in branch — not yet merged). **Ancestors are
    BUILDER-ONLY** after an API-review pass (the variadic `pipe(...)` reverted to the simple shipped
    one-arg `(prev) => StitchInput`, no `name`/`ctx`): the typed `pipe.step()` builder in
    `packages/core/src/pipe.ts` owns ancestor access + full typing + **compile-time unique names**,
    with `test/pipe-context.spec.ts` + `test-d/pipe-context.test-d.ts` (tsc/eslint/tsd/1103 unit/
    bundle-size all pass). Phases 0/2/3 still open. Implements the threading model for
    [Nestable composition](#nestable-composition--combinators-that-compose-not-a-compose-keyword)
-   **Date:** 2026-06
-   **Tags:** composition, pipe, context, ancestor, contract-not-dependency
-   **Gates:** browser-first ✅ · bundle-frugal ✅ · contract-not-dependency ✅ (the new `name` is a
    serialisable string that joins the structure; the mapper stays acknowledged sugar) · NOT a workflow
    engine ✅ (frozen / append-only / topology fixed at definition time).

**Problem / why** — `pipe`'s `input` mapper receives only the _immediately-previous_ result
(`(prev) => StitchInput`). Real chains need an **earlier ancestor**: `order → shipment → tracking`
where `tracking` needs `order.region` **and** `shipment.carrier`/`trackingCode`; or GitHub
`repo → branch → commit` where every call needs `owner`/`repo` from the **first** result, not the
previous one. Today you can't reach back without awkwardly bundling state forward through `all`.

**Decision (as built, after API review)** — ancestor access lives on a **typed fluent builder**, not on
the variadic form. An API-review pass killed the "second `ctx` arg on `pipe(...)`" idea: it forced
casts everywhere (`shipment as Shipment`), made the user supply + police `name` strings, and read as
_more_ complex than the builder — defeating the typed-function promise. So:

-   **Two surfaces, one engine.** `pipe(...)` stays the **simple, shipped** form — one-arg
    `input?: (prev: unknown) => StitchInput`, previous-only, no `name`/`ctx` (so this is **non-breaking**
    and the variadic story stays flat). `pipe.step(...)` is the typed builder entry (no `.with()` —
    the empty call was pure ceremony): a single overloaded `.step(stitch, mapper?)` (unnamed) /
    `.step(stitch, name, mapper?)` (named — positional string), and the builder is the callable.
    **No dedicated `.named()`** (naming is an attribute of a step, not a kind of step), **no `{ name }`
    wrapper** (the object ceremony bought nothing once naming left the mapper return — a plain string
    arg is terser and gives a cleaner misuse error), and **no `.build()`** — the builder IS the
    runnable, so you `await tracked(input)` directly (`makeBuilder` returns `Object.assign(run, { step })`).
-   **Builder types everything — no casts.** Each `.step` is its own inference site, so `prev` AND
    `ctx.<name>` are fully typed (`OutputOfStitch<S> = Awaited<ReturnType<S>>`), and `ctx.$input` is
    `StitchInput | undefined`. This is the only surface where typed ancestors are possible (the variadic
    fold is a TS mirage — see below).
-   **Names are the compiler's job, not the user's.** The named overload `step<N>(stitch, name:
    N extends `$${string}` | keyof Ctx ? never : N, mapper?)` makes a **duplicate name OR a reserved
    `$`-name a COMPILE error** (`name`narrows to`never`) — the user never tracks uniqueness.
You only name a step a later step reads; anonymous `.step`s run but aren't addressable. `assertNames`stays as a runtime backstop for dynamically-built names. A frozen`{ $input, ...namedSoFar }`snapshot
is rebuilt before each step; run identity unchanged (step N a child of N-1). Parallel`all`siblings
(Phase 2): each gets the snapshot from **before**`all`, so a sibling can't read another (structural
    isolation).

**Rejected** — (1) a **breaking single-`ctx`-arg** API: its dual-arg migration shim is incoherent (a
migrated `(ctx) => …` mapper would bind the old `prev` slot and crash), so there's no safe gradual
path — not worth it for a capability we can add additively. (2) a **typed variadic-tuple `ctx` fold**
(making `ctx.order` infer as `Order`) on the `pipe(a, b, c)` surface: a later step's `ctx` would need
contextual typing from a _prior element of the same rest-tuple TS is still inferring_, which it cannot
do — `ctx.order` collapses to `unknown` (sound, cast required) or, if forced, `any` (unsound, defeats
`--strict`). **Empirically confirmed** (tsc 5.9.3, `--strict`): the variadic form yields
`TS18046 'ctx.order' is of type 'unknown'`.

**Typed `ctx` IS achievable — on a chained-builder surface** (each `.step`/`.named` is its own
inference site, so the prior step's output is resolved and folded into an accumulated `Ctx` type
param). **Empirically verified** (same tsc run): `pipe().named('order', s).step(s, (prev, ctx) => …)`
types `ctx.order.region` and `prev.shipmentId` with **zero** errors and a `bogus`/undeclared-name
access **errors** (`TS2339`) — real typing, not `any`. So the two surfaces are a genuine choice over
**one runtime engine**: `pipe(...)` (loose `ctx`, cast — what's shipped/taught) vs a `pipe.step()`
builder (typed `ctx`, no casts, typo-proof). Recommendation upgraded from "Phase 3 optional" to **the
supported path to typed ancestor access**; offer BOTH, not one instead of the other.

**Boundary guarantee** — stays a static composition primitive: (1) topology fixed at definition time —
a mapper returns `StitchInput`, never a `Composable`, so it can't synthesise/skip/reorder/repeat a
step; (2) the `ctx` CONTAINER is `Object.freeze`d (no key writes → not a mutable run-state bag) — the
freeze is **shallow by design**: ancestor _values_ are the user's own result objects passed by
reference (deep-freezing would also freeze the caller's `$input` and the pipeline's return value, a
surprising regression), so they are read-only by contract, like `prev`, not by enforcement; (3) no
persistence, no cross-node retry;
(4) the only fan-in is `all`/`any`/`race` collapsing at their own node. **The line we hold in review:**
a mapper may _shape_ the next call's input (even with a ternary on `ctx`), but we **refuse** any
follow-on that lets it return a skip/`when` sentinel, a fan-out array, or a new node.

**Honest caveat** — `name` makes the dependency **nodes** legible in the trace/DAG, but **which step
reads which ancestor lives inside the opaque closure and does NOT round-trip**: the `parentId` chain
stays linear (`order→shipment→tracking`) while the real data graph is a fan-in (`order→tracking`), so
the DAG _under-represents_ data edges. Mitigation: an optional, serialisable `reads?: readonly
string[]` hint per step so `stitch diagram`/the playground can draw the real edge. Also note: pipe does
**not** emit a serialisable structure descriptor today (it returns a bare closure) — introducing
`{ kind, members }` is real work, costed below.

**Rollout** — **Phase 0** (shared with the parallel family): `Composable` contract +
`__runWith(input, run, ctx)`, widen `pipe` to return `Composable<Out>`, thread the Frame. **Phase 1**
(this feature): sequential `ctx` + `name` + `$input`, construction-time name validation, loose
`PipeContext` typing, `pipe-ctx.spec.ts`, and a `tsd` pin (**1-arg mapper still checks; `ctx.order` is
`unknown`, not `any`**). **Phase 2** (with `all`): sibling isolation + nested lexical chain + namespaced
`all` result. **Phase 3** (optional, additive): `reads?` DAG hint and/or the typed chained-builder.

**Top risks** — (1) **DAG dishonesty** — ship the `reads?` hint before marketing the observability
story. (2) **Memory** — naming pins a result for the whole invocation (bounded by named-step count;
omit `name` to avoid). (3) **`unknown`-cast footgun** — a `ctx.oder` typo yields `undefined` in a URL
(the exact failure pipe markets against); mitigate with a dev/test-only `Proxy` that throws on a
never-declared / not-yet-resolved name, stripped in prod.

**Backed by / builds on** — `packages/core/src/pipe.ts` (the shipped runner this extends), `infer.ts`
(loose, fail-open typing stance), ADR 0007 run identity, and the parallel/Composable entries above.
