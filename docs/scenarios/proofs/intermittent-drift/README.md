# Proofs — the vendor changed the shape for 5% of responses

Runnable evidence for the claims in [`../../intermittent-drift.md`](../../intermittent-drift.md).

**This is the one scenario in the pass where the library mostly wins, and the capture was wrong in
the library's favour on both deciding claims.** C3 predicted a silent `NaN`/`0`; measured, the
default posture is a _hard failure_ — `z.number()` on `"12345"` fails the call, and even
`z.coerce.number()` on `"abc"` fails, because Zod rejects `NaN`. C6 predicted aggregation was the
gap, on the strength of every other scenario in this pass finding no cross-call state; measured,
`trace` is a real aggregation seam and an 84-line sink reports
`5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)`.

**Two findings survive that anyway, and both are about the same hole: the finding carries KINDS,
not VALUES.** `warn|coerced|transaction_id|string -> number` is byte-identical for `"12345"` → the
correct `12345` and for `"abc"` → a literal `0`. And `z.coerce.number()` maps `null`, `""`, `"  "`,
`false`, `[]` and `"0"` all to exactly `0`, so the geocoder-style intermittent null and the
$0-transaction are **the same bug** on a money field.

Every script is standalone and offline. The evidence is **the value the caller received** — every
assertion prints it with `JSON.stringify`, because `0` and `"0"` and `null` have to be
distinguishable on the page. Time is load-bearing only where a rate needs a window, so `manualClock()`
drives C6(f) and all of C8.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c3-the-zero-dollar-test.ts

# all of them
for f in docs/scenarios/proofs/intermittent-drift/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/intermittent-drift/*.ts
```

### Why this directory imports Zod by path

`drift()` reports the difference between the raw body and **whatever your validator returned**. It
performs no coercion of its own. So the question C3 asks — "what does the caller actually receive
when `transaction_id` stops being a number" — is answered by the schema library's coercion rules,
and hand-rolling a `{ validate }` stub (what every other scenario in this section did) would mean
inventing the behaviour under test. These scripts use the real Zod v4 that `packages/core` already
depends on, reached via `packages/core/node_modules/zod` because pnpm does not hoist it to the
workspace root and `docs/` has no manifest. See [`zod.ts`](./zod.ts). In application code the
spelling is `import { z } from 'zod'`.

## What each script establishes

| Script                       | Question                                              | Measured                                                                                              |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `c1-added-field.ts`          | an ADDED field — alarm? level? does the value arrive? | **`info`, one finding, and the value is STRIPPED.** 51 added values → 2 findings                      |
| `c2-removed-field.ts`        | a REMOVED field — caught? distinguishable from C1?    | **Yes, `error` vs `info` — but only if you declared it required.** 4 declarations, 4 answers          |
| `c3-the-zero-dollar-test.ts` | the $0-transaction test, both directions              | **Default is SAFE. Two spellings give a literal `0`, and the finding is IDENTICAL to the benign one** |
| `c4-intermittent-null.ts`    | null on 5% — fires only there? names the field?       | **Yes: 5 findings on calls [20,40,60,80,100], each naming `formatted_address`. No nullable LEVEL**    |
| `c5-severity.ts`             | four classes, four severities, declaratively?         | **Three kinds re-level in one literal. Keyed by MECHANISM, not class. No per-path severity**          |
| `c6-aggregation.ts`          | can you learn "5% of calls drifted on field X"?       | **Yes — `5.0% of calls: ... (5/100, 5 landed 0)`, and 5%→25% across a window. Three counting traps**  |
| `c7-accessors.ts`            | is the finding actionable, and on which accessor?     | **Path always; expected/actual only on HARD findings. `.safe()` carries NOTHING for a soft one**      |
| `c8-canary-watch.ts`         | the assembled answer, priced                          | **Silent on additions, one alert line per breaking class at 5%, 0 zeros — and 93 lines vs 92**        |

## Files

- `fake-vendor.ts` — the vendor rolling a change out to a percentage of traffic. Five named
  mutations, one per industry change class, plus the two halves of the type change the scenario
  turns on: `retyped` (`12345` → `"12345"`, a plausible string) and `garbage` (`→ "abc"`, the same
  wire-type shift with a value that cannot be recovered). `rate: 0.05` means **every 20th call**,
  not a coin flip, so "5 of 100" is a fact on every machine. `vendor.mutatedCount` is the ground
  truth every measured rate is checked against.
- `zod.ts` — the one-line re-export, and the note on why it is a path.
- `drift-rate.ts` — the aggregating `TraceSink`. **This is the C6/C8 deliverable and it is user
  code**: it counts logical calls off `start`, collapses N findings to one drifted call on
  `ctx.spanId`, evicts on an injected clock for a rolling window, and joins each finding to its
  run's `result` event so it can report that a coercion landed on `0`. 84 counted lines.
- `canary-watch.ts` — the declarative half of the assembled answer, in its own file so C8 can count
  it. A strict schema plus one `severity` override. 9 counted lines.
- `hand-rolled.ts` — the same feature set with no library at all: classify against a declared shape
  into the four industry classes, keep the value only where it is unambiguous, maintain a windowed
  per-field rate. 92 counted lines. The baseline C8 prices against.
- `harness.ts` — `check` / `checkSeq` / `note` / `heading` / `finish`. No test framework. `check`
  prints with `JSON.stringify` rather than `String`, because this scenario's whole content is
  telling `0` from `"0"` from `null`.

## Reading the numbers honestly

- **C1 is the cleanest result in this scenario, with a half nobody writes down.** An added field is one
  `info|undeclared|settlement_delay_ms|undeclared field (number)`, the call succeeds, `ignore`
  silences it without touching the schema, and 51 added values across a 50-element array collapse
  to **2** findings (`all 50 elements: …` plus a `sample` coordinate). The unwritten half: the
  engine serves the **validated** value (engine.ts:1264) and a Zod object strips unknown keys, so
  `data.settlement_delay_ms` is `undefined`. **Drift tells you a field appeared and simultaneously
  guarantees you cannot read it.** The trade is exact — with a schema you get the finding and lose
  the value; without one you get the value and no finding.
- **C2's level distinction is real and it is not a property of the removal.** `error|invalid|
currency|Invalid input: expected string, received undefined` against C1's `info|undeclared` is
  three levels and a different kind. But the
  same wire body against `.optional()` produces a successful call and **zero findings**, and against
  `.default("usd")` produces `verbose|defaulted` **plus a currency the vendor never sent**. One
  vendor change, four declarations, four answers. "Removal is breaking" is something you have to
  have already declared.
- **C3 refutes the capture on the mechanism and confirms it on the outcome.** `z.number()` on
  `"12345"` is `error|invalid|transaction_id|Invalid input: expected number, received string` and
  the call fails with `data: null`. `z.coerce.number()` on `"abc"` **also** fails — `Number("abc")` is `NaN` and
  Zod rejects `NaN`. StitchAPI does not manufacture a $0 charge on its own.
- **Two ordinary spellings do, and one of them needs no `.catch()`.** `z.coerce.number().catch(0)`
  on `"abc"` hands the caller literal `0`. And `z.coerce.number()` on **`null`** hands the caller
  literal `0`, because `Number(null) === 0` — six wire values (`null`, `""`, `"  "`, `false`, `[]`,
  `"0"`) coerce to exactly `0` and only `"abc"` and `undefined` reject.
- **And the finding cannot separate them.** `warn|coerced|transaction_id|string -> number` is what
  you get for `"12345"` → `12345` and byte-for-byte what you get for `"abc"` → `0`, because `detail`
  is `kindOf(old) -> kindOf(new)` (drift.ts:77-83). **No alert built on findings alone can tell a
  correct coercion from a $0 charge.**
- **The schemas people write to survive drift are the ones that make it invisible.**
  `z.union([z.number(), z.string()])` and `z.unknown()` accept both shapes, so raw === validated, so
  `diff` produces nothing: the caller gets the raw `"12345"` with **zero findings**, and every
  `=== 12345` in the codebase is now false.
- **C4 is the library at its most precise.** Over 100 calls with 5 nulled, drift fired on exactly
  calls `[20,40,60,80,100]` — matching the vendor's own ledger — with zero false positives on the
  other 95, each finding naming `formatted_address`.
- **But there is no nullable LEVEL, and that is a genuine gap against the industry taxonomy.** One
  null, four declarations: required → `error|invalid` and a failed call; `.nullable()` and
  `.nullish()` → **nothing at all** (declared variance, raw === validated); `.catch("")` → `warn`
  and a fabricated `""`. "Warning-level, value intact" is not one of the options, and `.nullable()`
  — the correct schema for a sometimes-null field — makes a 5% rollout completely invisible.
- **C5: the vocabulary is keyed on the wrong axis.** `severity` maps `undeclared`/`coerced`/
  `defaulted` (types.ts:72) — what your _schema_ did — not addition/removal/type-change/nullable —
  what the _vendor_ did. Only addition maps 1:1. The three soft kinds re-level fully in one literal,
  and `severity: 'warn'` is an emission-time allowlist (drift.ts:147) — **a finding you filtered out
  never reaches a trace sink either**, so you cannot filter and count the same kind.
- **There is no per-path severity.** `resolveSeverity` (drift.ts:90-101) never sees the path.
  `ignore` is path-aware and it is on/off. "A coercion on `transaction_id` pages, a coercion on
  `description` does not" has no spelling.
- **`error` is type-blocked and runtime-live.** `DriftSeverity` excludes `'error'` (types.ts:74) and
  the docs say fatality is the schema's job — c5(e) asserts the rejection with `@ts-expect-error`.
  Cast past the type and the runtime honours it: `severity: { coerced: 'error' }` produced
  `error|coerced|transaction_id` and **failed the call** (`levelOf` at drift.ts:100 →
  `finding.level === 'error'` at engine.ts:1256). Off-contract; the documented route is a strict
  schema, which also gives a better message.
- **C6 refutes the capture's central prediction. `trace` is a real aggregation seam.** A `TraceSink`
  is configured once, receives every event of every call, and `ctx.spanId` identifies the logical
  call — the one place in the library where cross-call state is the design rather than a leak
  (contrast scenario 7's `HookContext` and scenario 11's leaking `items` closure). Measured:
  `5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)`, and 5.0% → 25.0%
  across a rolling window on an injected clock.
- **The sink is also the only place the $0 charge is diagnosable in-flight.** Findings and the
  `result` event share a `spanId`, so joining them recovers what C3(e) showed the finding cannot
  say: `10/10, 5 landed 0` — same finding, half of them zeros.
- **Three counting traps, all measured.** (1) **Findings are not calls**: two drifted fields on one
  response is two findings, so a naive `findings / calls` reads 200%. (2) **A cache hit divides your
  rate by the hit ratio**: a hit emits `start` and `result` but no drift (engine.ts:1668-1680), so 5
  calls against a **100%**-drifting vendor measured **20%**, with every line of code correct.
  (3) **`.report()` pollutes both sides of the fraction**: it is a fresh run, so it added a request
  _and_ a tick to the denominator.
- **C7: the field path is always there; expected/actual is only half there.** A hard finding carries
  both types (`Invalid input: expected number, received string` — Zod's message). A soft one carries
  `kindOf(old) -> kindOf(new)` and no values, on any accessor except `.inspect().raw`.
- **`.safe()` is the worst accessor and it is the one everybody uses.** On a soft finding it carries
  **nothing** — `{ok: true, data, error: null}` and a `transaction_id` of `0`. On a hard one it
  carries `contract violation (drift)`; `StitchError` has `{status, attempts, body, url}` and **no
  `findings`** (types.ts:1857-1891), while the trace sink for the _same run, same instant_ named the
  field and both types.
- **`.stream()` is the cheap live accessor and `.inspect()` is the diagnostic one.** `.stream()`
  gives every finding plus the validated value in **one** request (`start, progress, drift, drift,
result, done`). `.inspect()` is the only accessor with **raw** (`"abc"`) and **validated** (`0`) in
  one object — and it is a fresh probe. `.report()` on the drifting stitch reported **zero
  findings**, because the probe hit a clean response.
- **C8's strict posture hits the target exactly.** Six workloads × 100 calls, one configuration:
  silent on a 100% addition rollout, one alert line per breaking class at 5% carrying rate + field +
  both types, and **zero $0 charges on every workload**. The soft schema a team writes when the
  strict one starts failing calls keeps 100% availability and produces **ten** $0 charges.
- **The price is a wash, and the hand-rolled version wins one row.** 9 declarative lines + an
  84-line sink = 93, against 92 hand-rolled. The _detection_ is 9 lines against ~35; the
  _aggregation_ is ~84 lines of user code either way. And the hand-rolled classifier expresses the
  fourth industry class — null → `warn`, value passed through — that C5 measured as inexpressible in
  `DriftOptions`. What the 92 lines do not have is the resilience stack: one `retry` line absorbed
  8 × `503` mid-canary and the rate still counted **100 logical calls out of 108 wire requests**.

## The footguns

- **A `coerced` finding cannot tell you whether the value is right.** `warn|coerced|transaction_id|
string -> number` is identical for `12345` and for `0`. If you alert on findings, alert on the
  _rate_, and join to the `result` event if the field is money.
- **`z.coerce.number()` maps `null` to `0`.** No `.catch()`, no garbage string, no error — just a
  vendor that starts nulling a field on 5% of responses. `""`, `"  "`, `false` and `[]` do the same.
  Never put `z.coerce.number()` on a money or identity field.
- **`.catch(0)` is a $0 transaction generator.** It exists to keep calls succeeding, and the value
  it succeeds with is the one your business logic will act on.
- **A tolerant schema is a blind one.** `z.union([number, string])`, `z.unknown()`, `z.any()`: raw
  === validated, so `diff` produces nothing and `drift()` reports nothing. The schema you write to
  stop the alarms is the schema that removes them.
- **An `.optional()` field can be deleted by the vendor in total silence.** Absent in raw, absent in
  validated, no diff, no finding, `ok: true`. Audit your optionals — each one is a removal you have
  pre-approved.
- **`.default()` on a removed field fabricates a value and logs it at `verbose`.** The quietest
  level in the vocabulary, and dropped entirely by `severity: 'warn'`.
- **A plain `output` schema without `drift()` coerces in complete silence.** Same coercion, same
  stripping, zero findings. `drift()` is the diagnostic wrapper, not the validator.
- **Caching silently divides your drift rate.** A hit emits `start`/`result` but never a drift
  finding. Your measured rate is the true rate × miss ratio, and nothing warns you.
- **Filtering with `severity` also deletes the data.** The allowlist runs at emission (drift.ts:147),
  so a filtered kind is invisible to the trace sink too. Re-level with the map form if you want it
  quiet _and_ counted.
- **`findings / calls` is not a drift rate.** One response with two drifted fields is two findings.
  Collapse on `ctx.spanId` first.
- **`.report()` and `.inspect()` are fresh probes, not readbacks.** They cost a request, they tick
  your counters, and they answer about a _different_ response than the one that hurt you. C7(e)
  measured `.report()` returning zero findings immediately after a call that drifted.
- **A soft drift is invisible on the awaited path.** `ok: true`, `error: null`, `data` holding a
  `0`, and nothing on the result object to read. If you only ever call `.safe()`, `drift()` is
  configured and doing nothing for you — wire a `trace` sink or use `.stream()`.
