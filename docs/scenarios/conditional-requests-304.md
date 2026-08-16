# Scenario: the free poll — ETag revalidation and the bodyless 304

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `conditional-requests-304`

**Verification:** 9 proof scripts, run offline (170 checks), in
[`proofs/conditional-requests-304/`](proofs/conditional-requests-304/). Published page:
[`scenarios/conditional-requests-304.mdx`](../../apps/docs/content/docs/scenarios/conditional-requests-304.mdx).
Escalated: [`issue-drafts/cache-cannot-revalidate.md`](issue-drafts/cache-cannot-revalidate.md).

| Claim                     | Verdict                                       | Measured                                                                                                          |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1 — bare stitch on a 304 | silent success carrying nothing               | `ok: true`, `data: undefined`, `error: null`; `verdict.accept: [304]` is a no-op                                  |
| C2 — replay the validator | works, seams differ                           | wire `[(none), "v1.t1", "v1.t1"]` → `[200,304,304]`, 1 billed of 3                                                |
| C3 — 304 → cached body    | **PASS, and `interpret` DOES run on non-2xx** | counter recorded `interpret` on `[200, 304, 404]`; three seams give `[1,1,2,2]` at 2 billed of 4                  |
| C4 — `output` schema      | breaks a bare poll; correct with substitution | bare 304 → `ok: false`, `contract violation (drift)`                                                              |
| C5 — built-in `cache`     | **cannot revalidate**                         | value store, not response store; hit spine has no `request` phase; a stored `undefined` is a permanent miss       |
| C6 — per-credential       | split                                         | `tenancy: 'principal'` protects the built-in cache; a user store keyed `METHOD URL` leaked **bob ← alice's data** |
| C7 — weak validators      | byte-exact                                    | `W/"v1.t1"` survives both directions; strong-for-weak → 304, the server's comparison to make                      |
| C8 — the payoff           | 8/10 polls free, zero staleness               | TTL bills 1/10 but **never saw the change** (5 of 10 polls stale)                                                 |
| C9 — assembled            | PASS                                          | **87 lines, ONE seam** (`Surface.execute`) vs **79** feature-matched hand-rolled                                  |

**The capture's predicted NOT ACHIEVABLE did not materialise, and the reason matters.** It
worried that a 304 might be rejected before `interpret` runs, citing scenario 5's "`interpret`
is dead code". Measured with a counter: `interpret` runs for every response including non-2xx —
that finding is specific to `runStreaming`. Worth carrying: the two paths differ, and the
asymmetry is undocumented.

**Two capture corrections.** `CacheOptions` has a tenth field the list omitted (`keyOf`,
`types.ts:1202`), which cannot defeat tenancy — `deriveCacheKey` still folds the principal in.
And `cache.ttl` does **not** honour an injected `clock`; every proof needing an expiring cache
had to inject a clock-backed store.

**First scenario where the honest answer is "this is a wash on size."** 87 lines against 79,
identical behaviour on all four shapes. The 8-line difference attributes exactly — two helpers
that exist only because the engine hands a surface a shared, never-case-folded header record.

---

## The use case

You poll an API for changes — a GitHub repo's issues, a feed, a config document. Most of the
time nothing has changed, and you'd like not to pay for finding that out.

HTTP has an answer. Keep the `ETag` from the last response, send it back as `If-None-Match`,
and the server replies **`304 Not Modified`** with no body. On GitHub, a 304 **does not count
against your primary rate limit** at all: 600 polls where 90% are unchanged cost 60 requests.

## Why it is not straightforward

**A 304 is a status that means "use what you have".** It carries no body, and it is not a 2xx.
Both halves are awkward for a client:

- Treat it as a failure and every unchanged poll is an error.
- Treat it as a success and the caller receives `undefined` where the resource should be.
- The only correct behaviour is to **substitute the previously cached body** — which means the
  cache and the request path have to know about each other.

Everything else follows from that:

- **The ETag and the body must be stored together**, and the ETag replayed as a request header
  on the next call. A TTL cache alone cannot do this: TTL answers "is my copy young enough",
  revalidation answers "is my copy still correct", and only the second one is free.
- **Validation runs on nothing.** A response schema applied to a 304's empty body fails, so any
  output contract has to be bypassed or fed the cached value instead.
- **ETags are per-credential.** GitHub caches them per token; rotate the token and every stored
  ETag is void. A cache keyed only by URL will replay another principal's validator.
- **ETags are per-page, not per-collection.** A 304 on page 1 of 5 says nothing about pages 2–5.
  Callers routinely assume "nothing changed" from the first page's 304.
- **Weak validators compare weakly.** `W/"abc"` and `"abc"` are not interchangeable, and
  `If-None-Match` is specified to use weak comparison.
- **Some servers never match.** Apache's default ETag embeds the file inode, so behind a load
  balancer two servers produce different ETags for identical content and revalidation _never_
  succeeds — every poll is a full 200 and the feature silently does nothing.
- **GraphQL has no ETags at all.** GitHub's GraphQL API can't do this, so the cheap-polling
  strategy is REST-only and you cache by query+variables hash yourself.

## Evidence this bites real projects

- **GitHub** — [best practices for the REST API](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api):
  a conditional request returning 304 does not count against the primary rate limit when
  correctly authorized.
- **github-buttons** — [`#33`](https://github.com/buttons/github-buttons/issues/33): using
  `If-None-Match` specifically to stop exceeding the rate limit.
- **GitHub community** — [discussion #156480](https://github.com/orgs/community/discussions/156480)
  on frequent polling, and [#189255](https://github.com/orgs/community/discussions/189255).
- **Practitioner guidance** is consistent on the two traps: a 304 has **no body** and treating
  it as an ordinary success is a common cache bug; and inode-derived ETags behind a load
  balancer make revalidation fail invisibly.

## The common solutions, and what each costs

| Approach                            | What it is                                                         | Where it breaks                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TTL cache only**                  | Cache for N seconds, re-fetch after.                               | Never revalidates, so every refresh is a full request that counts. Fresh data is also up to N seconds stale — you pay full price _and_ get staleness.        |
| **Hand-rolled ETag store**          | Keep `{etag, body}`, set `If-None-Match`, swap the body in on 304. | Correct, and what most teams write. Easy to get the per-token keying wrong, and the substitution has to happen below whatever parses/validates the response. |
| **An HTTP caching proxy**           | Let a proxy or `http-cache-semantics` handle it.                   | The most standards-correct answer. Adds a dependency or a hop, and in-process clients often can't use one.                                                   |
| **Treat 304 as an error and retry** | It's not 2xx, so it's a failure.                                   | Actively wrong: turns the _success_ case into an error, and a retry re-sends the same validator for the same 304.                                            |
| **Ignore conditional requests**     | Just poll.                                                         | What most integrations do. On GitHub it costs 10× the rate-limit budget for identical data.                                                                  |
| **Poll a cheap sentinel**           | Check `updated_at` on a small endpoint first.                      | Works where such an endpoint exists; it is a per-API workaround, not a mechanism.                                                                            |

**Summary of the state of the art:** store the validator with the body, replay it, and swap
the cached body in on a 304 — keyed by _credential_, not just URL. The pieces are individually
trivial; the difficulty is that the swap has to happen inside the response path, below parsing
and validation, which is exactly where most client libraries have no seam.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **`cache` is TTL-only.** `CacheOptions` is `{ ttl, tenancy, vary, methods, entries, coalesce,
version, transformVersion, trustTransform }` (`types.ts:1136-1191`) — no `etag`, no
  `revalidate`, no `staleWhileRevalidate`. And `If-None-Match` / `304` appear **nowhere** in
  `packages/core/src`; the only `ETag` mention is a comment in `fingerprint.ts:53` about
  strong/weak _schema_ fingerprints, which is unrelated. So conditional requests look entirely
  absent as a feature.
- **`cache.tenancy: 'principal'`** (`types.ts:1147`) is a real match for the per-token ETag
  constraint, if revalidation existed to use it.
- **The likely seam is the one that carried scenarios 2 and 4:** a custom `Surface.interpret`
  returning `{ ok: true, data: cachedBody }` on a 304, plus `hooks.onRequest` setting
  `If-None-Match` (scenario 3 proved a hook can mutate the outgoing request). The open question
  is **ordering**: is a 304 rejected by `classifyStatus`/`verdict` _before_ `interpret` runs?
  Scenario 5 found `interpret` is dead code on streaming surfaces, so "does this hook actually
  run here" is a question worth asking directly rather than assuming.
- **Does a cache hit even reach the network path?** Scenario 4 measured that a cache hit never
  fires `onResponse`. If a hit short-circuits, then "revalidate instead of serving stale" may
  not be expressible through `cache` at all, and the ETag store has to live outside it.

**Claims to test with runnable offline code:**

1. **C1** — what does a bare stitch do with a `304`? Success with an empty body, or a failure?
2. **C2** — can `hooks.onRequest` set `If-None-Match` from a stored ETag, and is the ETag
   readable off the previous response? Measure the header actually sent.
3. **C3** — **DECIDING CLAIM.** Can a 304 be turned into "return the cached body" — so the
   caller receives the resource, not `undefined`? Try `Surface.interpret`, `verdict.accept`,
   `transform`, hooks. Establish whether `interpret` runs at all for a non-2xx status.
4. **C4** — does an `output` schema reject the 304 (empty body), and can the substituted body
   be validated instead?
5. **C5** — can the built-in `cache` participate — storing the ETag alongside the body — or must
   the ETag store be separate? Does a cache hit short-circuit before any revalidation could run?
6. **C6** — per-credential keying: does `cache.tenancy: 'principal'` (or `vary`) keep one
   principal's ETag from being replayed for another? Measure a cross-principal case.
7. **C7** — weak validators: is `W/"abc"` preserved byte-exact on the way out? (A client that
   normalizes or strips `W/` breaks revalidation against a compliant server.)
8. **C8** — the rate-limit payoff: measure requests-that-count over a 10-poll run with 9
   unchanged, versus the same run with plain TTL caching.
9. **C9** — assemble the best available answer, run it, report seam and line count, and compare
   honestly with the hand-rolled version.

C3 decides this one. If a 304 cannot be turned back into the cached body inside the response
path, then the feature is not merely absent — it is unreachable, and this becomes the pass's
first genuine NOT ACHIEVABLE.
