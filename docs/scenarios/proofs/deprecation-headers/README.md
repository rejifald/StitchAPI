# Proofs — the vendor told you for six months, in a header

Runnable evidence for the claims in [`../../deprecation-headers.md`](../../deprecation-headers.md).

**C1 was the deciding claim and it refutes three earlier findings.** Response headers **are**
reachable on a successful awaited call. They are reachable in exactly three places — the `adapter`,
`hooks.onResponse` (`ctx.res.headers`), and a `Surface`'s `interpret(res, cfg)` (`res.headers`) —
and only the last of those can also decide what the call returns. Everything a caller normally
reaches for carries nothing: `await`, `.unwrap()`, `.safe()`, `.inspect()`, `.report()`,
`StitchError`, `transform`, and the entire event spine (4 events, **15 distinct keys between them,
not one a header**), which is why a `TraceSink` inherits the same hole.

[Scenario 6](../../conditional-requests-304.md), [scenario 7](../../multipart-upload.md) and
[scenario 15](../../unconfirmed-write.md) each concluded "no headers here" from an accessor that
genuinely has none, and each generalised one step too far. The `ETag` was never going to be in
`Inspection`; it was always in `interpret`. **The definitive table is
[below](#the-accessor-table--does-this-carry-a-response-header).**

The rest goes the library's way more often than not, and none of it is configuration:

- **C4 (aggregation) works and the scenario-12 shape transfers.** One `TraceSink` at the seam, 500
  calls over 5 endpoints, reported `3 endpoints deprecated (users, search, orders), earliest sunset
in 12 days: users` — one row per endpoint, and **identical when traffic was skewed 200:1 toward
  the healthy endpoints**, which is exactly what a per-call log line cannot do.
- **C5 (the tripwire) is exact.** `[sunset-1ms, sunset, sunset+1ms]` measured `["ok", "FAILED",
"FAILED"]` on an injected clock. It does **not** burn retry attempts (5 configured, 1 request
  made) and does **not** open the circuit breaker (5 consecutive trips past `failures: 2`).
- **C3 (findings) works through one narrow door.** A folded notice becomes
  `info|undeclared|_deprecation` on the ordinary drift channel, non-fatal, re-levellable to `warn`.

And three things go against it:

- **The header does not reach the sink on its own** (C4 c). No event carries headers, so a
  `TraceSink` can only aggregate what a `Surface` already folded into the value — and an ordinary
  `output` contract that does not declare `_deprecation` **deletes it again, silently** (C4 d).
- **`hooks.onResponse` is a write channel the docs say does not exist** (C2). Mutating `ctx.res`
  changes the result: `res.body` added a key to the caller's value, `res.status` turned a vendor
  `200` into a thrown `HTTP 503`, `res.headers` made the surface read a lie.
- **The line count goes against the library** (C8): **132 executable lines to a hand-rolled
  control's 81**, for identical output. The first scenario in this pass where that happens.

Every script is standalone and offline. Each prints one `PASS`/`FAIL` line and exits non-zero on
failure. **178 checks across 8 scripts.**

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c1-accessors.ts

# all of them
for f in docs/scenarios/proofs/deprecation-headers/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle. The suite takes about four seconds: every
sunset crossing is on a `manualClock`, and nothing here does real I/O.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/deprecation-headers/*.ts
```

## The accessor table — does this carry a response header?

**This is the consolidation deliverable.** Measured on a **successful** (`200`) awaited call whose
response carried `Deprecation: @1735689600` and `Sunset: Thu, 01 Jan 2026 00:00:00 GMT`. Reproduce
the whole table with `pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c1-accessors.ts`.

| Accessor                | Headers? | What it carries instead                                                 | Can it act?                                  |
| ----------------------- | -------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `await` / `.unwrap()`   | **no**   | the body, and only the body                                             | —                                            |
| `.safe()`               | **no**   | `{ ok, data, error }` — 3 keys                                          | —                                            |
| `.inspect()`            | **no**   | `{ data, raw, findings, status, error, source }` — `status`, no headers | —                                            |
| `.inspect().raw`        | **no**   | the pre-validation **body**                                             | —                                            |
| `.report()`             | **no**   | the above + `{ attempts, timing, config, cache }` — 9 keys              | —                                            |
| `.report().config`      | **no**   | the **request** config (its `headers` are the ones you _sent_)          | —                                            |
| `.stream()`             | **no**   | 4 events, **15 distinct keys**, none a header                           | —                                            |
| `TraceSink.handle`      | **no**   | the same events; `ctx` is `{ name, spanId, traceId }`                   | —                                            |
| `StitchError`           | **no**   | `{ attempts, body, name, status, url }` — 5 keys (scenario 15)          | —                                            |
| `transform(body)`       | **no**   | one argument, and it is the body                                        | —                                            |
| `pick` / `output`       | **no**   | operate on the value, downstream of the body                            | —                                            |
| **`adapter`**           | **YES**  | it _built_ the response — but knows no stitch `name`                    | no                                           |
| **`hooks.onResponse`**  | **YES**  | `ctx.res.headers` (full `AdapterResponse`) + `ctx.name`                 | **observe** (mutation works — see footgun 1) |
| **`Surface.interpret`** | **YES**  | `res.headers` + `cfg.name` + `cfg.clock`                                | **decides the value, and can fail the call** |

Read the two positive rows together: `onResponse` is the **observation** seat and `interpret` is the
**decision** seat. `interpret` is the only place in the library where a response header and the
value the caller receives are in scope at the same time — every answer in this directory is built on
that one fact.

## What each script establishes

| Script              | Question                                                  | Measured                                                                                                                   |
| ------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `c1-accessors.ts`   | **DECIDING** — is a response header reachable, and where? | **YES, in 3 places.** 11 accessors carry nothing; `adapter`/`onResponse`/`interpret` do. Event spine: 15 keys, 0 headers   |
| `c2-hooks.ts`       | does `onResponse` see them, and can it act?               | **Sees them. And MUTATES the result** — `res.body`, `res.status` (200→thrown 503), `res.headers`. Docs say it cannot       |
| `c3-findings.ts`    | can a header become a levelled, non-fatal finding?        | **Yes** — `info\|undeclared\|_deprecation`, re-levellable to `warn`. No value, no endpoint, and re-levelling is per-KIND   |
| `c4-aggregation.ts` | **DECIDING** — can a `TraceSink` produce the fleet view?  | **Yes: 500 calls → `3 endpoints deprecated …, earliest sunset in 12 days: users`.** But the header never reaches it alone  |
| `c5-tripwire.ts`    | fail after a chosen sunset, not before?                   | **Exact to the ms.** `["ok","FAILED","FAILED"]`. No retries burned, no circuit opened, `status: 200` preserved             |
| `c6-formats.ts`     | any parsing help for sf-date / HTTP-date?                 | **None reachable.** `parseRetryAfter` does the job exactly and is behind none of the 17 subpaths. **29 lines hand-rolled** |
| `c7-noise.ts`       | one line per call? de-dupable without hand-rolled state?  | **360 lines / 3 facts.** `loggerSink` default is 2400. `levelOf` drops to 600 and **cannot** reach 3. A `Set` can          |
| `c8-assembled.ts`   | the whole job, against a hand-rolled control              | **132 lines vs 81** — the library LOSES. Identical report, identical tripwire, 3 seams, **0 config keys**                  |

## Files

- `fake-vendor.ts` — five endpoints, three retiring, **every response a `200`**. The retirement
  notices exist only in headers, and three spellings are served on purpose: `Deprecation:
@1735689600` (RFC 9745 sf-date), `Deprecation: Sat, 01 Mar 2025 …` (the pre-RFC draft spelling,
  still emitted by real vendors), and `Sunset:` as an HTTP-date (RFC 8594, always). `NOW` is frozen
  at 2025-12-20, which puts `users` **exactly 12 days** from its sunset.
- `harness.ts` — `check` / `checkSeq` / **`checkReach`** / `checkAtMost` / `note` / `heading` /
  `finish`. `checkReach` is the assertion this scenario exists for: it prints the accessor, whether
  the header was REACHED, and the value — the C1 table is literally its output.
- `deprecation.ts` — the user-code module. Both parsers (bracketed by `BEGIN`/`END PARSERS`, which
  is what C6 counts), the `deprecationSurface` factory (`fold` / `onNotice` / `failAfterSunset`),
  and the `DeprecationWatch` `TraceSink`.
- `assembled.ts` / `hand-rolled.ts` — the answer and the control, both over the same `Adapter` and
  the same `Clock`, both delimited by `BEGIN`/`END USER CODE` so the line count is of code someone
  maintains. The control imports the same parsers, so the 29 parser lines cancel.

## Reading the numbers honestly

- **C1 is the headline and it should be read as a correction, not a win.** The library does not
  _surface_ headers — it exposes two seams that happen to have the response in scope. `Inspection`
  and `StitchError` still carry no headers, exactly as scenarios 6, 7 and 15 measured. What changes
  is the conclusion drawn from that: an `ETag` or a replay marker **is** recoverable, from
  `interpret`, at the cost of writing a `Surface`.
- **C4's success has a coupling attached and it is not visible in the type system.** The sink reads
  the notice off the `result` event's `data`; the data only has it because the surface folded it;
  and an `output` contract that does not declare `_deprecation` strips it back out. Three
  independently reasonable decisions, and the fleet report goes silently empty when they disagree.
  The `onNotice` side channel avoids all of it and gives up the trace channel in exchange.
- **The C8 line count is a genuine loss, and the reason is structural.** The control reads the
  header inline in the method that already had the response. StitchAPI needs a `Surface` object to
  reach it and a `TraceSink` object to remember it — two indirections for a job that is, at heart,
  four lines. What the extra lines buy is that the same seam already carries `retry`, `throttle`,
  `cache`, `circuit`, `auth`, `timeout` and the trace tree as config keys.
- **Zero config keys know about this problem**, and that is the correct reading of C8 — not a
  complaint. RFC 9745 says deprecation is a hint, so a default behaviour would be wrong; what a
  library owes here is a seam, and the seam exists.

## Footguns

1. **`hooks.onResponse` can rewrite the call, and the documentation says it cannot.** The hooks
   guide states hooks "never change what a stitch returns — a call's only result is its response".
   Measured, that is true only of the hook's **return value**. `ctx.res` is the engine's live
   response object (engine.ts:705) and the same object reaches `interpret` seventy lines later
   (engine.ts:775), so mutating it works: `res.body` changed the caller's value, `res.status = 503`
   turned a vendor `200` into a thrown error, and `res.headers` made a surface read `"REWRITTEN BY
HOOK"`. A hook and a surface reading the same header will disagree, and the hook wins.
2. **Seam-level `kind` is a compile error that works perfectly at runtime.**
   `seam({ baseUrl, kind })` fails with `TS2353: 'kind' does not exist in type 'SeamOptions'`, yet
   the engine composes it into every member — measured, members inherited `http+deprecation` and
   folded correctly. A typed codebase therefore writes the surface on all 40 members for a
   capability that already works from one.
3. **`ctx.name` defaults to the literal `"stitch"`.** `name` falls back to `path` or `'stitch'`, and
   a `url`-configured stitch has no `path` — so **two different unnamed endpoints both arrive at the
   sink as `stitch`** and a `Map` keyed on `ctx.name` silently merges them into one row. The URL is
   only on the `start` event; recovering it costs a second `Map` keyed by `ctx.spanId` and a join.
4. **A cache hit re-serves a header captured once.** 10 calls, 1 wire request, and the sink counted
   10 — nine of them replaying a `Sunset` read once. With a long TTL a sunset that has already
   passed keeps reporting as "in 12 days" until the entry expires.
5. **`Date.parse('@1735689600')` is `NaN`.** The obvious one-liner reads `Sunset` correctly and
   reports **no deprecation at all** for the format RFC 9745 mandates — silently, because `NaN` is
   falsy and every naive guard treats it as absent.
6. **`.report()` and `.inspect()` are fresh runs** that each add a request _and_ a tick to anything
   the sink is counting (the same trap scenario 12 measured for drift rates).
7. **Re-levelling a header-derived finding is per-KIND, not per-path.** `severity: { undeclared:
'warn' }` raised the deprecation notice to `warn` and raised an unrelated new vendor field with
   it, in the same run.
