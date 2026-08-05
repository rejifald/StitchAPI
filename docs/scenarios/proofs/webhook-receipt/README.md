# Proofs — receiving a signed webhook, and where StitchAPI stops

Runnable evidence for the claims in [`../../webhook-receipt.md`](../../webhook-receipt.md).

**This is the first scenario whose answer is a boundary rather than a technique, and the boundary
runs down the middle.** Receipt — arbitrary route, raw bytes, HMAC, replay window, fast ack — is
**out of scope by design**. Reaction — fetch-on-receipt, the dedup ledger, the downstream write — is
squarely in scope. C7 measures the split as a number: **154 executable lines the library does not
participate in, 63 it does.**

Every script is standalone and offline. Where a claim is about a server, it starts a REAL
`node:http` server on `127.0.0.1` and POSTs REAL signed bytes at it — a local socket is the only
honest way to ask "what would a Stripe delivery actually get back", and it is not a third-party
call. Where a claim is about time, it runs on an injected `manualClock()`; where a claim is about a
TTL longer than a test suite can wait, it runs on a clock-backed `StitchStore` (`clock-store.ts`),
because `memoryStore` reads `Date.now()` and ignores an injected clock (C5 (d)).

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure. Every server is closed in a
`finally`; the scripts exit.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/webhook-receipt/c1-serve-raw-body.ts

# all of them
for f in docs/scenarios/proofs/webhook-receipt/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
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
  --types node ../../docs/scenarios/proofs/webhook-receipt/*.ts
```

## What each script establishes

| Script                       | Question                                             | Measured                                                                                                            |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `c1-serve-raw-body.ts`       | can `serve` receive a signed webhook?                | **No — 404 at all five paths tried**, body already `JSON.parse`d, and the signature header dropped entirely         |
| `c2-no-inbound-primitive.ts` | is there ANY inbound-signature primitive?            | **No.** 72 runtime exports, 4 matches, all BYO-plugin conformance suites. The one HMAC signs OUTBOUND only          |
| `c3-serve-seams.ts`          | is there a seam — surface, hook, `ServeBodyOptions`? | **No.** The mount point that exists is defeated by verifying: reading the stream leaves `readBody` hanging          |
| `c4-out-of-order.ts`         | does fetch-on-receipt make ordering moot?            | **PAYLOAD order yes, WRITE order no.** Converged `active/pro`; two concurrent handlers still landed on the older v2 |
| `c5-dedup-ledger.ts`         | can `StitchStore` be the dedup ledger?               | **Yes, and the ownership is the other way round.** `get`+`set` triple-processed; `increment` processed exactly once |
| `c6-fast-ack.ts`             | does anything help with ack-now-process-later?       | **No, and `void call()` is a silent DROP.** The ack measured exactly 10 virtual seconds late through `serve`        |
| `c7-the-boundary.ts`         | the honest end-to-end answer, and its shape          | **154 lines of receipt / 63 of reaction** — 71% of the code is the half StitchAPI does not participate in           |

## Files

- `receiver.ts` — **user code, the receipt half, with no StitchAPI runtime in it.** A `node:http`
  server: arbitrary route, bounded raw-byte buffering, signature check, atomic dedup claim, 2xx
  written before the work starts. Its only reference to the package is `import type { StitchStore }`.
- `stripe-sig.ts` — **user code**, `node:crypto`. Stripe's scheme: HMAC-SHA256 over `${t}.${raw}`,
  `timingSafeEqual` behind a length guard (it throws on a length mismatch), and a tolerance check
  kept separate from the MAC check — a valid MAC on an old timestamp is a replay, not a pass.
- `reaction.ts` — **user code, the reaction half, almost all config.** One seam carrying `auth` /
  `retry` / `throttle` / `timeout`, a `current` stitch (fetch-on-receipt) and an `apply` stitch
  (`idempotency.keyOf` off the event id), plus the four-line version guard C4 (c) proves you need.
- `fake-billing.ts` — the provider in both directions. `mintDelivery` signs a `Buffer` and hands back
  that same `Buffer`, so a proof verifying a re-serialised object is verifying something the provider
  never signed. The adapter serves `GET /v1/subscriptions/{id}` (current truth, a snapshot) and
  `POST /v1/entitlements` (recording `Idempotency-Key`). Knobs: `failNext`, `delayTicks`, `onRequest`.
- `clock-store.ts` — a `StitchStore` whose TTL runs on an injected clock, with an optional external
  backing map so "the process restarted" is expressible. `memoryStore` cannot do either.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework.

## Reading the numbers honestly

- **C1 is the finding, and it has three parts, only two of which the capture predicted.** A real
  `serve()` process answered **404** to a signed Stripe-shaped POST at `/webhooks/stripe`,
  `/webhook`, `/`, `/stitch` and `/hooks/v1/billing` — the route table is exactly `GET /` and
  `POST /stitch/:name` (serve.ts:219-231). On the one route that reaches user code the body has been
  through `JSON.parse` (serve.ts:122-125,248), and the deepest user-reachable seam
  (`Surface.buildRequest`) received a parsed object with no field carrying the raw string. **The
  third part is decisive and unpredicted: the inbound headers are dropped entirely.** The run input
  is built from the body alone (serve.ts:268-271); `req.headers` is read for `content-length`
  (serve.ts:95) and `accept` (serve.ts:128) and nothing else. `stripe-signature` appears nowhere, so
  there is nothing to verify _against_ even if the bytes were recoverable. The byte gap is real and
  small: the provider signed **162 bytes**, a parse→stringify round-trip produces **153** logically
  identical bytes, **9 bytes of whitespace**, and verification returns `bad-signature`.
- **A form-encoded provider cannot be received at all.** Slack signs an
  `application/x-www-form-urlencoded` body; `serve` answered **400 `invalid JSON body`** before any
  of the above could matter.
- **C2 by enumeration rather than grep.** Importing all six public entry points and filtering 72
  runtime exports for `/verif|hmac|signature|webhook|…/` returned exactly four names, and all four
  are BYO-plugin conformance suites (`verifyStoreContract`, `verifyAdapterContract`,
  `verifySinkContract`, `verifyFingerprintContract`). `AuthStrategy` is `{apply, name, scheme}` —
  `apply(req, ctx)` mutates an OUTGOING request and `scheme` is a declarative wire description
  (types.ts:1234-1236). `awsSigV4` ran here and produced an `AWS4-HMAC-SHA256` header on an outbound
  request; its subtle key is imported with usages `['sign']` (aws-sigv4/src/index.ts:84), so it
  structurally cannot verify.
- **Two things look like the answer and are not.** `xxh128` (hash.ts:110-113) is what someone
  reaching for "compare a digest" finds first — measured taking **1 argument** and returning the same
  32-char digest with **no secret anywhere**, which is exactly why it authenticates nobody; hash.ts:110
  self-describes as non-cryptographic. And `idempotency` wears the same word as the dedup problem
  while living at the opposite end of the pipe: measured putting `Idempotency-Key: evt_1PqR` on an
  OUTBOUND POST.
- **C3: `createServeHandler` is a real mount seam, and verifying defeats it.** Mounted in a plain
  `node:http` server it served an arbitrary `/webhooks/stripe` and ran the stitch, **200** — so C1's
  ROUTE problem is fixable by owning the server. The BYTES problem is not: reading the stream to
  verify (which succeeded) leaves `readBody` (serve.ts:90-120) waiting for `end` on an already-ended
  stream. **The handler had not settled after 200ms**; the client got a 504 from the test's own
  deadline, not from the handler. Verifying and delegating are mutually exclusive.
- **`serve` is unauthenticated, and the only inbound control is a byte cap.** `{body:{max:64}}`
  answered a 130-byte signed delivery with **413 "exceeds"**, while an **UNSIGNED forged body** under
  the cap **ran the stitch and returned 200** (serve.ts:28,59). The stitch-side hooks point outward:
  `hooks.onRequest` fired with `req.url` = the OUTBOUND url, no `stripe-signature`, and a
  `HookContext` of exactly `{attempt, name, req}`.
- **C4 splits a sentence the capture treats as one claim.** Acting on payload order with a reversed
  pair applied `["active/pro","trialing/free"]` and left the app believing `trialing/free` while the
  server said `active/pro` — a silent self-inflicted downgrade, nothing thrown. Fetch-on-receipt
  applied `["active/pro","active/pro"]` and converged, at a measured cost of **2 API calls for 2
  events**. So PAYLOAD order is genuinely moot. **WRITE order is not:** two concurrent handlers
  holding snapshots v2 and v3, last-write-wins, landed on **version 2 / `active`** while the server
  said **version 3 / `canceled`**; a version guard rejected exactly `[2]` and recovered v3. Nothing
  in the library expresses that guard — it is four lines of `reaction.ts`.
- **And one case fetch-on-receipt cannot answer at all.** A `.deleted` event's fetch returned
  **404**, which is indistinguishable from "never existed". The event TYPE is still load-bearing, so
  "the payload is only a hint" is not quite true.
- **What is unambiguously the library's job is that call.** With `auth`, `retry: {attempts: 3}`, a
  fixed 1s backoff and `timeout: {total: '10s'}`, the fetch-on-receipt stitch survived **two 503s in
  3 measured attempts** on an injected clock and converged — no retry loop in the handler.
- **C5 reverses the capture's open question.** Scenario 4 left "whether a user can borrow the store
  cleanly" open; the ownership runs the other way. `store` is a config key the USER supplies
  (types.ts:1583-1584) and `memoryStore()` is a public export (index.ts:62). Measured directly: one
  wrapped instance recorded both the ledger's `webhook:` keys and the ENGINE's `rl:` throttle
  counter. Three deliveries of one event id → `["first:processed","retry:skipped","retry:skipped"]`,
  **1 side effect**.
- **The dedup ledger everyone writes is racy, and the fix already ships.** `get`-then-`set` with 3
  concurrent claims on one id returned **`[true,true,true]`** — three charges. `increment(key, ttl)`
  (types.ts:1969-1970), which exists for the throttle counter, returned **`[true,false,false]`**.
- **The TTL boundary is exact, and untestable against the default store.** With a 4-day TTL over
  Stripe's 3-day window, claims at `t=3d` and `t=ttl-1ms` both skipped and `t=ttl` processed — the
  boundary is `expires > now`, exclusive (store.ts:16), so a TTL equal to the retry window lets the
  last retry through. But `memoryStore` takes **no clock** (arity 0) and reads `Date.now()`
  (store.ts:16,45,54 via util.ts:4): after **four virtual days** on a `manualClock` the key was still
  live. A 3-day window cannot be boundary-tested without a clock-backed store.
- **Durability is the real gap in the default, and the swap is first-class.**
  `memoryStore.close()` is `data.clear()` (store.ts:59-61) — the ledger did **not** survive, so a
  deploy inside the retry window re-processes every event still being retried. A BYO durable store
  over the same interface survived a restart and passed **all 11 rules** of `verifyStoreContract`
  (testing.ts:173) with **0 violations**; `redisStore` / `cloudflareKvStore` / `denoKvStore` are that
  interface.
- **C6's finding is a silent data-loss bug in the obvious workaround.** `void call(input)` — the
  spelling anyone writes to ack-then-continue — made **0 HTTP calls and raised 0 errors**. A stitch
  call is a lazy thenable that starts on `.then` (stitch.ts:729,781), so the work is dropped after
  the provider has been told 200. `void call(input).then(…)` does run it, and is then unsupervised:
  unhandled it surfaced as **1 `unhandledRejection`**, and `.safe()` produced **0** and reported the
  failure **nowhere**.
- **And `serve` makes the ack worse the more reliable you make the call.** Its handler consumes the
  run to completion before writing a byte (serve.ts:177-201,272-273). With `retry: {attempts: 3}` and
  a 5s fixed backoff on a `manualClock`, the ack was unsent after attempt 1, unsent after attempt 2,
  and went out at attempt 3 having waited **exactly 10 virtual seconds** — Stripe's timeout to the
  second. The retry policy manufactures the duplicate it exists to survive. `pipelineStages`
  (config-summary.ts:86) says the same thing structurally: `call → throttle → POST … → retry → http
interpret → result`, nothing matching `/queue|background|detach|ack|defer|async/`, `result` last.
- **A small correction worth carrying: `backoff.base` is clamped by `backoff.max`, which defaults to
  10s** (types.ts:972-973). `base: 30_000` measured a **10,000ms** sleep, silently.
- **C7 runs the whole thing and the numbers hold.** Forged signature → **400 `bad-signature`**; a
  genuine MAC on a 10-minute-old timestamp → **400 `stale`, 0 side effects**; the reversed pair both
  acked **200** and converged on `active/pro` with the guard rejecting `[2]`; the provider's duplicate
  acked **200 at a cost of 0 API calls**, with exactly one `Idempotency-Key` (`evt_updated`) ever
  reaching the downstream write — two independent guards, both fired.
- **The boundary, as a number.** Receipt: **154 executable lines** (96 of `node:http` server + 58 of
  `node:crypto` signature verification), importing **nothing** from `stitchapi` at runtime — its one
  reference is `import type { StitchStore }`. Reaction: **63 executable lines**, almost all config.
  **71% of the code is the half StitchAPI does not participate in**, and by concern the split is
  100% / 0%: no part of receipt is made easier by the library being present.

## The footguns

- **`serve` reads like a webhook endpoint and is not one.** It is an HTTP server, in the box, that
  accepts POSTs with JSON bodies. Nothing about the name says "this exposes YOUR registry to a
  trusted local caller", and the failure mode is not a compile error — it is a **404 in a provider
  dashboard**, or worse, a **200 on an unsigned forged body** if someone reshapes their event to fit
  `POST /stitch/:name`. It is unauthenticated by design (serve.ts:28,59); pointing a provider at it
  means anyone who can reach the port can run your stitches.
- **`engine.ts:287` exports a symbol named `RAW_BODY`.** It is the raw **response** body of an
  **outbound** call, retained for `.inspect()`. Anyone grepping this repo for "raw body" while
  debugging a signature failure finds it first, and it is the opposite thing.
- **`xxh128` is the wrong hash and will happily produce a plausible-looking digest.** It is unkeyed.
  A signature check built on it verifies nothing and looks like it works.
- **`idempotency` is not inbound dedup.** Both problems are "the same thing happened twice"; the
  config key solves the outbound one. The inbound ledger is code you write against `StitchStore`.
- **`void call(input)` is not fire-and-forget, it is a no-op** — see C6 (c). This one is silent in
  both directions: no request, no error.
- **`get`-then-`set` dedup passes every single-process test and double-processes in production.** Use
  `increment(key, ttl) === 1`.
- **A dedup TTL equal to the retry window is off by one delivery**, because the store's liveness test
  is `expires > now` (store.ts:16). Set it beyond the window, not to it.
