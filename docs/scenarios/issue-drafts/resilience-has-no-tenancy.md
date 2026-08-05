# Issue draft — `throttle` and `circuit` have no tenancy axis, so one tenant can fail all of them

**Status:** ✅ **FILED** as [#641](https://github.com/rejifald/StitchAPI/issues/641). Raised by the scenario pass on 2026-08-05.
**Scenario:** [`multi-tenant-blast-radius`](../multi-tenant-blast-radius.md)
**Suggested template:** feature_request.yml · **Suggested labels:** `enhancement`, `resilience`, `multi-tenant`

> The highest production-impact finding of the pass. It is not a bug — every piece behaves as
> documented — but the composition has a 100% blast radius, and the fix is one option name on
> two interfaces, on an axis the codebase already has.

Reproduce:

```bash
for f in docs/scenarios/proofs/multi-tenant-blast-radius/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. The measurement

A shared seam, `circuit: { failures: 3, cooldown: '30s' }`, ten customers each bound with
`seam.as(id)`. One customer's refresh token has been revoked, so their calls 401.

**Measured: 9 of 9 healthy customers failed**, with `StitchError` status 503 `circuit open`, and
**zero** of their requests reached the vendor.

Worse, it does not self-heal. Half-open admits exactly one trial call
(`resilience.ts:375-379`), and the broken tenant is the one retrying hardest — so across **four
full cooldown windows (120 virtual seconds)** the healthy tenant measured `503, 503, 503, 503`.
Recovery happens only if a healthy tenant wins the probe race.

## 2. Why — the principal stops at the auth boundary

`AuthContext.principal` reaches the auth strategies (`auth.ts:483-499`) and the cache-key builder.
It does not reach the resilience layer at all. The breaker keys on
`opts.key ?? hostKey(req, cfg)` (`resilience.ts:353`, `engine.ts:860`), and `hostKey` is
`cfg.name ?? cfg.path ?? 'stitch'` (`engine.ts:140,265-274`) — no principal anywhere.

The consequence is a split that maps exactly onto the auth/resilience line:

| resource        | isolated by                        | fails                                         |
| --------------- | ---------------------------------- | --------------------------------------------- |
| Token           | `oauth2({ tenancy: 'principal' })` | **closed** (errors without a bound principal) |
| Cache           | `tenancy`, default `'principal'`   | **closed**                                    |
| Rate budget     | a limiter key you hand-write       | **open, silently**                            |
| Circuit breaker | a `circuit.key` you hand-write     | **open, silently**                            |

The two whose isolation is a **security** property fail closed. The two whose isolation is an
**availability** property fail open, with no diagnostic.

## 3. Isolation is a property of the key string, never of the object graph

This is what makes it hard to get right by intuition. All three of these look isolated and are
not — measured:

- **10 distinct `.as()`-bound stitch objects** on the same `path` → **1** breaker key, 9/9 down.
- **10 distinct seams** sharing one store → same.
- A **`url`-only stitch** keys its breaker on the literal string `'stitch'`, so every such stitch
  sharing a store shares one process-wide breaker — across tenants _and_ endpoints.

And one that actively un-isolates: **`throttle: { pool: 'host' }` silently re-keys the circuit**
onto the host (`engine.ts:265-274` feeding `:860`). A per-tenant `name` partition evaporates, and
an unrelated endpoint for an unrelated tenant measured `503`.

Sharpest of all: **a per-tenant seam isolates the rate budget and shares the breaker.** Measured
in a single run — quiet tenant at t=0 (rate isolated), 3 of 3 healthy tenants `503` (breaker
shared). The two resources are keyed by different rules, so no construction can be reasoned
about as a whole.

## 4. The ask

Add `tenancy?: 'principal' | 'app'` to `ThrottleOptions` and `CircuitOptions`, and thread the
principal into `hostKey`/`createCircuit`. It is the **same axis `CacheOptions` and
`OAuth2Options` already carry** (`types.ts:1136-1147`), so it needs no new concept — only the
existing one extended to the two interfaces that lack it.

`'app'` should stay the default for compatibility, but a seam that has `auth` with
`tenancy: 'principal'` and a `circuit` with `tenancy: 'app'` is almost always a mistake, and is
worth a construction-time warning.

The workaround works and is cheap — a per-tenant `name` and `circuit.key`, ~3 strings per tenant;
100 keyed stitches built in under 100 ms with zero timers. But it has to be _known_, and nothing
in the type system, the docs, or the runtime points at it.

## 5. A second, independent ask: don't count credential failures as dependency failures

A `401` means the credential is bad, not that the vendor is down. Counting it toward a breaker is
what turns a per-tenant credential problem into a dependency-wide one.

Measured: three 401s recorded `failures: 3` and tripped the breaker, because a bad status reaches
`attemptWithCircuit` as a **throw** (`engine.ts:824-831, 879-890`).

The good news is that the engine already routes on _what_ failed, so the fix is pure config:
`verdict: { accept: [401], flag: 'ok' }` gave the bad tenant a real `StitchError` 401, **0**
circuit failures, and 0 of 9 healthy tenants affected — while a genuine 500 still tripped the
breaker as designed (`500, 500, 500, 503`).

**Ask:** document this pattern in the circuit-breaker guide. `verdict: { accept: [401] }` _alone_
is the trap — measured, it swallows the failure entirely and hands the caller
`{"error":"invalid_token"}` as its **data**. The `flag` is what makes it correct, and the pairing
is not obvious.

## 6. Smaller findings from the same verification

- **`oauth2` defaults to `tenancy: 'app'`** (`auth.ts:483-486`). Measured: 3 different customers,
  **1** token fetch, one shared `Authorization` header. For an app-level credential that is
  right; for a per-customer integration it is a silent credential bleed, and nothing at the call
  site hints at which one you have.
- **`tenancy` partitions the token cache, not the credential.** All tenants' tokens were minted
  from one `client_id`, because `Secret = string | (() => string)` (`auth.ts:47`) is niladic. A
  custom `AuthStrategy.apply(req, ctx)` reading `ctx.principal` works (measured
  `Bearer cred-for-t1` / `cred-for-t2`) and is the only user-reachable hook that sees the bound
  principal at call time — worth documenting as the per-customer-credential pattern.
- **Global quota + per-tenant fairness is not expressible.** A member throttle stacks
  tighten-only on the seam bucket (`seam.ts:94-106`), so adding the vendor's global cap
  re-instates the noisy neighbour (quiet tenant back to t=2000).
- **Breaker records have no TTL** (`resilience.ts:382-403` writes with no `ttl`; `store.ts:45`
  treats that as live-forever). A churned tenant's key was still resident after a virtual year,
  and nothing sweeps them — while the rate counter beside it does expire. At 4,000 connections
  that is 4,000 immortal keys.
- **`seam.stitch()` pins every stitch it creates.** With `WeakRef` after a forced GC: **200/200**
  root-created still reachable, **0/200** created through `seam.as(p).stitch()`
  (`seam.ts:136-141` — `runtime.register` is set only when `principal === undefined`). The
  per-request shape is the one that doesn't leak; the only release for the other is
  `seam.close()`, which also closes the store.
- **Seam ids are a module-level creation-order counter** (`seam.ts:38,233`), so two workers each
  hand out `s1, s2, s3`. Per-tenant seams over a shared durable store therefore collide across
  processes non-deterministically — worker A's tenant-1 bucket is worker B's tenant-7 bucket.
- **`CircuitOpenError` carries nothing identifying the tripping tenant**, so a shared-breaker
  outage cannot be attributed from the error alone.
