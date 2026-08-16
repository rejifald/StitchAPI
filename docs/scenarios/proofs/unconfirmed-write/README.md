# Proofs — the charge you can't confirm

Runnable evidence for the claims in [`../../unconfirmed-write.md`](../../unconfirmed-write.md).

**The scenario's answer is a count of charges, and the deciding one is 2.** A job that charges once,
crashes, and is re-driven by its queue creates **two charges for one intended payment** under
`idempotency: true` + `retry` — the configuration the
[idempotency guide's](../../../../apps/docs/content/docs/guides/resilience/idempotency.mdx) first
example uses. The default key is `randomUUID()` evaluated once per **call** (engine.ts:172), so it is
not restart-stable and not even call-stable: the same stitch instance called twice mints two keys and
charges twice. C2 is the deciding claim and it goes against the library. The capture's central worry
is confirmed.

`idempotency.keyOf` fixes it — 1 key, 1 charge across a restart — and then two things bite that the
capture did not anticipate. `keyOf` is function sugar and is **stripped from the public `__config`**,
so a stitch rebuilt from a JSON round-trip keeps `idempotency` (as `{}`), silently falls back to the
random key, and double-charges with nothing warning. And a key derived the obvious way —
`JSON.stringify(input.body)` — moves when the body is re-serialised in a different **key order**, which
does not produce the 409 the capture expected: it produces a **second charge**, silently.

Three findings go the library's way, two of them against the capture's own hypotheses. A cached 500 is
**not** retried by default (`retry.on` is `[429,502,503,504]`; 500 is not in it). A 409 is not retried
either. And the case the whole scenario exists for — the server processed the charge and lost the
response — is **recovered for free**: the retry replays the stored 200 and hands the caller the real
charge id, with no query and no user code.

Every script is standalone and offline. The measurement is always the same one: **how many charges the
fake vendor holds at the end, against how many the caller intended**. Each script prints one
`PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c2-restart-stability.ts

# all of them
for f in docs/scenarios/proofs/unconfirmed-write/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle. The whole suite takes about two seconds: every
wait is on a `manualClock`, and nothing here does real crypto or real I/O.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/unconfirmed-write/*.ts
```

## What each script establishes

| Script                        | Question                                             | Measured                                                                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c1-key-per-attempt.ts`       | one key per call, or one per attempt?                | **One per call.** 3 attempts → 1 key, 1 charge. A **lost response was recovered** by the retry's replay. Pagination is the exception: 3 pages → 3 keys                                    |
| `c2-restart-stability.ts`     | **DECIDING** — does the default key survive a crash? | **No.** 2 keys, **2 charges for 1 payment**. `keyOf` fixes it; a `__config` round-trip silently un-fixes it                                                                               |
| `c3-derived-key-stability.ts` | is a derived key stable against re-serialisation?    | **Only if it ignores the body's shape** — or a schema canonicalises it first (#663): raw `JSON.stringify(body)` → 2 keys, **2 charges, and no 409**; with a coercing schema → **1 and 1** |
| `c4-cached-failure.ts`        | does `retry` burn its budget on a replayed 500?      | **Not by default** (1 request). With 500 in `retry.on`: 4 requests, 3 replays. `interpret` cannot veto it                                                                                 |
| `c5-key-body-mismatch.ts`     | same key, changed body → 409. Retried? Actionable?   | **Not retried, and actionable** (`status: 409` + `idempotency_key_in_use`). `verdict.accept` **swallows** it                                                                              |
| `c6-ttl-expiry.ts`            | a re-drive after the key is pruned                   | **2 charges** at 25h vs a 24h TTL, 1 at 23h. **Nothing client-side notices** — the duplicate is a clean 200                                                                               |
| `c7-timeout-ambiguity.ts`     | "never sent" vs "sent, outcome unknown"?             | **Indistinguishable.** Identical `StitchError`s over ledgers of **0 and 1 charges**. No event carries the key                                                                             |
| `c8-assembled.ts`             | all six workloads, end to end                        | **5 charges / 6 intended** (the sixth declined). Control: **8 / 6**, two duplicates. 43 lines of user code                                                                                |

## Files

- `fake-payments.ts` — the vendor, as a plain `Adapter`, with real idempotency semantics: it stores the
  status **and body** of the first request per key and replays it (including a stored failure, with
  `Idempotent-Replayed: true`), rejects a parameter mismatch with `409 idempotency_error`, prunes
  records after a TTL, and can be told to **process a charge and then lose the response**. Its
  `charges` array is the ground truth every verdict is a statement about; `chargeCount()` is the
  number. Two comparison modes (`canonical`, Stripe's; `bytes`, the stricter vendors') because the
  difference decides whether a re-serialised body errors or double-charges.
- `keys.ts` — the three key strategies and the three body variants. `naiveKeyOf`
  (`JSON.stringify(body)`), `refKeyOf` (the business fact alone), `canonicalKeyOf` (sha256 over
  sorted-key JSON). `keyOf` is **synchronous** (types.ts:1118-1119), so `crypto.subtle` is not
  available inside it — `node:crypto`'s `createHash` is what a real derivation would use.
- `harness.ts` — `check` / `checkSeq` / `checkCharges` / `checkAtMost` / `note` / `heading` /
  `finish`. `checkCharges` prints **created and intended together**, because a bare number is not the
  finding.
- `virtual-time.ts` — `drain` / `runOut`. Much lighter than the `expiring-signatures` version: nothing
  here does real async work between a clock wait and the transport, so `advance` alone is faithful.
  `runOut` exists so a claim can say "advance past everything" without hand-computing a retry schedule.

## Reading the numbers honestly

- **C2 is the finding.** `applyIdempotency` runs inside `buildRequest` (engine.ts:257), and
  `buildRequest` runs once per **call** — so `headers[header] = keyOf ? keyOf(input) : randomUUID()`
  (engine.ts:172) mints a fresh uuid for every call. Two runs of the same declaration with the same
  input produced two keys and **2 charges for 1 payment**; so did **one stitch instance called twice**.
  The docs are not wrong about this (the idempotency guide's anti-pattern callout says a double-clicked
  Pay charges twice) — but they frame it as a double-click problem, and the measured failure is a
  **queue re-drive**, which is both more likely and more expensive.
- **`keyOf` genuinely fixes the restart**, in configuration alone: 1 key across two fresh processes, 1
  charge, and the re-driven job was handed the ORIGINAL charge id rather than creating a new one.
- **C1 is the good news and it is bigger than it looks.** The case the scenario exists for — server
  processed the charge, response lost — was **recovered by the retry with no user code**: attempt 1
  created `ch_0001` and vanished, attempt 2 carried the same key, the vendor replayed the stored 200,
  and `result.data.id` was `ch_0001`. "Retry into the unknown" is the right move here precisely
  because the key is per-call rather than per-attempt (`cloneReq` at engine.ts:261-264 copies headers
  from a base that already carries the key). A caller-supplied `headers['idempotency-key']` also wins
  (engine.ts:165-170) and is reused the same way — the seam for a job runner that mints its own ids.
- **C4 refutes the capture in the library's favour.** `retry.on` defaults to `[429,502,503,504]`
  (engine.ts:612) and **500 is not in it**, so `retry: { attempts: 4 }` against a replayed 500 made
  **one** request. The capture guessed 500 might be in the default set. It is not.
- **But nothing declarative can stop the burn if you add it.** With 500 in `retry.on`, 4 attempts, 3 of
  them served from the recording. `Surface.interpret` cannot veto it — the retry check (engine.ts:743)
  runs **above** the terminal verdict (engine.ts:775), so `interpret` is not consulted until the last
  attempt (measured: 4 requests). `retry.on`'s predicate form is handed the **status and nothing else**
  (measured: `[[500],[500],[500]]`), so "retry a 500 unless it is a replay" is inexpressible.
- **The one seam that works for it is a hack.** `hooks.onResponse` runs at engine.ts:705, before the
  retry check, and receives the live response — rewriting `res.status` there when
  `Idempotent-Replayed` is present cut the burn from **4 requests to 2** (the floor: you cannot know a
  failure is cached until you have seen it twice). The price is that the caller is then told **409 for
  a declined card**, and only `error.body` still says `card_declined`.
- **C3's failure mode is the opposite of the one the capture predicted.** A body-derived key that moves
  does not reach a 409 — the server never sees the same key twice, so it creates a **second charge**,
  status `200`, silently. Measured: `[200, 200, 200]` across three renderings of one payment, 2
  distinct keys, 2 charges. Two of the capture's named risks turn out to be non-risks in JavaScript:
  `4999.0` and `4999` are one value, and a present-but-`undefined` optional field is dropped by
  `JSON.stringify`. **Key order is the whole exposure.**
- **An input schema now protects the key.** This audit measured the opposite — `validateInput`
  validated each slot and **discarded the parsed value**, so a canonicalising body schema left the two
  keys distinct and the two charges in place — and filed it as #648; #663 closed it. `validateInput`
  (engine.ts:415-447) now **returns the parsed input** and the engine runs the whole call on it
  (engine.ts:1768-1773), `applyIdempotency` included. Re-measured in C3(e) and kept as a regression
  pin: a coercing body schema under the naive `JSON.stringify` key → **1 key, 1 charge**.
- **C5 is the least dangerous failure here, and worth saying so.** A 409 means the vendor **refused**,
  so the money is safe: 1 charge, at the FIRST body's amount. It is not retried (409 is not in the
  default `retry.on`) and it is actionable (`status: 409`, `error.body.error.code ===
'idempotency_key_in_use'`; the `message` is the generic `HTTP 409`).
- **C6 is the failure a correct key cannot prevent.** 25 hours against a 24-hour TTL: same key, **2
  charges**. At 23 hours: 1 charge. The entire difference is a queue delay the client does not control.
  Nothing client-side sees it — the duplicate arrives as a clean `200` with a new charge id and **no
  replay marker**, because from the vendor's side it genuinely is fresh. `timeout.total` cannot bound
  it either: the budget is per call, and the re-drive is a new call (measured: still 2 charges).
- **C7's answer is "no", and the reason is not a defect.** The information is not on the client. What
  IS measurable is how much StitchAPI carries: a dropped request (0 charges) and a lost response (1
  charge) produced **field-for-field identical** `StitchError`s — `name: 'StitchError'`,
  `status: undefined`, `attempts: 1`, `message: 'timed out after 5000ms'`, `body: undefined`.
- **The `TimeoutError` class survives as `cause`, not as the thrown type.** The engine throws one
  (resilience.ts:21,228); `errEvt` (engine.ts:378-396) reduces it to a message on the event **and pins
  the live instance**, which `rebuildError` (stitch.ts:545-573) re-attaches as `cause` on the rebuilt
  `StitchError`. Measured: `error.cause.constructor.name === 'TimeoutError'` at the caller, and
  `hooks.onError` is handed the same instance (`TimeoutError/Error` — note `.name` is `'Error'`, the
  class never sets it). `TimeoutError` is still not exported from any public entry point (only
  `RateLimitError` is, index.ts:86), so "was this a timeout?" is the structural check
  `err.cause?.constructor.name === 'TimeoutError'` — no longer a string test on the message. What
  `cause` cannot say is which side of the wire the request died on: both C7 cases carry the same one.
- **A transport failure is retried unconditionally.** The throw path (engine.ts:675-703) retries on
  `attempt < max` alone — there is no status to match `retry.on` against. Measured:
  `retry: { attempts: 3, on: [] }` still made **3 requests**. "Retry a 503 but not a timeout" is not
  expressible; the only way not to retry into the unknown is no retry at all. Here that is benign
  (the stable key held it at 1 charge) and it is worth knowing it is not a choice.
- **C8's assembled answer is 43 lines of user code** (the block between the `BEGIN`/`END` markers,
  comments and blanks excluded — two stitch declarations, a result type, and one `settleCharge`
  function) and settled all six workloads: **5 charges for 6 intended payments**, the missing one being
  a card the vendor declined. The control (`idempotency: true`, awaited, no recovery) produced **8
  charges for the same 6**, with duplicates from the restart (C2) and the TTL (C6). Of those 43 lines,
  **19 are the recovery** — the `findByRef` stitch, the `look` helper, and the four lines that call it.
  The other 24 (the charge declaration, the result type, the success and refusal branches) are what any
  caller writes anyway.
- **The recovery has to be QUERY-FIRST.** The first draft of C8 queried only after an ambiguous outcome
  and still double-charged on the TTL workload — a recovery that runs after the write cannot un-write
  it. Asking before writing costs one extra `GET` per payment and is the only ordering that prevents
  the duplicate.
- **Query-first does not close the race; the key does.** Two concurrent runs, both querying first and
  both finding nothing: with `keyOf`, **1 charge**; with the default key, **2**. The capture flags the
  query/decide race as the weakness of this approach — it is, and a derived key covers it exactly.
- **C8's W5 is the uncomfortable one.** A stable key makes a **recorded failure sticky** for the whole
  TTL: a declined card stayed declined on the re-drive (0 charges, correct), while the random key
  **never reached the recorded failure at all** and simply charged on the second run (1 charge). The
  property that fixes the restart also makes a transient recorded failure permanent. Neither answer is
  unambiguously right, and no configuration expresses "sticky for a decline, fresh for a blip".

## The footguns

- **`idempotency: true` protects a retry and nothing else.** A key that changes per call cannot dedupe
  across calls, and a queue re-drive is a second call. Measured: **2 charges for 1 payment**, from a
  config that reads as if it prevents exactly that. The construction nudge (stitch.ts:384-390) fires
  only for a random key with **no** `retry` — so adding `retry`, the thing the guide recommends,
  **silences the only warning** while leaving the restart hole wide open.
- **A `__config` JSON round-trip silently drops `keyOf` and restores the random key.** `idempotency` is
  in `FN_BEARING_SLOTS` (stitch.ts:874-883) and `stripFns` removes every function-valued field
  (stitch.ts:941-943), so `__config.idempotency` came back as **`{}`** — present, truthy, and therefore
  still ON with the default. Measured: the rebuilt stitch charged **twice**, and nothing warned.
  Nothing in the shipped code rebuilds a stitch from `__config` (the CLI, `mcp`, `diagram` and
  `registry` only read it), but `__config` is designed to round-trip as JSON and a config file, a
  registry row, or a cross-service handoff is an obvious use of that.
- **`keyOf: (i) => JSON.stringify(i.body)` is the obvious implementation and it is unstable.** Key
  order alone moved it, and the failure is a **silent second charge**, not an error. Derive from the
  business fact, hash a canonical rendering — or declare a coercing body schema: since #663 `keyOf`
  reads the **validated** body, and C3(e) pins the naive key at 1 key / 1 charge under one.
- **`verdict: { accept: [409], flag: 'ok' }` does not classify an idempotency conflict — it SUCCEEDS on
  it.** Measured `ok: true`, with `{ error: { type: 'idempotency_error', … } }` handed back as the
  call's **data**. The caller records a successful charge for the new amount; the vendor holds one
  charge for the old amount and refused the amendment. (`expiring-signatures` C6 measured the identical
  trap on an AWS skew 403 — the flag needs a body field that is present and falsy, and vendor error
  envelopes have none.)
- **`StitchError` carries no response headers.** `status`, `attempts`, `body`, `url` — that is all
  (types.ts:1657-1691). A vendor that signals a replay in a **header** (`Idempotent-Replayed`, as
  Stripe does) is invisible to the caller; one that signals it in the body rides `error.body` for free.
  Capturing a header takes `hooks.onResponse` or a custom `Surface.interpret`.
- **No event carries the idempotency key.** The `start` event is
  `{type, name, method, url, input, at, spanId, traceId}` (types.ts:1306-1320) — no headers. So a
  caller using the default random key **cannot learn which key their lost request carried**, which
  makes the standard "ask the vendor about key X" recovery impossible by construction. `hooks.onRequest`
  is the only seam that sees it; a `keyOf` key can simply be recomputed.
- **Pagination mints a NEW key per page.** `buildRequest` is called per page (engine.ts:936,940), so
  `applyIdempotency` runs again each time: measured in C1 (e) — 3 pages, **3 distinct keys**. Harmless
  for a read; a paginated write surface with `idempotency: true` would be dedupe-free after page 1.
  "Once per logical call" is really "once per request BUILD".
- **`retry.on` cannot exclude a timeout.** A transport failure is retried whenever attempts remain,
  whatever `retry.on` says — measured 3 requests with `on: []`. If retrying an unconfirmed write is
  unacceptable for a given endpoint, the only lever is `retry.attempts: 1`.

## What is NOT measured here

- **A real vendor.** `fake-payments.ts` implements the semantics Stripe documents; it is not Stripe.
  Nothing here demonstrates that any particular vendor prunes at 24 hours, compares parameters
  canonically, or sets `Idempotent-Replayed`.
- **Concurrent requests with the same key at the vendor.** Real servers reject the second in-flight
  request for a live key (`409 idempotency_key_in_use` while the first is still running); this fake
  processes them in arrival order. The C8 race measures the CLIENT-side race the capture names (two
  workers, query-then-write), not the server's in-flight lock.
- **The expiry race.** Two requests arriving as a key expires can both pass the existence check on a
  real server. The prune here is deterministic and synchronous, so that window does not exist in this
  fake.
- **Persist-intent-first.** The capture's durable two-phase answer (write "about to charge X" locally,
  charge, mark done) is a workflow, not a client-library feature, and nothing in this directory
  measures it.
- **`store`-backed coordination.** Whether a shared `StitchStore` could hold a key across processes —
  making a restart-stable key without `keyOf` — was not attempted. The engine reads no store in
  `applyIdempotency`, so it would be user code either way.
