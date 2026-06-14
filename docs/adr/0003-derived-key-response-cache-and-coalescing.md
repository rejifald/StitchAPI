# ADR 0003 — Derived-key response cache & request coalescing

-   **Status:** Proposed (decisions firm; implementation pending — tracked in [`IDEAS.md`](../IDEAS.md))
-   **Date:** 2026-06-14
-   **Tags:** caching, performance, resilience, runtime, multi-tenant, agents

## Context

The request that started this: "we're missing a cache — two calls with the same key and
variables should resolve to the same response," modelled on react-query. Grilling it moved
the design well past "add react-query."

Two observations reshaped it:

-   **react-query is a UI-bound cache that sits _above_ the transport.** Its real value —
    `useQuery` subscriptions, refetch-on-focus/reconnect/interval, invalidate-and-components-
    re-render — exists only because a retained `QueryClient` and a reactive component tree sit
    underneath it. StitchAPI is the **transport itself**: kind-agnostic, server _and_ browser,
    no component model. So the question is not "should we have react-query's feature" but
    "which parts are _transport_ concerns vs _UI_ concerns." A stitch runs where react-query
    cannot — agents, CLIs, servers, the REPL — and that is exactly the gap a transport-level
    cache fills.
-   **We can _derive_ the key; react-query must have the user author it.** react-query demands
    user-authored keys only because it cannot see the request. We can: method + URL (path +
    query) + body / GraphQL variables + the headers that actually vary the response are all in
    hand. A derived key is **more reliable than an authored one** — a caller (or an agent)
    cannot typo a key that desyncs from the request it names — and it costs the caller nothing.

This also **revives a feature ADR 0002 deliberately dropped.** [ADR 0002 §7](0002-seam-primitive-and-principal-scoped-auth.md)
rejected "request dedup / single-flight as a user feature" because of the **cross-principal
coalescing hazard** — two users' identical in-flight requests sharing one response. That hazard
is now fixable with the very machinery ADR 0002 introduced: the **principal folded into the
key** (decisions 2–3). Coalescing returns here _only_ because principal-keying makes it safe.

This ADR records the design we converged on. It is **forward-looking** — none of it ships yet.
There are **no production users**, so every choice optimises for correctness and safety over
continuity, and security-determining defaults **fail closed** (the cache is principal-scoped
unless sharing is written out loud).

The design is bound by the project gates ([`FEATURE-LENSES.md`](../FEATURE-LENSES.md),
[`DESIGN.md`](../DESIGN.md)): **browser-first** (no `node:*` on the call path), **bundle-frugal**
(the feature is a subpath, not core weight), **contract-not-dependency** (reuse the
`StitchStore` `get/set/incr` contract — grow no new vendor surface), **no side effects by
default** (off until a `cache` block is written), and **declarative spelling** (the config
round-trips as JSON; functions are sugar).

## Decision

1.  **The key is _derived_, opaque, and flat — no hierarchy.** The cache key is a deterministic
    128-bit hash the library computes from the **resolved** request — method + URL + body /
    GraphQL `variables` + the vary-relevant headers + the principal (decision 5). The caller
    never authors it; a `cache.key(input)` override exists as **sugar only** (declarative-spelling
    gate). Canonicalisation is mandatory so semantically identical requests collide intentionally:

    -   **Objects**: keys sorted recursively; **arrays and query-param order are preserved** (both
        are ordered — and we build the query string ourselves, so its order is ours to fix).
    -   **`null` vs absent**: `null` is an explicit value and is kept; `undefined` is treated as
        absent (and drops out under `JSON.stringify` for free).
    -   **URL**: normalised through the platform `URL` only (lower-cased host, default port
        dropped, dot-segments resolved) — no hand-rolled trailing-slash / percent-encoding
        heuristics.
    -   **GraphQL**: the query **document is opaque** (canonicalising it would pull in a GraphQL
        parser, against the frugal gate) — only `variables` are canonicalised; persisted-query
        users already send a hash.
    -   **Principal**: canonicalised exactly as a body, so an object principal can't split a
        user's cache; use opaque principal ids — the principal is part of every scoped key.

    **The hash is 128-bit, non-cryptographic, and synchronous** (e.g. xxh128): sync because
    WebCrypto's `digest` is async and a JS crypto hash is bundle weight (browser-first / frugal),
    and 128-bit puts a collision past ~2⁶⁴ entries — unreachable, so **no verify-on-read** (which
    would mean storing the plaintext canonical request beside the value, re-introducing the very
    leak we avoid — see decision 5). The key is **opaque for observability hygiene** (no PII or
    principal ids in logs, traces, or metric labels), **not a secret**: a hash of a low-entropy
    request is enumeration-recoverable, and the stored **values are plaintext in the same store
    anyway**, so genuine key-secrecy (an HMAC with a per-seam secret) is a **future opt-in** that
    only earns its keep paired with value encryption.

    Being an opaque hash, invalidation is **exact-match only**. Structural / hierarchical / prefix
    matching (react-query's `['users']` invalidating `['users', 1]`) is **out** — a hash of
    `/users` has no relationship to a hash of `/users/1`, and faking one means giving up derived
    keys. We give up hierarchy instead (see _Out of scope_).

2.  **Cache only _validated_ responses; never revalidate on a hit.** The stored value is the
    fully-resolved `T` — after `transform`/`unwrap` and **after output validation + drift**. A
    hit returns it directly: no re-validation, no drift pass on the hit path. A response that
    **fails validation or drifts is never cached**, so a stored entry is always a known-good
    value. Accepted trade-off: drift is invisible on cache-hit paths between writes — the only
    bound on staleness is the `ttl`.

    Because we skip re-validation, a stored value is **bound to the output contract it was
    validated against**. Ship a changed `output` schema and a hit would return an old-shape value
    that violates the new one — silently, for the whole TTL. So an **output-schema fingerprint
    must fold into the generation** (decision 8) so a schema change invalidates the bucket.
    Fingerprinting a Standard Schema is its own hard problem (a schema is a closure graph; no
    universal serialisation), split into its own concern (**ADR 0004**): per-validator strategies
    behind a contract, a manual `cache.version` as the fail-closed fallback, and **re-validate on
    hit** as the safe default for any stitch whose schema can't be fingerprinted (it forfeits this
    decision's skip for that stitch only, trading speed for correctness).

3.  **An uncacheable call warns; it never throws.** A streamed response (`.stream()`), a body
    that cannot be hashed (stream / `Blob` / `FormData` beyond an opt-in), or any other
    un-storable case **passes through uncached and emits a `warning` event**. Configuring
    `cache` on a streaming stitch is a no-op-with-warning, not a crash — consistent with the
    browser-first "degrade, never crash" rule.

4.  **Headers: honour the server's `Vary` by default; an explicit allowlist overrides.** Because
    we derive the key we own the content-negotiation hazard react-query sidesteps — two calls
    with the same URL/body/method but different `Accept-Language` must not collide. By default
    the key incorporates the request headers named in the **response's `Vary`** (learned on the
    first miss, stored alongside the entry). A caller may instead declare
    `cache.vary: ['accept-language', …]` to fix the set explicitly. Volatile headers
    (`traceparent`, `x-request-id`, auth — handled by decision 5) are never in the key.

5.  **Principal-scoped by default, fail-closed; `scope: 'app'` is the explicit opt-in.** The
    principal (ADR 0002 decisions 2–3) is folded into the key by default, so user A can never be
    served user B's cached response. Sharing a response across callers — correct for public,
    unauthenticated data — requires writing `scope: 'app'` out loud. There is **no
    auto-detection** of "this looks public": guessing publicness from a missing `Authorization`
    header is how leaks happen. The cost (per-principal entries for public data have a near-zero
    hit rate until `scope: 'app'` is set) is paid deliberately.

    Orthogonally, **`sensitive: true` opts a stitch out of the cache entirely** — never stored,
    always a live call. It is _not_ the key's leak-protection (the opaque hash + principal scope
    already cover that, decision 1), so defaulting it to `false` is **not fail-open**; it is an
    honest "do not persist this response at all" hatch for one-time tokens, compliance-bound data,
    or anything that should never sit in a store as a value. Because caching is itself opt-in
    (decision 11), it only ever applies to a stitch a dev already chose to cache.

6.  **Coalescing collapses concurrent identical in-flight requests — two modes, store-aware
    default.** True regardless of mode: a leader's **failure is not shared** with waiters (they
    proceed independently), aborts are **ref-counted** (the shared in-flight is dropped only when
    the _last_ waiter aborts — the bounded slice of the abandoned-request question ADR 0002
    deferred, not general cancellation), `sensitive: true` **bypasses coalescing as well as
    caching** (a one-time-token endpoint must hand each caller its own live response), and
    coalescing applies only to the **cacheable method set** (GET/HEAD + opted-in GraphQL queries —
    never collapse two writes).

    -   **In-process (ships in v1).** A process-local map of in-flight Promises keyed by the
        derived key; concurrent callers in one process await a single shared Promise. No store
        interaction, no lease, instant. This is the dominant real case (one server, one agent)
        and the only mode that makes sense without a shared store.
    -   **Cross-process / cluster (deferred — own grill).** Collapses identical requests across
        workers via a store lock (lease + `incr` election + poll). Its cost (lease sizing,
        re-election, poll cadence, ordering invariants, conformance) is real and its marginal
        benefit over the TTL cache is only the **cold concurrent window** before any worker has
        cached. So the **protocol is deferred to a dedicated grill/ADR**; the open questions are
        recorded under _Required follow-ups_.

    **The default is store-aware.** With no shared store, in-process is the only option; once the
    cluster protocol ships, a **shared store enables cross-process by default** — what a user
    wiring up Redis expects — overridable with `coalesce: 'process' | 'cluster' | false`. Until
    then, v1 defaults to in-process and reserves `'cluster'`.

7.  **Lifecycle placement is _outermost_ — but _after_ input validation, not before.** The order
    is: **validate/normalise input → derive the key from the _resolved_ input → cache lookup**. A
    **hit short-circuits everything below the lookup** — no throttle slot, no circuit check, no
    network, no transform, no output-validation/drift (decision 2). On a miss the coalescing lock
    wraps the **full** resilience chain
    (`throttle → circuit → retry/auth/fetch → transform → output-validate`) and the **validated**
    result is written to the cache **last**; concurrent callers await that one run (decision 6).
    Lookup is outermost over the _expensive_ chain; the store write is the final step.

    Input validation is **not** skipped on a hit (it precedes the lookup), for two reasons — a
    cache hit does **not** by itself prove the input is valid, because the key is only a
    _projection_ of the input:

    -   **Key correctness.** The key must mirror the request actually sent, which is built from
        the **coerced/defaulted** input. Under `params: { id: z.coerce.number() }`, `{ id: '42' }`
        and `{ id: 42 }` must hit the _same_ entry; keying on raw input splits them (false misses)
        and keys on something other than what we send. So the coercion validation performs is a
        prerequisite for a correct key.
    -   **Boundary integrity.** The key is the request-shaping slice of the input only. A
        _different_ input can match a stored key yet be one validation would reject — a strict
        schema's extra field, a cross-field refinement whose fields aren't both in the key, a
        validated-but-non-`vary` header. Looking up before validation would serve a cached
        **success** for a call that should have **thrown**, tunnelling an invalid call past the
        stitch boundary. Validation is the boundary; a hit must not bypass it.

    The cost of keeping validation first is microseconds; the latency a hit actually saves — the
    network, throttle/circuit, transform, and output-validation/drift — is all still skipped. The
    asymmetry with decision 2 is deliberate: **output** validation is redundant on a hit (the
    stored value was already validated), **input** validation is what makes the hit correct.

8.  **Invalidation: exact is a delete, bulk is a generation bump.** With hierarchy gone (decision
    1), exact-match invalidation of one entry is just `store.set(key, undefined)` — **no new
    mechanism**. Bulk invalidation (everything, or everything for one stitch — the cases we
    cannot enumerate over a `get/set/incr` store) uses a **generation counter** folded into the
    namespace: `invalidate()` does one `incr` on the generation key; every prior-generation
    entry becomes unreachable and TTLs out on its own. No key enumeration, no `SCAN`, no
    contract extension. Granularity is **per-cache and per-stitch**. The two surfaces:
    `handle.invalidate(input)` (exact) and `seam.invalidate(stitch?)` / `cache.invalidate()`
    (bulk).

9.  **Memory bounding lives in the cache layer, not the store.** `ttl` bounds entries by _time_,
    never by _count_ — 1 000 distinct requests in the TTL window are 1 000 live entries. So the
    cache layer enforces an **LRU + max-entries** cap over whatever store backs it; the
    `StitchStore` contract stays dumb (a BYO Redis store inherits no eviction obligation). The
    cap is JSON config (`cache.maxEntries`).

10. **Caching is a `stitch` config capability, not a seam-only one.** A bare `stitch()` already
    accepts a `store`; caching works there too — it matches the atomic-stitch promise (a single
    stitch is a complete unit). A seam merely **provisions the shared store** the cache rides on,
    exactly as it does for throttle, circuit, and sessions; `seam.invalidate(...)` is the bulk
    surface because the seam is the retained entity that owns the store.

11. **Subpath export, off by default.** The cache/coalescing engine ships behind its own subpath
    (bundle-frugal): `import { stitch }` pulls none of it. No `cache` block ⇒ no caching and no
    hot-path cost beyond reading an absent config key. A shared `store` makes the cache
    distributed for free, identically to throttle and the circuit breaker.

12. **Explicitly out of scope (considered and dropped).**
    -   **Hierarchical / tag-based / prefix invalidation** — irreconcilable with derived opaque
        keys (decision 1); ceded deliberately.
    -   **Stale-while-revalidate / background refresh** and **refetch-on-focus / reconnect /
        interval** — these need a retained reactive host; they belong to a react-query/SWR
        _integration_ layered on top, not the transport.
    -   **Mutation-driven cross-stitch auto-invalidation** (a `POST /users/1` auto-busting
        `GET /users/1`) — requires a relationship map between stitches, i.e. **app-level
        response-cache policy**, which [`DESIGN.md`](../DESIGN.md) puts out of scope ("a stitch is
        not a platform"). Manual `invalidate` (decision 8) is the supported path.
    -   **Caching writes / non-idempotent methods** — cacheable is **GET/HEAD by default**;
        GraphQL queries (POST-but-read) may opt in explicitly, since a POST's read-vs-mutate
        intent cannot be inferred. Mutations are never cached.

## Consequences

**Positive**

-   **Zero-config correctness no UI cache can match.** The key is derived from the actual
    request, so it cannot drift from what it names — and it works in agents, CLIs, and servers
    where react-query/SWR have no host.
-   **Coalescing lands, safely.** The cross-principal hazard that killed it in ADR 0002 is closed
    by principal-keying. v1 collapses concurrent identical calls **in-process** (herd protection
    for the common single-process case); the cross-process tier that also serialises retries
    across workers is deferred (decision 6).
-   **Reuses existing machinery.** `StitchStore.get/set/incr`, principal-keying, the
    shared-store-makes-it-distributed pattern, and the trace event stream all carry over; net-new
    runtime dependency count stays **zero**.

**Accepted trade-offs**

-   **Drift is invisible on cache-hit paths** between writes (decision 2). `ttl` is the only
    bound; a tight TTL trades hit rate for freshness/drift-sensitivity.
-   **v1 coalescing is process-local.** A shared store makes the TTL cache distributed, but the
    in-process coalescer is by nature per-process (a Promise can't cross processes). Across
    workers the TTL cache still dampens duplication; full cross-process coalescing waits on the
    deferred cluster mode (decision 6). Its known costs when it lands — poll-based waiting (no
    pub/sub in the contract) and a waiter latency that can reach `leader's full retry + its own` —
    are noted now so they aren't a surprise then.

**Required follow-ups**

-   **Freeze and version the key-derivation algorithm.** The hash is settled (128-bit sync
    xxh128, decision 1), but a shared/distributed store outlives a deploy, so the
    **canonicalisation** must be a **versioned, frozen** contract with a key-schema version
    prefix; any change to it is itself a generation bump (mass self-healing miss, never a
    stale-key collision). Oversized / stream / `FormData` bodies skip hashing and fall to
    warn-and-pass-through (decision 3).
-   **Schema-fingerprinting (ADR 0004).** How to fingerprint a Standard Schema so an `output`
    change invalidates cached values (decision 2): per-validator strategies behind a contract, a
    manual `cache.version` fallback, and re-validate-on-hit when un-fingerprintable.
-   **Cross-process coalescing protocol (deferred — own grill).** The cluster mode of decision 6,
    saved for a dedicated session: the `incr` + lease lock and **leader election / re-election**;
    the **stranded-waiter signal** (cache-present ⇒ take it / lock-gone + cache-empty ⇒ re-elect)
    with the **write-cache-before-release** and **discover-once-then-poll-via-`get`** invariants;
    **lease sizing** vs. a crashed leader (lease ≈ `timeout.total` + margin, no heartbeat,
    leader-abort releases immediately); **poll cadence + latency floor**; **process-local abort**
    at the cluster tier; and a **conformance addendum** (`incr` exactly-once under N concurrent
    callers + lease-expiry frees the lock) so BYO stores prove coalescing-safety, not just
    rate-limit `incr`.
-   **GraphQL opt-in classification** — how a `kind: 'graphql'` stitch marks a query as
    cacheable (queries yes, mutations never), since intent can't be inferred from POST.
-   **LRU eviction** in the cache layer / `memoryStore` interplay: where `maxEntries` is enforced
    and how it composes with a distributed backend that has its own eviction (decision 9).
-   **`__config` redaction & traces** — cached values and lock keys must not leak via
    `Stitch.__config` or trace/hook payloads (extends ADR 0002 decision 4 / §6).
-   **Config shape** — settle `cache: { ttl, scope, vary?, methods?, maxEntries?, coalesce?, key? }`
    plus the stitch-level `sensitive?`, confirm every field round-trips as JSON, and that `key` is
    sugar over the derived default.
