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
