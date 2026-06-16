# ADR 0002 — The `seam` primitive & principal-scoped auth

-   **Status:** Proposed (decisions firm; implementation pending — tracked in [`IDEAS.md`](../IDEAS.md))
-   **Date:** 2026-06-13
-   **Tags:** authoring-surface, auth, security, multi-tenant, runtime, agents

## Context

Composing a stitch from shared defaults today means threading a fragment (baseUrl,
throttle, retry, observability sink) into every `stitch()` call, or wrapping it in
`defineStitch(...fragments)` — a factory that just prepends those fragments before
delegating to `makeStitch`. Both share **config** but not **runtime**: every stitch gets
its own `store` and `throttle` instance ([`packages/core/src/stitch.ts`](../../packages/core/src/stitch.ts) —
`makeStitch`), so "this third-party API has one global rate limit across all my calls"
isn't expressible without manually passing one shared `store` everywhere — the same
threading boilerplate we set out to remove.

The request that started this: a primitive a user configures **once** (baseUrl, throttle,
retry, sink) that every stitch then **belongs to**, so the shared policy can't be
forgotten. Grilling that idea moved it well past "config DRY":

-   `defineStitch` already does config inheritance, so a new primitive only earns its keep
    if it owns something a fragment/factory cannot: **shared runtime**, a **registry /
    lifecycle**, and — the decisive one — a **trusted identity boundary**.
-   "Share the third-party's global limit" is keyed on the **credential/host**, not on the
    object graph, and is already half-served by a shared `store` + `throttle.scope: 'host'`.
    So shared limits alone do not justify a primitive.
-   The genuinely new, primitive-worthy job emerged from auth. Of the five auth strategies,
    four are stateless or app-identity (`bearer`/`apiKey`/`basic` write straight to headers;
    `oauth2` is `client_credentials`, an app token deliberately shared across workers —
    [`auth.ts`](../../packages/core/src/auth.ts)). Exactly one, `cookieSession`, mints a
    **per-login session** into the shared `StitchStore` keyed by **cookie name, not
    principal**. A long-lived shared surface therefore risks serving user A's session to
    user B — a cross-principal **bleed**. Two further leak surfaces exist: the live `store`
    is reachable via the public `Stitch.__config` (**exfil-at-rest**), and the session is
    written into `req.headers` and thence any trace/hook/error (**exfil-at-use**).

This ADR records the design we converged on. It is **forward-looking** — none of it ships
yet — but the core decisions (principal bound by the handle; seam as an entity; the
store/vault split; tighten-only overrides) are firm.

There are **no production users yet**, so every choice below optimises for correctness and
safety over continuity: defaults are chosen to **fail closed** (a security-determining option
defaults to its _safe_ value — e.g. `cookieSession` scope defaults to per-user `'principal'`,
which can only throw, never to shared `'app'`), `defineStitch` is **deleted outright** with no
deprecation window, and no migration path is owed.

## Decision

1.  **Introduce `seam` as a first-class primitive; retire `defineStitch`.** A seam is a
    **long-lived entity**, not a one-shot factory. It owns (a) a shared config fragment its
    stitches inherit, (b) shared **runtime** instances (`store`, trace sink), and (c) a
    **registry** of the stitches it created, with a lifecycle (`flush()` / `close()`).
    `stitch()` survives as the **low-level peer** for standalone, one-off endpoints that
    belong to no surface; docs and the README lead with `seam` for any shared surface.
    `defineStitch` is removed — it models an alias, not an entity.

2.  **A seam is the trusted principal-binding boundary; the principal is bound by the
    handle, NEVER passed in call input.** Trusted server code derives a per-principal
    handle — `const userApi = seam.as(req.user.id)` — and the agent/caller receives only
    that handle. The principal lives in the closure, not in `StitchInput`. A caller cannot
    name another principal, so principal-keyed secrets cannot be impersonated. This mirrors
    the library's existing rule that the credential is bound at construction and "the caller
    never sees it" ([`auth.ts`](../../packages/core/src/auth.ts) header).

3.  **Scope is per-resource, not a global switch: auth/session is principal-scoped;
    throttle/circuit are host/app-scoped.** `seam.as('A')` and `seam.as('B')` get **separate
    sessions** but **share one throttle bucket** (the partner rate-limits per API key, not
    per end-user). With **no** principal bound, the key resolves to a single shared **app**
    identity — semantically correct for `oauth2` client_credentials (an app token, one for all
    workers), not a compat concession. Principal partitioning is opt-in via `seam.as(...)`.

    **`cookieSession` is the only strategy this reshapes** — it is the lone strategy that mints
    per-login session state (`bearer`/`apiKey`/`basic` are stateless; `oauth2` is
    `client_credentials`, correctly app-shared). Its scope becomes **explicit and fail-closed**:

    -   `scope` **defaults to `'principal'`** — the safe, fail-closed value. A missing scope can
        only ever _throw_ (when no principal is bound), never silently share a session. Sharing
        is opt-in: `scope: 'app'` must be written explicitly, because sharing one session across
        callers is a decision that should be stated out loud. The default `'principal'` branch
        still _requires_ the principal-aware `loginInput` at the type level (omitting both is a
        type error); `scope: 'app'` is the member that opts out. `'app'` as the default is the
        one choice rejected — it reintroduces the bleed.
    -   `scope: 'principal'` folds the **seam-bound** principal into both the store key and the
        single-flight key (the latter also fixes cross-user login coalescing), and **throws at
        call time if no principal is bound**. Per-user auth cannot silently run app-scoped — the
        bleed becomes a fail-closed error, not a prod leak.
    -   The principal is read from `AuthContext` (threaded from `seam.as(id)`), never from
        `loginInput` / `StitchInput`. `loginInput` gains the principal —
        `loginInput?: (principal: string) => StitchInput` — so trusted code maps the identity to
        _that user's_ login credentials; credentials still never originate from the caller.
    -   Session bytes land in the **vault** namespace (off `__config`, redacted). With
        `scope: 'principal'`, set `ttlMs` and use a distributed/secret backend at scale —
        per-user sessions multiply and the in-memory default must evict.

4.  **Split storage into two namespaces by capability/visibility — not by backend.**

    -   `store` — throttle counters, circuit state: freely shared, inspectable.
    -   `vault` — auth tokens / sessions: (a) never exposed on `__config`, (b) redacted from
        trace/hook/error payloads, (c) read only by auth strategies, (d) keyed by scope
        (principal for sessions).

    Both may be in-memory **or** distributed. The default is **one `StitchStore` with a
    reserved, redacted secret namespace**; a separate `secretStore` is an _optional_ override
    for a hardened vault (KMS/Vault with audit). The vault is **not** memory-only — sensitive
    ≠ unshareable, and shared tokens/sessions across workers are deliberate features.

5.  **Shared budgets are sealed; per-stitch override may only TIGHTEN, never escape.** A
    stitch may add a stricter local throttle that **stacks** on the seam's (both gates must
    pass); it cannot replace or remove a shared budget. Plain config keys (headers, unwrap,
    name, retry values…) remain freely overridable (last-writer-wins via `deepMerge`). There
    is no per-stitch "escape the shared limit" — that would defeat the seam.

6.  **Bleed, exfil-at-rest, and exfil-at-use are three independent problems; each needs its
    own fix.** Bleed ← principal in the key (decisions 2–3). Exfil-at-rest ← vault off
    `__config` (decision 4). Exfil-at-use ← redact `cookie`/`authorization` from
    trace/hook/error payloads. Storage relocation alone fixes **none** of them.

7.  **Explicitly out of scope (considered and dropped).**
    -   **Request dedup / single-flight as a user feature** — cross-principal coalescing
        hazard (two users' identical in-flight requests sharing one response).
    -   **Abandoned-request cancellation** — undetectable on the awaited-promise path (JS
        gives no "no listener" signal). Reframed as: honour a caller `AbortSignal` + abort on
        stream break, gated on write-safety — **deferred**, not part of the seam.
    -   **A seam-level `strict` boolean** — too blunt; sealing is per-resource (decision 5).
    -   **A custom ESLint plugin enforcing "all stitches via the seam"** — advisory, opt-in,
        and absent in the browser/REPL (violates the browser-first gate). Enforcement is by
        **runtime composition + encapsulation** (don't re-export raw `stitch` from a surface
        module; `no-restricted-imports` if any lint at all), not a bespoke plugin.

## Consequences

**Positive**

-   The seam finally owns a capability no fragment or factory can express: a **trusted
    principal boundary** plus lifecycle/registry. After a long grilling, that — not config
    DRY — is its reason to exist.
-   Per-user secrets become **safe in an agent setting**: no impersonation (principal bound,
    not passed), no bleed (principal in the key), no exfil (vault off `__config` + redaction)
    — without giving up shared app-identity tokens.
-   Reuses existing machinery: `extends`/`flatten` composition, store keying
    (`createStoreThrottle`), sink `flush()`. Net-new surface is small.

**Accepted trade-offs**

-   Real engine work (not a config tweak): throttle must evaluate a **chain** (intersection),
    not a merged config; `AuthContext` gains a **principal** threaded from the trusted bind
    point; `StitchStore` gains `close()` for lifecycle.
-   **Two creation paths** (`seam` and `stitch`) coexist — accepted because standalone
    stitches are legitimate; docs steer shared surfaces to `seam`.
-   **Per-principal in-memory state grows unbounded** → per-user sessions require
    TTL-eviction or a distributed vault; the in-memory default is for single-identity / dev.

**Required follow-ups**

-   Design the `AuthContext` identity field + `seam.as()` plumbing so the principal is
    **unwritable from `StitchInput`** (forgery is the whole risk).
-   Implement `cookieSession` with `scope` **defaulting to `'principal'`** (the fail-closed
    value; throws if no principal is bound; `scope: 'app'` is the explicit opt-in to sharing;
    principal folded into store + single-flight keys; `'principal'` requires
    `loginInput(principal)`) per decision 3.
    `oauth2` needs no change today (client_credentials only); a future per-user OAuth flow takes
    the same `scope` treatment.
-   Throttle **chaining** (tighten-only intersection) in the engine.
-   `StitchStore.close()` + vault **eviction/TTL** semantics.
-   `__config` **redaction**: drop `store` / `auth` / `adapter` (or expose a redacted view);
    confirm nothing reads them.
-   **Nested seams**: teardown order (flush children before the parent sink) and parent-ref
    GC retention.
-   **Gates:** browser-first — vault default backend in-browser is memory/opaque, **no OS
    keychain**; bundle-frugal — avoid a second _mandatory_ backend.

## Alternatives considered

-   **A. Keep `defineStitch`; no new primitive.** Rejected: a factory cannot own
    runtime/registry/principal binding. "Belongs to" needs an entity; `defineStitch` is an
    alias and is retired.
-   **B. Pass the principal in `StitchInput`.** Rejected: in the agent model the caller
    chooses its own input, so `principal: 'user-A'` is impersonation-by-design — an IDOR
    with extra steps. The principal must be bound by trusted code.
-   **C. Move secrets to the OS keychain, or a memory-only vault.** Rejected on two counts:
    the OS keychain is **host-wide** (worse bleed, not better) and Node-only (breaks the
    browser gate); **memory-only** breaks the deliberate shared-token / shared-session
    features. Sensitivity and shareability are orthogonal axes — the fix is the **key**
    (scope) and **visibility** (off `__config`, redacted), not the storage backend.
-   **D. Enforce "all stitches via the seam" with a custom ESLint plugin.** Rejected:
    advisory, opt-in, defeated by `eslint-disable`, and absent in the browser/REPL — the
    exact runtimes the project prioritises. Runtime composition + module encapsulation
    enforce membership instead.
-   **E. A seam-level `strict` boolean to forbid budget escape.** Rejected: one flag seals
    everything or nothing; you want `throttle` sealed while `headers` stay overridable.
    Sealing rides on the per-resource declaration (decision 5).

## Addendum (2026-06-16) — per-call multi-tenant credentials are a non-goal

A recurring multi-tenant request: "let one stitch serve tenant `A` on one call and tenant `B` on the next by **passing the tenant (or its credential) in the call input**" — e.g. `users({ tenant: 'B' })` or `users({ auth: bToken })`. This is **deliberately not supported**, and this addendum records why so the door is not quietly reopened. It is the direct corollary of Decision 2 and Alternative B; nothing here changes the design — it names a non-goal and points at the pattern that replaces it.

**The supported multi-tenant pattern is `seam.as(tenant)`, per request.** Trusted server code derives a per-tenant handle from the request it is already authenticating — `const tenantApi = seam.as(req.tenant.id)` — and hands the agent/caller only that handle. The bound principal flows into `AuthContext.principal` (set only by `seam.as()` in `makeRuntime`, never from input) and from there into the auth strategy's key: `cookieSession` (`scope: 'principal'`, the fail-closed default) keys the session by it, and `oauth2` (`tenancy: 'principal'`) folds it into the token cache key. Separate sessions/tokens per tenant, one shared throttle bucket (Decision 3). Different tenants needing genuinely different **credential material** (a per-tenant client id / secret / login) is served by resolving that secret from the **bound principal** in trusted code — `cookieSession`'s `loginInput?: (principal?) => StitchInput` is the existing seam for it, and a per-principal resolver for the header strategies is the same shape — never by a value the caller supplies.

**Why a per-call credential/tenant slot stays off `StitchInput`.** In the agent model the caller chooses its own input, so a `tenant` or `credential` field on `StitchInput` is impersonation-by-design: caller `A` writes `{ tenant: 'B' }` and is served `B`'s session/token — an IDOR with extra steps. That is exactly **Alternative B** ("pass the principal in `StitchInput`"), rejected for this reason, and it would reintroduce the **bleed** Decisions 2–3 close. `StitchInput` is therefore an attacker-controlled surface by assumption; identity must be bound by trusted code at a point the caller cannot reach. The split is the whole point of the seam: the **binding point is trusted, the call is not**.

**The boundary invariant (keep it true).** `StitchInput` carries only `params` / `query` / `body` / `headers` / `variables` / `signal` / `onProgress` — no `principal`, `tenant`, or credential slot — and `AuthContext.principal` is writable only through `seam.as()`. Any future field that lets a caller name or inject another principal's credential — a per-call `tenant`, an `auth` override on the call argument, a credential in `headers` resolved by tenant — must clear this bar first: it reopens impersonation (Decision 2) and exfil-at-use (Decision 6). The credential is bound at construction and "the caller never sees it"; per-tenant variation lives in **how trusted code binds**, not in **what the caller passes**.

**Not in tension with `.with(...)` or `seam.as(...)` re-binding.** `.with({ headers })` and `PrincipalSeam.as(other)` both happen in the code that _holds the handle_ (trusted), not in the least-trusted call argument, and `PrincipalSeam` is lifecycle-free (no `flush`/`close`/`invalidate`) so a re-bind can neither tear down nor cache-bust another tenant's runtime. Those are the sanctioned ways to vary identity; a call-input credential is not.
