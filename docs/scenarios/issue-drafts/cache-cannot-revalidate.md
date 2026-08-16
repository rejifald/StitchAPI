# Issue draft — `cache` cannot do conditional requests, and a surface cannot key a store by principal

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`conditional-requests-304`](../conditional-requests-304.md)
**Suggested template:** feature_request.yml · **Suggested labels:** `cache`, `enhancement`

> Not a bug — a capability gap with a sharp edge. The scenario came out **achievable** (87
> lines on `Surface.execute`), but the primitive that _looks_ like it should carry it cannot,
> and the safe way to write the replacement depends on information a surface isn't given.

Reproduce:

```bash
for f in docs/scenarios/proofs/conditional-requests-304/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `cache` is a value store, so an ETag can never reach it

`CacheEntry` is `{ v, s, vary }` (`cache.ts:300-304`) and what gets written is `out.value`
(`engine.ts:1624`) — the post-`interpret`, post-`transform`, post-validation value. No response
header survives that far, so there is nowhere to put an `ETag`, and no way to send
`If-None-Match` on the next call.

Three consequences, all measured:

- **A hit short-circuits everything below the lookup.** Over 3 calls: hooks fired once,
  `interpret` ran once, one request reached the server. The hit spine is
  `[start, cache:hit, result, done]` — no `request` phase (`engine.ts:1613-1617` returns before
  `runFrom`). So revalidation cannot run _under_ a hit even if you wrote it.
- **The cache cannot store a 304.** Forced into its own key via `vary`, three conditional calls
  measured `[undefined, undefined, undefined]` with statuses `[200,304,304,304]` and 4 network
  requests — `op.set` writes `{ v: undefined }` and `cache.ts:482` reads that as a permanent miss.
- **The one workaround disables caching.** Folding `{ etag, body }` into the value via
  `transform` makes the stitch un-fingerprintable, so ADR 0004 fails closed:
  `bypass: opaque transform without cache.transformVersion or trustTransform`.

**`revalidateOnHit` is a name collision worth fixing.** It re-checks the stored value against
the `output` **schema** (`engine.ts:1604`), never the network. A reader looking for conditional
requests finds this option first and it does something else entirely.

**Ask:** either a `cache.revalidate` mode that stores the validator with the entry and issues
`If-None-Match` on a stale hit, or — cheaper — a documented statement that `cache` is a TTL
value cache and conditional requests belong in a surface, with a pointer to the pattern.
Renaming or aliasing `revalidateOnHit` would remove the collision either way.

## 2. A surface cannot see the bound principal, which is what makes a user-written ETag store leak

The correct key for an ETag store is _credential-scoped_ — GitHub caches ETags per token, so a
store keyed on URL alone replays one principal's validator for another.

The information needed to do that is not available where you'd write it:

- `ResolvedStitchConfig` carries **no `principal`** — it lives on `AuthContext` (`engine.ts:1032`).
- `Surface.buildRequest` runs at `engine.ts:253`, **before** `cfg.auth.apply` at `:649`, so it
  cannot even read the credential _header_. Measured `absent` in both positions.
- Only `hooks.onRequest` (`:652`) and `Surface.execute` (`:666`) are downstream of auth — both
  measured `Bearer tok-alice`.

So the only safe key is parsed back out of the `Authorization` header by hand.

**Measured leak:** against a server with content-derived validators, a store keyed on
`METHOD URL` produced one store entry and **bob receiving `viewer: tok-alice`** —
`[tok-alice|(none)→200, tok-bob|"v1"→304]`. `cache.tenancy: 'principal'` protects the built-in
cache (verified: 2 requests, 2 distinct keys) but knows nothing about a user-written store.

The reason this is worth flagging rather than filing under "user error": **the rate-limit
metrics improve while it happens.** A 50% 304 rate is exactly what a correctly working
revalidator looks like, so the leak is invisible in exactly the dashboard you'd check.

**Ask:** expose the bound principal to a surface (on `ResolvedStitchConfig`, or as a field on
whatever context `execute` receives). One term in a key expression is the whole fix; today it
requires re-parsing a header the engine already resolved.

## 3. Smaller edges from the same verification

- **`interpret` DOES run on non-2xx** — measured with a counter across `[200, 304, 404]`. Worth
  stating in the surfaces reference, because the neighbouring streaming path does _not_ call it
  (see [`sse-reconnect-replays-completed-streams`](sse-reconnect-replays-completed-streams.md)),
  and the asymmetry is currently undocumented.
- **`buildRequest` runs once per run, not per attempt** (`engine.ts:253`, outside `attemptLoop`).
  A validator set there is baked into every `cloneReq` — measured 3 identical validators across
  3 attempts and a run that then failed, where `hooks.onRequest` recovers by dropping the header
  (`["v1.t1","(none)"]` → `[304,200]`).
- **Request headers are never case-folded** (`engine.ts:232`, a plain spread). Measured:
  `delete headers['If-None-Match']` does not remove a header set as `'if-none-match'`, and the
  stale validator still went out.
- **`verdict.flag` on a 304 emits a spurious `info` drift finding on every unchanged poll** —
  noise on the hot path.
- **Adding an `output` schema breaks a working bare conditional poll**: the empty body fails the
  contract (`ok: false`, `contract violation (drift)`). Correct once substitution is in place,
  but the failure mode is "adding validation broke my polling".

## 4. A second clock finding, companion to the existing one

**`cache.ttl` does not honour an injected `clock`** — `memoryStore` reads `Date.now()`
(`store.ts:16,45`, `util.ts:4`). Measured: one request after advancing a `manualClock` by a
virtual hour against a 1-second TTL, so a cache-expiry test on virtual time passes vacuously.

This is the same shape as the `timeout.total` finding in
[`clock-and-diagnostic-side-effects`](clock-and-diagnostic-side-effects.md), and the two
together suggest a general audit is worth more than two point fixes: **which time-driven
features read the injected clock, and which read `Date.now()`?** Whatever the answer, the
testing guide should list it, because right now a `manualClock` test of either feature is green
and meaningless.
