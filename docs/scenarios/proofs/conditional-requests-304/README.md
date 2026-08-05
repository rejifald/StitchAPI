# Proofs — the free poll: ETag revalidation and the bodyless 304

Runnable evidence for the claims in
[`../../conditional-requests-304.md`](../../conditional-requests-304.md).

Every script is standalone, offline, and deterministic: it injects a fake GitHub-shaped
conditional-request API through StitchAPI's `adapter` / `Surface.execute` seam and drives every
wait off an injected `manualClock()`, so a ten-poll run at one-minute intervals is exact **virtual**
time — no real sleeping, nothing flaky, no network.

**The measurement is a pair of counters and a header string.** The whole scenario turns on "how many
of these responses would have cost me rate-limit budget" and "what exactly went out as
`If-None-Match`", so the fake server records both on every hit: `billed` counts every non-304
(GitHub's own rule), and `validators` is the byte-exact header value it received (`'(none)'` when
absent). `W/"v1"` surviving as `W/"v1"` is a measurement, not an argument, and so is
`billed 2 / requests 10`.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c3-substitute-the-body.ts

# all of them
for f in docs/scenarios/proofs/conditional-requests-304/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
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
  --types node ../../docs/scenarios/proofs/conditional-requests-304/*.ts
```

## What each script establishes

| Script                       | Question                                       | Measured                                                                                                   |
| ---------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `c1-bare-304.ts`             | what does a bare stitch do with a 304?         | **Silent success carrying nothing.** `ok:true`, `data:undefined`, `error:null`; `await` resolves           |
| `c2-replay-the-validator.ts` | can a hook set `If-None-Match`?                | **Yes** — and `buildRequest` bakes it once per RUN while `onRequest` runs per ATTEMPT                      |
| `c3-substitute-the-body.ts`  | can a 304 become the cached body?              | **YES. `interpret` runs on `[200,304,404]`** — three seams work, `execute` needs no `interpret`            |
| `c4-output-schema.ts`        | does `output` reject the empty body?           | **Yes, hard** — but substitution is upstream of validation, so the schema sees `[1,1]` not `[1,undefined]` |
| `c5-builtin-cache.ts`        | can `cache` hold the ETag / revalidate?        | **No.** Entry is `{v,s,vary}`; a hit's spine is `[start, cache:hit, result, done]` — no request phase      |
| `c6-per-credential.ts`       | is one principal's validator kept off another? | **Split.** `tenancy` protects `cache`, nothing protects the ETag store; **bob got alice's body**           |
| `c7-weak-validators.ts`      | does `W/"v1"` survive byte-exact?              | **Yes, both transports.** Also: header names are never case-folded, so `delete` misses the other casing    |
| `c8-the-payoff.ts`           | what does revalidation actually buy?           | **8 of 10 polls free with ZERO staleness.** TTL bills 1/10 and never sees the change                       |
| `c9-assembled-solution.ts`   | best answer, and is it worth it?               | **87 lines, ONE seam**, byte-identical to a 79-line hand-rolled twin on all 4 shapes                       |

## Files

- `fake-etag-api.ts` — the server. Plain GET → `200` + body + `ETag`; a matching `If-None-Match` →
  **`304` with no body**; a stale one → a fresh `200` + new `ETag`. Weak comparison per RFC 9110
  §8.8.3.2, so `W/"v1"` matches `"v1"`. Knobs for the shapes that matter: `weak` (mint `W/"…"`),
  `inodeEtags` (a unique validator on every response — the load-balancer case where revalidation
  never succeeds), and `etagScope: 'content'` (validators derived from the representation rather
  than the credential, which is what makes a cross-principal replay a data leak rather than a miss).
  Exposes both an `Adapter` and a `fetch`-shaped entry point, so C9's two implementations share one
  transport contract.
- `revalidate.ts` — **user code**, the assembled answer and the subject of C9's line count. One
  `Surface` with one hook (`execute`), plus counters (`revalidated` / `stored` / `orphans` /
  `unvalidatable`) that make the two silent-failure modes assertable.
- `hand-rolled.ts` — the same five rules with no StitchAPI in them, feature-matched down to the
  bounded store, so the line comparison is honest.
- `clock-store.ts` — a `StitchStore` whose TTL reads the injected clock. Needed because the default
  `memoryStore` reads `Date.now()` and ignores `clock` entirely (C5 case e).
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C3 refutes the capture's central worry, and that is the finding.** The capture asks whether a 304
  is "rejected by `classifyStatus`/`verdict` _before_ `interpret` runs", citing scenario 5's
  discovery that `interpret` is dead code on streaming surfaces. On the buffered path it is not.
  Measured with a counter, `interpret` was called for **`[200, 304, 404]`** on one stitch:
  engine.ts:775 sits inside `attemptLoop` and its own comment says it interprets "EVERY response,
  including the non-2xx the engine used to throw on". A 304 reaches it doubly easily, because
  `classifyStatus` (surface.ts:143-149) only fails `status >= 400` — a 304 was never rejected at all.
  This is a legitimate **ACHIEVABLE WITH USER CODE**, not a manufactured one.
- **The best seam is `Surface.execute`, and it is the one the capture does not mention.** Pairing
  `interpret` with `hooks.onRequest` works (measured `[1,1,2,2]` from `[200,304,200,304]` at 2 billed
  of 4), but the two seams have no channel between them, so the store key has to live in a closure
  variable. Under two CONCURRENT calls to different resources on one stitch, the store ended up with
  **1 entry instead of 2**, and 3 of the next 4 polls paid full price with nothing to indicate why.
  `execute` (engine.ts:666-674) sees a request and its own response in one function call, runs per
  attempt, and sits after `cfg.auth.apply` — so it correlates correctly AND can key by credential.
- **`execute` needs no custom `interpret` at all, and that is the neatest part.** The substituted
  body rides back on a response whose status is still **304**, and `httpInterpret` hands it to the
  caller unchanged, because a 304 is transport-healthy. So `.inspect().status` honestly reports 304
  while `.data.version` is 2. Nothing has to lie about what happened on the wire.
- **C1 is the trap this whole scenario exists to name.** A bare stitch answers a 304 with
  `ok: true`, `data: undefined`, `error: null`, and `await issues()` **resolves** with `undefined`
  rather than throwing. Through the real `fetchAdapter` the empty body decodes to `undefined` with a
  JSON `content-type` (http-adapter.ts:135) and to `""` without one (http-adapter.ts:137) — two
  different falsy values, so a caller cannot even guard on one shape. `verdict.accept: [304]`, the
  obvious first fix, is a measured no-op.
- **Adding an `output` schema makes it worse before it makes it better.** The same 304 that silently
  yielded `undefined` becomes `ok: false` / `contract violation (drift)` / `data: null` the moment a
  contract is attached — so a polling loop that "worked" starts erroring when someone adds a schema.
  With substitution in place the contract never sees the empty body: the pipeline is `interpret`
  (engine.ts:775) → `transform` (1198) → `pick` (1199) → `validateOutput` (1203), measured as the
  schema being handed versions `[1, 1]`.
- **The built-in `cache` cannot participate, and the reason is structural.** Its entry is
  `{ v, s, vary }` (cache.ts:300-304) and what gets stored is `out.value` — post-`interpret`,
  post-`transform`, post-validation (engine.ts:1624). No response header reaches it, so there is
  nowhere for an ETag to live. A hit short-circuits everything below the lookup: measured across 3
  calls, hooks fired `[onRequest, onResponse]` **once**, `interpret` ran **1** time, and the event
  spine on a hit is `[start, cache:hit, result, done]` — there is no `request` phase to conditionalise.
  `revalidateOnHit` (cache.ts:441) is a false friend; it re-checks the stored value against the
  `output` SCHEMA, never the network.
- **The cache cannot even STORE a 304.** Forced into its own key via `vary: ['if-none-match']`, three
  identical conditional calls measured `[undefined, undefined, undefined]` with statuses
  `[200,304,304,304]` and 4 network requests: `op.set` writes `{ v: undefined }` and cache.ts:482
  reads that as a permanent miss. The entry is written and can never be read.
- **The one workaround for storing the ETag turns the cache off.** Folding it into the value via
  `transform` (`{ etag, body }`) makes the stitch un-fingerprintable, so ADR 0004 fails closed:
  measured `bypass: opaque transform without cache.transformVersion or trustTransform`, 2 requests
  across 2 calls.
- **C6 is the finding that counts double.** With a server whose validators are content-derived (the
  Apache/CDN default), an ETag store keyed on `METHOD URL` alone measured **`[tok-alice|(none)→200,
tok-bob|"v1"→304]`** — one store entry, and bob receiving `viewer: tok-alice`. Alice's private body
  was served to bob, and the rate-limit metrics IMPROVED while it happened. `cache.tenancy` does not
  help: it keys the built-in cache, which knows nothing about the ETag store. And the obvious place
  to fix it is not available — `ResolvedStitchConfig` carries no `principal` (it lives on
  `AuthContext`, engine.ts:1032), and `Surface.buildRequest` cannot see the credential HEADER either,
  because it runs at engine.ts:253, **before** `cfg.auth.apply` at engine.ts:649. Only
  `hooks.onRequest` and `Surface.execute` see it. One extra term in the key expression fixes it.
- **C8's TTL row is the one to read twice.** In the QUIET world (nothing changes across 10 polls) a
  TTL cache and revalidation cost exactly the same: **1 billed of 10**. In the CHANGE world (the
  resource moves once, before poll 6) revalidation bills 2/10 with versions
  `[1,1,1,1,1,2,2,2,2,2]` and zero stale polls, while the TTL cache bills 1/10 and **never sees the
  change at all** — versions `[1,1,1,1,1,1,1,1,1,1]`, 5 of 10 polls serving a superseded version.
  One extra billed response is the entire price of correctness.
- **Two failure modes look exactly like success, and neither will ever raise an error.** The
  load-balancer INODE case (a server minting a fresh validator per response) polled 10 times, billed
  10, got **0** 304s and reported nothing — detectable only as `stats.revalidated === 0` while
  `stats.stored === 10`. A server that sends no `ETag` at all billed 3/3 with `stats.stored === 0`
  and `stats.unvalidatable === 3`. Both deserve an assertion in production.
- **C9's line count is honest in the unflattering direction.** 87 executable lines of user code
  against a **79**-line feature-matched hand-rolled twin — the StitchAPI side is LONGER, by 8 lines,
  and those lines attribute precisely: `credentialOf` and `clearValidator`, two helpers that exist
  only because the engine hands a surface a SHARED header record it never case-folds
  (engine.ts:232). Behaviour is byte-identical on all four shapes. What the extra lines buy is what
  stayed CONFIG — `auth`, `output`, `retry`, `timeout`, `seam.as()` and the trace spine
  (`[start, progress:request, result, done]` per poll) — every one of which would have to be written
  INTO the hand-rolled file.
- **Two capture corrections worth carrying.** `CacheOptions` has a tenth field the capture's list
  omits: `keyOf` (types.ts:1202), a user-supplied key derivation — and `deriveCacheKey` still folds
  the principal in through it (cache.ts:159-162), so it cannot be used to defeat tenancy. And
  `cache.ttl` does **not** honour the injected `clock`: `memoryStore` reads `Date.now()`
  (store.ts:16,45 via util.ts:4), measured as 1 request after advancing a `manualClock` by a virtual
  hour against a 1-second TTL. `clock` drives retry/throttle/timeout/circuit; cache expiry is the
  one timing knob it does not reach.
