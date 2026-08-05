# Scenario: one customer's bad token takes down all of them

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `multi-tenant-blast-radius`

**Verification:** 8 proof scripts, run offline (152 checks), in
[`proofs/multi-tenant-blast-radius/`](proofs/multi-tenant-blast-radius/). Published page:
[`scenarios/multi-tenant-blast-radius.mdx`](../../apps/docs/content/docs/scenarios/multi-tenant-blast-radius.mdx).
Escalated — **the pass's highest production-impact finding**:
[`issue-drafts/resilience-has-no-tenancy.md`](issue-drafts/resilience-has-no-tenancy.md).

| Claim                            | Verdict                             | Measured                                                                                                                                                                 |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — shared breaker blast radius | **confirmed, worse than predicted** | **9 of 9** healthy tenants failed, `503 circuit open`, 0 requests reached the vendor — and it **never self-heals**: `503,503,503,503` across 4 cooldown windows          |
| C2 — partition the breaker       | yes, via the key **string** only    | `circuit.key` is a static string; 10 `.as()`-bound stitches → **1** key; 10 separate **seams** → 1 key; per-tenant `key` → **0 of 9** failed                             |
| C3 — exclude a 401               | PASS, pure config                   | `accept: [401]` alone **swallows** it (caller got the error body as data); `{ accept: [401], flag: 'ok' }` → real 401, **0** circuit failures, a genuine 500 still trips |
| C4 — noisy neighbour             | confirmed                           | one tenant's 20-call burst pushed a quiet tenant from t=0 to **t=2000 ms**; with `concurrency: 2` it was **last**, at t=5000                                             |
| C5 — partition the throttle      | yes, two ways                       | per-tenant seam, or per-tenant `name` + member throttle — both t=0. `pool: 'host'` collapses **both** partitions _and_ re-keys the circuit                               |
| C6 — token isolation             | confirmed, fails closed             | 3 tenants → 3 tokens, 3 vault keys; errors without `.as()`. Default is `'app'` — 3 customers, **1** shared token                                                         |
| C7 — cost of isolation           | cheap, leaky                        | 100 seams < 40 kb each, **0 timers, 0 pools** — but breaker keys are immortal and `seam.stitch()` pins 200/200                                                           |
| C8 — the four resources          | 2 isolated, 2 not                   | assembled blast radius **0 of 9**                                                                                                                                        |

**Three wrong hypotheses, and two were wrong in the optimistic direction — a first.**

- "Per-tenant breakers mean one stitch per tenant" — **false**. 10 stitch objects → 1 breaker;
  10 _seams_ → 1 breaker. Isolation is the key string, never the object graph.
- "The rate bucket looks un-partitionable by tenant" — **wrong pessimistically**. It partitions
  two ways; only the _declaration_ is missing.
- "One client per tenant doesn't scale: 4,000 pools and timers" — **wrong**. 100 seams cost
  under 40 kb each with **zero** timers and **zero** pools, because a seam owns no transport.

**The framing worth keeping:** the split falls exactly on the auth/resilience line.
`AuthContext.principal` reaches the auth strategies and the cache-key builder and nothing else.
So the two resources whose isolation is a **security** property fail closed, and the two whose
isolation is an **availability** property fail open, silently.

---

## The use case

You run a SaaS that integrates a vendor API — Jira, Salesforce, HubSpot, Shopify — **on behalf
of each of your customers**. Every customer connected their own account, so every call carries
that customer's credential. At 500 customers with 8 connections each you are managing
[4,000 token lifecycles](https://truto.one/blog/how-to-architect-a-scalable-oauth-token-management-system-for-saas-integrations/).

The calls are ordinary. The failure mode is not.

## Why it is not straightforward

**The unit of failure is the tenant; the unit of protection usually isn't.**

Resilience machinery — rate budgets, circuit breakers, connection pools — is normally scoped to
a _dependency_. But in a multi-tenant integration the thing that goes wrong is scoped to a
_customer_: their token was revoked, their admin changed a permission, their account hit its own
quota. When the protection is broader than the failure, one customer's problem becomes
everyone's:

- **A shared circuit breaker is the sharpest edge.** One customer whose refresh token was
  revoked produces a steady stream of `401`s. Those are failures. A breaker counting failures
  across all tenants opens — and now every _healthy_ customer fails fast too. One revoked
  token, total outage.
- **A shared rate budget is the noisy-neighbour classic.** One customer's batch job consumes
  the bucket and every other customer's latency degrades. The
  [documented shape](https://markheath.net/post/noisy-neighbour-multi-tenancy) is one badly
  written job tripling everyone's p99 within minutes.
- **A shared credential is worse than a shared bucket.** As one write-up puts it: the upstream
  429s, _"and every other session behind that same credential inherits it… per-tenant buckets
  contain the rate, but the credential model underneath is what decides the blast radius."_
- **Token refresh is per-tenant and concurrent** — the thundering herd from
  [scenario 1](oauth2-refresh-token-rotation.md), now multiplied by tenant count.
- **Isolation has to be cheap.** "One client instance per tenant" is correct and does not scale
  to 4,000 of them: each carries its own connection pool, timers, and memory.

The tell that this is hard: platforms keep adding _partitioned_ limiters to fix it — .NET 10
shipped per-tenant rate limiters as a first-class feature precisely because the un-partitioned
kind is a known outage generator.

## Evidence this bites real projects

- **The noisy-neighbour writeups** are consistent: [Mark Heath](https://markheath.net/post/noisy-neighbour-multi-tenancy),
  [OneUptime on per-tenant collector limits](https://oneuptime.com/blog/post/2026-02-06-otel-rate-limiting-per-tenant-noisy-neighbor/view),
  [Gravitee on rate limiting at scale](https://www.gravitee.io/blog/rate-limiting-apis-scale-patterns-strategies).
- **Per-account circuit breakers** are named as the mitigation — open the breaker for _that
  account_ so its doomed retries fail fast without slowing everyone else.
- **Token management at scale** — [Truto on architecting OAuth for B2B SaaS](https://truto.one/blog/how-to-architect-a-scalable-oauth-token-management-system-for-saas-integrations/)
  puts the refresh race at the centre.
- **.NET 10 partitioned rate limiters** exist [for exactly this](https://blog.elmah.io/new-in-net-10-and-c-14-multi-tenant-rate-limiting/).

## The common solutions, and what each costs

| Approach                                   | What it is                                               | Where it breaks                                                                                       |
| ------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **One client instance per tenant**         | Construct the whole client per customer.                 | Correct isolation by construction, and it does not scale: 4,000 pools, timers and caches.             |
| **Partitioned limiter**                    | One bucket per tenant key inside one client.             | The right shape, and only helps if your client offers it — most don't.                                |
| **Per-tenant circuit breaker**             | Key the breaker on the customer.                         | The named mitigation. Needs the breaker to accept a _per-call_ key, which most implementations don't. |
| **Global breaker, tuned high**             | Raise the failure threshold so one tenant can't trip it. | Trades one failure mode for another: now a real outage takes far longer to trip.                      |
| **Exclude auth failures from the breaker** | Don't count `401`s as dependency failures.               | Genuinely correct and often forgotten — a `401` says the _credential_ is bad, not the API.            |
| **Sharded workers by tenant**              | Route each customer to a worker.                         | Real isolation, at the cost of a routing tier and uneven load.                                        |

**Summary of the state of the art:** partition every piece of shared state by tenant — token
cache, rate budget, breaker — and don't count credential failures as dependency failures. The
first is what most clients get wrong, and the second is what most _teams_ get wrong.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **There is a real asymmetry in the isolation knobs.** `tenancy: 'principal' | 'app'` exists on
  `OAuth2Options`, `CookieSessionOptions` and `CacheOptions` (`types.ts:1147`) — so **auth and
  cache can be per-tenant**. But:
    - `ThrottleOptions.pool` is `'stitch' | 'host'` (`types.ts:1039`) — **no `'principal'`**, so
      the rate bucket looks un-partitionable by tenant.
    - `CircuitOptions` is `{ failures, cooldown, key }` (`types.ts:1079-1088`) — a `key`, but **no
      `tenancy`**. Whether `key` can vary _per call_ is the crux: if it is static config,
      per-tenant breakers mean one stitch per tenant.
- `seam.as(principal)` binds a principal, and scenario 1 measured `oauth2({ tenancy:
'principal' })` isolating tokens correctly. The open question is whether that binding reaches
  the _resilience_ layer at all.
- Scenario 6 measured that a surface cannot even see the bound principal, which suggests the
  principal is auth/cache-scoped rather than run-scoped.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** One tenant with a permanently bad credential produces repeated
   failures. Does a shared circuit breaker open and **fail healthy tenants**? Measure: how many
   of N healthy tenants fail because of tenant X.
2. **C2** — can the breaker be partitioned per tenant? Is `circuit.key` static config or can it
   vary per call? If static, measure the cost of the workaround (one stitch per tenant): what
   does 100 tenants actually construct?
3. **C3** — is a `401` counted as a circuit failure? It shouldn't be — it says the credential is
   bad, not the dependency. Measure whether `verdict`/`acceptStatus` can exclude it without
   also swallowing the error.
4. **C4** — noisy neighbour: with `throttle: { rate }` on a shared seam, does one tenant's burst
   consume other tenants' budget? Measure arrival times per tenant.
5. **C5** — can the throttle be partitioned per tenant at all? `pool` offers `'stitch' | 'host'`;
   try `seam.as()`, a per-tenant seam, `key`. Measure what actually isolates.
6. **C6** — token isolation (the part scenario 1 suggests works): confirm `tenancy: 'principal'`
   keeps tenant tokens separate, and that one tenant's refresh storm doesn't disturb another's
   in-flight calls.
7. **C7** — the cost of the correct construction. If isolation requires per-tenant stitches or
   seams, measure what 100 tenants costs: objects, timers, memory, and whether anything is
   shared that shouldn't be.
8. **C8** — assemble the best available answer and state plainly which of the four shared
   resources (token, cache, rate, breaker) end up isolated and which don't.

C1 and C5 decide this. A shared breaker that one tenant can open is a total-outage bug, not an
ergonomics complaint — and if the rate bucket cannot be partitioned at all, the honest answer
may be that multi-tenant fan-out needs a seam per tenant.
