# Proofs — one customer's bad token, and how far it spreads

Runnable evidence for the claims in [`../../multi-tenant-blast-radius.md`](../../multi-tenant-blast-radius.md).

**The scenario's answer is a number, and it is 9 of 9.** One customer with a revoked credential, a
`circuit` on the shared seam, nine healthy customers: all nine fail, none of their requests ever
leave the process, and the outage does not end on its own. The same failure under the corrected
construction is **0 of 9**. Everything else here is the distance between those two numbers.

Every script is standalone and offline. Where a claim is about time — arrival times, cooldown
windows, a TTL measured in virtual years — it runs on an injected `manualClock()`, so the numbers
(`t=2000`, `t=0`, 120 virtual seconds) are exact rather than approximate. Where a claim is about
whether a spelling EXISTS, it runs the TypeScript compiler over candidate statements and reports
which ones compile, so "the built-in can't" is measured rather than grepped.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c1-shared-breaker.ts

# all of them
for f in docs/scenarios/proofs/multi-tenant-blast-radius/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/multi-tenant-blast-radius/*.ts
```

## What each script establishes

| Script                                  | Question                                                          | Measured                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `c1-shared-breaker.ts`                  | does one revoked credential fail everyone?                        | **9 of 9 healthy tenants down, 0 requests sent — and it never recovers.** 4 cooldown windows, 503 in every one   |
| `c2-partition-the-breaker.ts`           | can the breaker be per-tenant? is `circuit.key` static?           | **Yes, via the KEY STRING only.** 1 of 4 spellings compiles. 10 stitch objects → 1 breaker; 10 seams → 1 breaker |
| `c3-401-is-not-a-dependency-failure.ts` | can a 401 be kept off the breaker without swallowing it?          | **Yes, pure config: `verdict: { accept: [401], flag }`.** `accept` alone hands the caller the 401 body as DATA   |
| `c4-noisy-neighbour.ts`                 | does one tenant's burst spend other tenants' budget?              | **t=0 → t=2000.** And with `concurrency` the quiet tenant is not slowed, it is **queued last** (t=5000)          |
| `c5-partition-the-throttle.ts`          | can the rate budget be partitioned at all?                        | **Yes, two ways** — and `pool: 'host'` collapses both, **and silently re-keys the CIRCUIT**                      |
| `c6-token-isolation.ts`                 | does `tenancy: 'principal'` isolate tokens under a refresh storm? | **Yes, fail-closed.** But the DEFAULT is `'app'` (one token for all), and the CREDENTIAL cannot be per-tenant    |
| `c7-cost-of-isolation.ts`               | what does 100 isolated tenants cost? does anything leak?          | **~7kb and 0 timers per tenant — and three things never freed**, incl. breaker keys with no TTL                  |
| `c8-four-resources.ts`                  | token / cache / rate / breaker — isolated or not?                 | **2 by the principal (fail-closed), 2 only by a string you must remember.** Assembled: blast radius **0 of 9**   |

## Files

- `fake-vendor.ts` — the vendor and its IdP, as plain `Adapter`s over the injected clock. A request
  is attributed to a tenant by an `x-tenant` header; `fail('bad', 401)` breaks one named customer
  persistently; every request is recorded with its tenant, status, path, `Authorization` and
  **arrival time**, which is what the rate claims read. `FakeIdp` mints a traceable
  `tok-<client_id>-<n>` per request, so C6 can say whose token went out. Plus `outcomeOf` (a call
  reduced to `'ok'` / `'<status>'`) and `blastRadius` (how many of a spine were not `'ok'`).
- `probe-store.ts` — a `StitchStore` that records **every key the engine touches**. This is the
  scenario's most load-bearing instrument: whether a resource is shared or isolated is not a fact
  about which objects were constructed (C2 and C5 both measure constructions that look isolated and
  are not), it is a fact about what STRING the state was keyed on. `live()` answers the residency
  question C7 (d) turns on.
- `type-probe.ts` — hands the TypeScript compiler one candidate statement per spelling and reports
  which compile. `typescript` is `require`d through a path anchored at `packages/core` (the
  workspace package that declares it) — a bare `import ts from 'typescript'` resolves under `tsx`
  and not under plain Node from `docs/`, which would make the script run one way and typecheck
  another.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C1 is the finding, and the part the capture misses is that the outage is self-sustaining.** One
  customer with a revoked token, `circuit: { failures: 3, cooldown: '30s' }` on the shared seam, nine
  healthy customers: **9 of 9 failed**, with `StitchError` status **503** / message `circuit open`,
  and **0 of their requests reached the vendor**. The error carries nothing naming the tenant that
  caused it, so the page for customer #7 says the vendor is down while the vendor is fine. Then:
  `cooldown` elapses, the breaker goes half-open and admits **exactly one** trial call
  (resilience.ts:375-379) — and the tenant most likely to take it is the broken one, because it is
  the one retrying hardest. Across **4 full cooldown windows (120 virtual seconds)** the healthy
  tenant measured `503,503,503,503`. Recovery happened only in the counter-case where a healthy
  tenant won the probe. It is a race, not a policy.
- **The principal does not reach the resilience layer at all.** Root, `.as("t1")` and `.as("t2")` all
  touched the single key `circuit:/v1/items`. `Runtime.principal` is threaded into `AuthContext`
  (engine.ts:101-102) and read by `oauth2` / `cookieSession` / the cache-key builder;
  `attemptWithCircuit` (engine.ts:846-893) never sees it.
- **C2 refutes the capture's proposed workaround outright.** The capture says "if `key` is static
  config, per-tenant breakers mean one stitch per tenant". Measured: **10 distinct `Stitch` objects,
  each `.as()`-bound and cached per tenant, produced 1 breaker key and 9 of 9 healthy tenants down.**
  So did **10 separate seams** sharing one store. Breaker state lives in the shared store at
  `circuit:<key>` (resilience.ts:353); N objects resolving to the same `path` are N handles on one
  record. **Isolation is a property of the key string, never of the object graph.**
- **What does work is a string, and only a string.** A per-tenant `circuit.key` → 10 keys, **0 of 9**
  healthy failed, and the broken tenant's own breaker still opened (503). A per-tenant `name` does it
  implicitly, because `hostKey` falls back to `cfg.name ?? cfg.path` (engine.ts:140,273) — which
  means the trace/diagnostic label is silently also the partition key.
- **The worst default in the file: `circuit:stitch`.** Ten `url`-only stitches (no `name`, no `path`)
  over a shared store all key on the literal string `'stitch'` (`nameOf`, engine.ts:140). An
  **unrelated endpoint for an unrelated tenant** measured **503**.
- **C3 splits a trade the capture treats as unavoidable.** `verdict: { accept: [401] }` alone IS the
  swallowing case, and worse than swallowing: 4 of 4 calls measured **`ok`** and the caller was handed
  **`{"error":"invalid_token"}` as its DATA**. But `verdict: { accept: [401], flag: 'ok' }` — pure
  config — gave the broken tenant a real `StitchError` **401** on all 5 calls, **0 of 9** healthy
  tenants failed, and the breaker recorded **0 failures** and never tripped. It works because the
  engine already routes on WHAT failed (engine.ts:807-833): a bad STATUS throws and is counted, while
  a response the SURFACE rejected returns `{ ok: false }`, fails the call, and records
  `circuit.onSuccess()`. For a vendor whose error body has no falsy flag, **5 lines** of
  `Surface.interpret` composing `verdictOf` do the same. Under either, a genuine 500 outage still
  measured `500,500,500,503` and tripped the breaker — the exclusion is surgical.
- **C4's number is 2000 virtual ms**, and the mechanism is that a seam's throttle **discards the
  member's key** and re-keys every acquire onto `seam:${seamId}` (seam.ts:51-69,64). A longer window
  does not help (`600/m` declares the same 100ms spacing as `10/s` and measured the same 2000); a
  tighter one is worse (`2/s` → **10 virtual seconds**). **The concurrency half is sharper and the
  capture does not mention it:** with `concurrency: 2` the quiet tenant's instant call left at
  **t=5000** with all 20 of the noisy tenant's slow calls ahead of it, because waiters are FIFO over
  one shared key (resilience.ts:120-127,159-177). It is not slowed proportionally — it is last.
- **C5 refutes the capture in the OPTIMISTIC direction.** "The rate bucket looks un-partitionable by
  tenant" — it is partitionable, twice over: a per-tenant **seam** (the bucket key carries the seam
  id, and it holds even over one shared store) or a per-tenant **`name` plus a member-level
  `throttle`** (`rl:items:<tenant>`). Both measured the quiet tenant at **t=0**. What is missing is
  only the DECLARATION: of six candidate spellings, only `pool: 'stitch'` and `pool: 'host'` compile.
- **The asymmetry is the thing to put in the docs.** In ONE run, per-tenant seams over a shared store
  **isolated the rate budget** (quiet at t=0) and **shared the breaker** (one key, 3 of 3 healthy
  tenants down). The two resources are keyed by different rules — the bucket by the seam id, the
  breaker by `cfg.name ?? cfg.path` — so no construction can be reasoned about as a whole.
- **`throttle.pool: 'host'` silently re-keys the CIRCUIT.** `hostKey` reads `cfg.throttle?.pool`
  (engine.ts:265-274) and is the circuit's fallback key (engine.ts:860), so tuning the rate pool moved
  the breaker to `circuit:api.vendor.test` and a per-tenant `name` partition evaporated — an unrelated
  endpoint for an unrelated tenant measured **503**.
- **Seam ids are a creation-ORDER counter** (`s1`, `s2`, … — seam.ts:38,233), measured consecutive
  with no tenant derivation. Two processes each hand out `s1`, so per-tenant seams over a **shared
  durable store** put worker A's tenant-1 and worker B's tenant-7 in the same rate bucket.
- **C6 is the one axis the library gets right by construction.** `oauth2({ tenancy: 'principal' })`
  minted 3 tokens for 3 customers under 3 distinct vault keys (`tokenUrl` + NUL + principal,
  auth.ts:485-499) and reused t1's on t1's second call. It fails **closed**: without `.as()` the call
  errored with a message naming `seam.as(` and made **0** token requests. A revoked tenant's storm —
  5 doomed calls, **6 token fetches, 10 vendor requests** — left the healthy tenant carrying the
  identical token before and after, still succeeding.
- **But the default is `'app'`, and `tenancy` partitions the token, not the CREDENTIAL.** Three
  different customers under the default measured **1 token fetch and one shared `Authorization`
  header**. And even under `'principal'`, all three tokens were minted from client_id `saas-app`,
  because `Secret = string | (() => string)` (auth.ts:47) is a **niladic** thunk with no
  `AuthContext` in scope. Per-customer credentials need one strategy instance per customer — or the
  one-line escape hatch: a custom `AuthStrategy.apply(req, ctx)` reading `ctx.principal`, which is
  **the only user-reachable hook in the library that sees the bound principal at call time**.
- **C7 refutes the capture's cost model.** "One client instance per tenant … does not scale: 4,000
  pools, timers and caches." Measured: 100 per-tenant seams in **single-digit ms**, **~6.4kb each**,
  **0 timers**, and **0 connection pools** — a seam owns no transport, and all 100 shared one
  `adapter`. 1 seam + 100 keyed stitches measured the same order of magnitude. The choice between the
  two shapes is about which resource each isolates, not about scale.
- **The real price is three things that are never freed.** (1) **Breaker records have no TTL** —
  `circuit.onSuccess`/`onFailure` write without one (resilience.ts:382-403) and the store reads a
  missing ttl as live-forever (store.ts:45); a churned tenant's key was **still resident after a
  virtual YEAR**, while the rate counter beside it does expire. At the capture's 4,000 connections
  that is 4,000 immortal keys and nothing sweeps them. (2) A **rate-paced limiter retains one
  in-process map entry per key for the life of the process** — 100/100 after acquire+release, versus
  0/100 for a concurrency-only limiter (store.ts:243-254). (3) **`seam.stitch()` pins every stitch it
  creates**: 200/200 root-created still reachable after a forced GC, versus **0/200** created through
  `seam.as(p).stitch()` (seam.ts:136-141). The only release is `seam.close()` — which also closes the
  store. The per-request shape is the one that does not leak.
- **C8, as one sentence: two of the four are isolated by the principal, two only by a string you have
  to remember to write.** Token and cache fold the principal in and **fail closed**; the rate budget
  and the breaker take a hand-written key and **fail open**, silently, with no type error and no
  warning. The split is exactly the auth/resilience line. Assembled, the construction works: the same
  revoked credential that took down **9 of 9** in C1 took down **0 of 9**, the broken tenant still got
  a real 401, all 9 healthy calls reached the vendor, a genuine 500 opened **only that tenant's** own
  breaker, and the burst that pushed a quiet tenant to t=2000 measured **t=0**.
- **And one thing the built-ins cannot express at all.** A real integration has BOTH a global quota
  with the vendor and per-customer fairness. Adding a seam-level `throttle` for the global cap put the
  noisy neighbour straight back (quiet at **t=2000**), because a member's throttle stacks
  **tighten-only** on the seam bucket (seam.ts:94-106). "1000/m to the vendor AND 10/s per customer"
  is not one construction.

## The footguns

- **A shared `circuit` on a seam is a multi-tenant outage generator, and it reads like a safety
  feature.** Nothing about `circuit: [5, '30s']` on a seam says "one customer's revoked token fails
  every other customer". Set `circuit.key` per tenant, or do not set `circuit` on a shared seam.
- **Per-tenant OBJECTS do not give per-tenant STATE.** One stitch per tenant, one seam per tenant —
  both measured 1 breaker and 9 of 9 healthy tenants down. The unit of isolation is the key string in
  the shared store. This is the single most likely wrong belief a reader arrives with.
- **A `url`-only stitch keys its breaker on the literal string `'stitch'`.** Every such stitch sharing
  a store shares one process-wide breaker, across tenants AND across endpoints.
- **`throttle: { pool: 'host' }` moves the CIRCUIT too.** Two unrelated config concerns, one key
  function (engine.ts:265-274). Someone tuning the rate pool can widen the breaker to the whole host
  without touching the `circuit` block. Set `circuit.key` explicitly and it cannot happen.
- **A per-tenant seam isolates the rate budget and NOT the breaker.** The most isolated-looking
  construction available is half a fix, and the half it misses is the one that causes outages.
- **`verdict: { accept: [401] }` on its own does not "ignore" the 401 — it SUCCEEDS on it.** The
  caller receives the vendor's error envelope as data. Pair it with `flag`, or with a surface.
- **`oauth2` defaults to `tenancy: 'app'`**, which is one token for every customer. Correct for
  `client_credentials`, wrong for a per-customer integration, and silent either way.
- **`tenancy: 'principal'` isolates the token, not the credential.** `Secret` takes no context, so a
  shared `oauth2()` mints every tenant's token from the same client id.
- **`cache: { tenancy: 'app' }` serves one tenant another tenant's response body** — measured. The
  default is `'principal'` and fail-closed, so this only bites someone who opts out.
- **Per-tenant breaker keys never expire.** One immortal store key per tenant per endpoint, in Redis,
  forever. If tenants churn, that set only grows.
- **`seam.stitch()` retains every stitch it creates.** Caching one root-created stitch per tenant —
  the obvious optimisation — pins all of them until `seam.close()`. Build per-tenant members through
  `seam.as(id).stitch(...)`, which does not register.
- **Seam ids are per-process creation order.** Per-tenant seams over a shared durable store collide
  across workers, non-deterministically.
