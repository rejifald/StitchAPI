# Issue draft — `hooks.onResponse` can rewrite the call, and a seam-level `kind` is a compile error that works

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`deprecation-headers`](../deprecation-headers.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `docs`, `hooks`, `types`

> This scenario was run as a consolidation test — three earlier ones each hit "the header isn't
> on this accessor", and the goal was a definitive answer. **The answer is a positive**:
> response headers _are_ reachable on a successful call, in exactly three places, and
> `Surface.interpret` is the one seat where a header and the returned value are in scope
> together. The full table is in §4 and is worth putting in the surfaces reference.
>
> Three findings sit beside it.

Reproduce:

```bash
for f in docs/scenarios/proofs/deprecation-headers/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. `hooks.onResponse` can change what a stitch returns

**Severity: medium-high — the guide states the opposite.**

The hooks guide says hooks _"never change what a stitch returns"_. Measured, that is true of the
hook's **return value** and not of `ctx.res`, which is the engine's live `AdapterResponse`
(handed over at `engine.ts:705`, read again by `interpret` at `:775`):

| mutation in `onResponse` | measured effect                                                            |
| ------------------------ | -------------------------------------------------------------------------- |
| `ctx.res.body.x = …`     | the key appeared in the value the caller received                          |
| `ctx.res.status = 503`   | the vendor's **200 became a thrown `HTTP 503`**                            |
| `ctx.res.headers[…] = …` | a downstream surface read `"REWRITTEN BY HOOK"` instead of the real header |

Either the guide should say `ctx.res` is live and mutable — with the status case called out,
because turning a 200 into a throw is a big lever to find by accident — or `ctx.res` should be
frozen/cloned for hooks. The current pairing (documented as inert, actually a write channel) is
the worst of the two.

Three further limits worth documenting alongside, all measured: `onResponse` fires **once per
attempt** (3 firings for one retried call, each carrying the same notice); `HookContext` has no
`emit`/`run`/`findings`, so nothing a hook learns can reach the event stream or the drift report;
and the only way out is a closure with no de-duplication of its own.

## 2. A seam-level `kind` is a compile error that works perfectly at runtime

**Severity: medium — it costs 40× the code for a capability that already works.**

`seam({ kind: mySurface })` fails to typecheck — `TS2353: 'kind' does not exist in type
'SeamOptions'` — and the engine honours it anyway: members inherited the surface and behaved
correctly in the measurement.

So a typed codebase writes the surface onto all forty members to get something one seam-level
declaration already delivers.

**Ask:** either add `kind` to `SeamOptions` (it works), or make the runtime reject it so the
types and the behaviour agree. This is the same shape as scenario 13's
`stream({ kind })` **silently dropping** the surface — the two are opposite failures of the same
seam/`kind` relationship, and are probably worth fixing together.

## 3. `parseRetryAfter` is exactly the function needed, and is unreachable

**Severity: low-medium — the second sighting, and worse than the first.**

`parseRetryAfter` (in `resilience.ts`) parses delta-seconds **or** an HTTP-date against an
injectable clock and returns ms-until. That is precisely the `Sunset` requirement — pointed at
the fleet's three real `Sunset` values it returned the right ms every time.

It is not reachable: `resilience.ts` is not among the 17 published export subpaths, and
`index.ts` re-exports only `RateLimitError` from it. The barrel's three `parse*` helpers
(`parseDuration`, `parseBytes`, `parseRate`) do not parse dates —`parseDuration` returns
`undefined` for both an HTTP-date and a structured-field date.

[Scenario 14](sigv4-ignores-the-injected-clock.md) raised this for a surface author reading
`Retry-After`; here the unexported helper isn't merely _similar_ to what's needed, it is
identical.

**And the naive substitute is silently wrong:** `Date.parse("@1735689600")` is `NaN`, so a
client reaching for `Date.parse` reads `Sunset` correctly and reports **no deprecation** for the
format RFC 9745 actually mandates.

**Ask:** export `parseRetryAfter` (or a `parseHttpDate`) from the barrel.

## 4. The accessor → headers table, for the surfaces reference

Measured across every accessor on a **successful** call. Worth publishing, because three
scenarios in this pass each rediscovered one row of it:

|                                              | carries response headers                             |
| -------------------------------------------- | ---------------------------------------------------- |
| `adapter`                                    | yes — knows no stitch name, cannot change the result |
| `hooks.onResponse`                           | yes — full `AdapterResponse` + `ctx.name`            |
| **`Surface.interpret(res, cfg)`**            | **yes — and it returns the resolved value**          |
| `await` / `.unwrap()` / `.safe()`            | no                                                   |
| `.inspect()` (5 keys) / `.report()` (9 keys) | no                                                   |
| `StitchError` (5 keys)                       | no                                                   |
| `transform`                                  | no — its one parameter is the body                   |
| the event spine — 4 events, 15 distinct keys | **no**                                               |

The last row has the consequence: **no event carries a header, so a `TraceSink` can only
aggregate what a `Surface` folded into the value.** Worth stating explicitly next to the trace
docs.

## 5. Smaller findings

- **No API mints a levelled finding.** A `Validator` returns a value or _issues_, and an issue is
  `error | invalid` that fails the call. The only door onto the drift channel is folding a field
  into the value and letting an undeclaring `output` report it `info | undeclared` — non-fatal
  and re-levellable, but it carries **neither the value nor the endpoint**, and re-levelling is
  per-_kind_, so raising a deprecation notice to `warn` also raised an unrelated new vendor field.
- **An `output` contract deletes a folded field** before the `result` event fires, with no
  warning — so the surface-folds-it/sink-reads-it path breaks the moment someone adds a schema.
- **Nothing de-duplicates an observation.** 600 calls → **360 lines carrying 3 facts**;
  `loggerSink` is louder at 2400. `levelOf` can drop an event but is a pure function of one
  event, so it can reach 600 and not 3. `cache.coalesce` de-duplicates _requests_ and `throttle`
  paces the _wire_; neither has anything to say about a repeated report.
- **`ctx.name` defaults to the literal `'stitch'`**, so two unnamed endpoints merge into one row
  at a sink. (Third sighting of the `'stitch'` default causing a collision — see
  [`resilience-has-no-tenancy`](resilience-has-no-tenancy.md) and
  [`any-is-priced-as-a-hedge`](any-is-priced-as-a-hedge.md) §4.)
- **A cache hit re-serves a header captured on the one wire response** — 9 of 10 rows were a
  replayed notice, so a long TTL will report a passed sunset as "in 12 days".
