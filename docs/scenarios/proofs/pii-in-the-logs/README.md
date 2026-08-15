# Proofs — the customer data you didn't mean to log

Runnable evidence for the claims in [`../../pii-in-the-logs.md`](../../pii-in-the-logs.md).

**C1 and C2, the two deciding claims, are both confirmed — and the capture's clean split
("credentials are protected by default; customer PII is not") does not survive C4.** The PII half is
exactly as bad as predicted: a customer record reaches thirteen destinations with every one of seven
sentinels intact, and nothing in the default path removes a single one of them. The credential half
holds for credentials the library _places_ — a declarative `bearer`/`apiKey` never enters the event
stream at all — and fails for credentials that ride the payload: a vendor's `access_token` in a
response body, and a `client_secret` in a request body, are both written to the JSONL log in full.

`sensitive: true` is settled. It is a cache opt-out and only a cache opt-out: 1 of 11 destinations
changed, and it was the cache. Across the whole of `packages/core/src` there is exactly **one**
read of the value.

Two ADR claims were refuted by measurement:

- **ADR 0018 §4** — "`findings` never leak a secret even when `redact` is off". True of soft drift,
  conditional for hard validation, where the finding `detail` is the validator's own message copied
  verbatim — so the message's wording decides. Stock Zod 4 (the workspace's validator since #589)
  no longer echoes the received value and every sink measures clean (C7(g)); a message that does
  embed the input — a custom `refine`/`check` message here, Zod 3's enum wording at the time this
  was first measured — reaches `consoleSink` and `loggerSink`, the two sinks C1 measured as
  carrying nothing (C7(h)).
- **`DriftOptions.severity`** — "soft drift is always non-fatal". At the type level yes
  (`DriftSeverity` excludes `error`); at runtime `severity: { undeclared: 'error' }` re-levels the
  finding and fails the call (C7(f)).

And a third thing that is not in the claims at all: **`console.error(err)` is safe and
`logger.error({ err })` is not.** `StitchError.body` is an own **enumerable** property while
`message` is not, so `err.stack` and `String(err)` carry nothing and `JSON.stringify(err)` carries
the entire customer record (C1(g)).

Every script is standalone and offline. The transport is a fake in-memory `Adapter`; the only file
written is a JSONL trace under a `mkdtemp` directory that each script deletes.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c1-where-does-it-go.ts

# all of them
for f in docs/scenarios/proofs/pii-in-the-logs/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set — `--ignoreConfig` because TypeScript 6
makes a file list alongside a `tsconfig.json` an error (TS5112), and here the flags are the
whole config:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/pii-in-the-logs/*.ts
```

## The method: sentinels, not reasoning

Every claim here reduces to one question — _did this exact string reach that destination?_ — so the
primitive in [`harness.ts`](harness.ts) is not a value comparison but a **substring scan of a
destination's serialized bytes**, per sentinel, with the byte count reported alongside. A
destination is whatever can be reduced to bytes: the file a sink wrote, an intercepted
`process.stderr.write`, the messages handed to a `LoggerLike`, `JSON.stringify` of a wrapper, the
values a `StitchStore` was handed. The scan is deliberately `String.includes` — a cleverer matcher
would let the harness decide what counts as a leak.

The seven sentinels in [`canary.ts`](canary.ts) are chosen to break each of the field's named
workarounds in turn:

| code  | where it lives            | breaks                                      |
| ----- | ------------------------- | ------------------------------------------- |
| `nm`  | `customer.name`           | no denylist has ever contained "name"       |
| `em`  | `customer.email`          | the one field every denylist _does_ contain |
| `ssn` | `customer.ssn`            | the one field every compliance doc names    |
| `nst` | `profile.contact.mail`    | a flat denylist misses it                   |
| `txt` | inside a free-text `note` | a key-based redactor cannot see it at all   |
| `arr` | `contacts[1].email`       | needs a walker, not a `delete`              |
| `ren` | `primaryContactMail`      | the "vendor added a field" case, today      |

An eighth (`LATE`) exists only for the truncation measurement in C1(b2): it sits past the JSONL
sink's default 2048-character cap, so its absence measures the cap and not a policy. Sharing a
literal with an early field would have made a truncation measurement read as a survival — which is
exactly what happened on the first run of this directory, and the fix is recorded in `canary.ts`
rather than quietly applied.

## What each script establishes

| Script                   | Question                                   | Measured                                                                                                         |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `c1-where-does-it-go.ts` | where does the body go by default?         | **13 destinations carry all 7; 11 carry none.** No partial redaction anywhere. `logger.error({err})` leaks       |
| `c2-sensitive.ts`        | does `sensitive: true` affect any logging? | **No. 1 of 11 destinations changed — the cache.** One read of the value in the whole of `packages/core/src`      |
| `c3-inspect-redact.ts`   | what does `.inspect({ redact })` redact?   | **`redact: true` removes 0 of 7.** It is the credential denylist reused. Named lists work at depth and in arrays |
| `c4-credentials.ts`      | is the credential half genuinely safe?     | **PARTIAL.** Declarative auth 0/3 everywhere; a token in a RESPONSE body is written to the log 3/3               |
| `c5-boundary.ts`         | can PII be stripped at the boundary?       | **Yes — and only `hooks.onResponse` covers the failure path.** Order measured, not inferred                      |
| `c6-allowlist.ts`        | is an allowlist expressible?               | **Yes, 7 → 0 at every value-reading destination.** Residue: `.inspect().raw` and `StitchError.body`              |
| `c7-drift-signal.ts`     | does drift notice a new PII field?         | **Yes, 3 new `undeclared` findings, 0 values.** ADR 0018 §4 is only as safe as the validator's message wording   |
| `c8-assembled.ts`        | the best available setup, and its cost     | **42 lines, 2 seams, 0 of 9 destinations.** The boundary and the drift signal are mutually exclusive             |

## The C1 table

The deciding measurement, printed verbatim by `c1-where-does-it-go.ts`. `●●` = the literal sentinel
is present in that destination's bytes.

```
  destination                       bytes   nm  em ssn nst txt arr ren
  ------------------------------  -------  --- --- --- --- --- --- ---
  event:start                         263    ·   ·   ·   ·   ·   ·   ·
  event:progress                       68    ·   ·   ·   ·   ·   ·   ·
  event:result                        560   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  event:done                           69    ·   ·   ·   ·   ·   ·   ·
    └ result.data                     490   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  fileSink (default)                  970   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  fileSink body:{chars:false}        6622   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  fileSink body:false                 523    ·   ·   ·   ·   ·   ·   ·
  fileSink (default, 2.9KB body)     2815   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  consoleSink (stderr)                188    ·   ·   ·   ·   ·   ·   ·
  loggerSink                          161    ·   ·   ·   ·   ·   ·   ·
  .inspect().raw                      490   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  .inspect().data                     490   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  JSON.stringify(inspect())           555   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  JSON.stringify(report())            721   ●●  ●●  ●●  ●●  ●●  ●●  ●●
    └ report.config                   101    ·   ·   ·   ·   ·   ·   ·
  StitchError.body                    490   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  StitchError.message                   8    ·   ·   ·   ·   ·   ·   ·
  String(err) + err.stack             600    ·   ·   ·   ·   ·   ·   ·
  JSON.stringify(StitchError)         597   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  event:error (JSON)                  103    ·   ·   ·   ·   ·   ·   ·
  cache entry (store.set)             627   ●●  ●●  ●●  ●●  ●●  ●●  ●●
  otlpSink (exported spans)           455    ·   ·   ·   ·   ·   ·   ·
```

Three things are worth reading off it directly.

**There is no middle.** Every destination is 7 of 7 or 0 of 7. Nothing in the default path removes
`email` while keeping `plan`; either a destination gets the body or it gets metadata. That is a
_good_ property to have measured, because it means the exposure is a small set of well-defined
seams rather than a diffuse smear — but it also means there is nothing to tune. `redactHeaders` is
the only config-reachable body redaction in the whole library, and its documentation says it takes
header names.

**Truncation is not redaction.** `fileSink (default, 2.9KB body)` still carries all seven. The cap
kept a 2048-character _prefix_; the eighth sentinel is missing purely because it sits at character
~2500. Reorder the vendor's JSON and the set that leaks changes.

**Non-enumerability protects one field.** `.inspect().raw` is non-enumerable, exactly as ADR 0016
says. `.inspect().data` — holding the same record — is not, so `JSON.stringify(wrapper)` leaks
everything anyway. The same shape repeats on `StitchError`: `body` is enumerable, `message` is not.

## The seam order (C5)

Measured by an execution log the seams write to in the order they actually fire, not read off the
source:

```
hooks.onRequest → hooks.onResponse → interpret → transform → output.validate
```

`hooks.onResponse` (engine.ts:705) is the earliest seam that sees a response body. On the **success**
path all three candidate seams are equivalent — each takes every destination from 7 to 0. On the
**failure** path they are not: a 500 leaves `StitchError.body` at 7/7 under `transform` and under a
stripping `interpret`, because the engine throws carrying the untouched `res` (engine.ts:824-831).
Only `hooks.onResponse` still holds, because it _mutated_ the object the error later carries.

That mutation — `ctx.res.body = …` inside a hook typed `(ctx) => void` — is the single most
load-bearing construction in this directory, and it is documented nowhere as a privacy mechanism.

## The tension C8 exists to name

The boundary and the drift signal are mutually exclusive with the shipped seams:

- `output: drift(SAFE)` filters every value-reading destination **and** emits a value-free inventory
  of everything it stripped. It cannot touch `.inspect().raw` or the failure path.
- `hooks.onResponse` covers **everything**, including the failure path — and takes the drift signal
  to **zero findings**, because drift diffs the response against the schema and the boundary removed
  the response before the schema ever saw it.

Having both means writing the key-diff walker yourself. `c8-assembled.ts` does, in 23 lines that
re-implement what `drift.ts` already contains and does not export, for a total of 42 executable
lines across two seams and 0 of 9 destinations leaking on both the success and the failure path.
The counts are read off the file at runtime, as this repository's Prettier formats it.

None of it is upstream of the `Adapter`, which read the bytes first — measured in C8(f).

## Why this directory imports Zod by path

Same reason as [`../precision-loss/zod.ts`](../precision-loss/zod.ts): C6 asks whether a stripping
`output` schema keeps fields out of the log, and the stripping _is_ the behaviour under test. A
hand-rolled `{ validate }` stub would let this directory invent its own answer. In application code
the spelling is `import { z } from 'zod'`.
