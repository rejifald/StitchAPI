# Issue draft — a `coerced` finding can't say whether the coercion was destructive, and the nullable class has no level

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`intermittent-drift`](../intermittent-drift.md)
**Suggested template:** feature_request.yml · **Suggested labels:** `drift`, `validation`, `enhancement`

> **Leading with what held up**, because this is the flagship feature and it tested well. The
> default is safe: `z.number()` on `"12345"` fails the call, and `z.coerce.number()` on `"abc"`
> fails too because Zod rejects `NaN`. StitchAPI does not manufacture a $0 charge on its own,
> and the capture's fear that it might is **refuted**. Precision is excellent — 5 findings on
> exactly the 5 drifting calls out of 100, each naming the field. And aggregation, which the
> capture predicted would be missing, **works**: `trace` + `ctx.spanId` measured a canary
> widening 5.0% → 25.0%.
>
> Two gaps survive that, and one footgun sits next to them.

Reproduce:

```bash
for f in docs/scenarios/proofs/intermittent-drift/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. A `coerced` finding cannot distinguish a harmless coercion from a destructive one

**Severity: medium-high — the finding is emitted, and it is not enough to act on.**

`detail` is built from `kindOf(old) -> kindOf(new)` (`drift.ts:77-83`), so the values never
appear. Measured, on the same field:

| wire value               | caller receives       | finding                                                 |
| ------------------------ | --------------------- | ------------------------------------------------------- |
| `"12345"`                | `12345` — correct     | `warn \| coerced \| transaction_id \| string -> number` |
| `"abc"` with `.catch(0)` | **`0`** — a $0 charge | `warn \| coerced \| transaction_id \| string -> number` |

**Byte-identical.** A sink, an alert rule, or a human reading the trace cannot tell the benign
row from the catastrophic one. The only way to separate them measured in this scenario is to
join the `drift` event to the `result` event on `ctx.spanId` inside a custom sink — which is
exactly the work the finding was supposed to save.

**Ask:** carry the values (or a redacted/typed summary of them) on a `coerced` finding, or add a
sub-kind distinguishing a _lossless_ coercion (`"12345" → 12345`, round-trips) from a _lossy_
one (`null → 0`, `"abc" → 0` via `.catch`). The information exists at the moment the finding is
built; it just isn't kept.

## 2. "Nullable is a warning, value intact" has no spelling

**Severity: medium — the fourth industry change class is inexpressible.**

The published taxonomies all treat a field _becoming nullable_ as warning-level: not breaking,
but worth knowing. Measured against one null, four declarations, four answers — and none of them
is that:

| declaration                  | result                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| required                     | `error \| invalid` + **failed call** (and the four fields that were fine are discarded with it) |
| `.nullable()` / `.nullish()` | **nothing at all** — declared variance, so the 5% rollout is completely invisible               |
| `.catch('')`                 | `warn \| coerced` + a **fabricated `""`** the vendor never sent                                 |

`.nullable()` is the schema a team actually ships for availability, and it is the one that hides
the rollout. The hand-rolled classifier written for the comparison **beats `DriftOptions` on
exactly this row** — it levels a null `warn` and passes the value through.

**Ask:** a `nullable` change kind (or a `DriftOptions` mode) that reports a newly-null field at
`warn` while passing the value through unchanged.

## 3. `severity` is keyed by mechanism, not by change class

`DriftSeverity` takes `undeclared` / `coerced` / `defaulted` (`types.ts:71-74`). Of the four
industry change classes, only **addition** maps 1:1 (`undeclared`). Removal, type change and
nullability each land on a kind decided by _your schema_, so their loudness is a schema decision
rather than a severity one — which makes "removal is fatal" something you have to have already
declared rather than something you can configure.

Two smaller limits alongside it, both measured:

- **No per-path severity.** `ignore` is the only path-aware lever and it is on/off
  (`drift.ts:90-101` never sees the path). "Coercion on `transaction_id` pages, coercion on
  `description` doesn't" has no spelling.
- **A soft finding can't be promoted to fatal through the type** — `error` isn't in
  `DriftSeverity` (machine-checked with `@ts-expect-error`), though a cast past it does fail the
  call at runtime, which is an odd pairing.

## 4. Soft findings are invisible on the awaited path

`await` and `.safe()` carry **nothing** for a soft finding — the caller gets `{ok, data, error}`
and, in the bad case, a `0`. `StitchError` has no `findings`, so even a hard failure gives only
the generic `contract violation (drift)`. The trace sink for the _same run_ named the field and
both types.

So **`drift()` configured on a stitch that is only ever `.safe()`-ed does nothing for you** —
which is a plausible way to use it, and there is no signal that the feature is inert.

**Ask:** put `findings` on `StitchError`, and/or document that `drift()` requires `trace`,
`.stream()` or `.inspect()` to be observable at all.

## 5. Footguns (the plausible-but-wrong ones first)

- ‼ **`z.coerce.number()` maps `null` → `0`** with no `.catch()` involved, because
  `Number(null) === 0`. Measured: `null`, `""`, `"  "`, `false` and `[]` all coerce to exactly
  `0`; only `"abc"` rejects. On money this is the $0 transaction arriving through the front door.
- ‼ **`.catch(0)` is a $0-transaction generator** — it hands the caller `0` for anything.
- ‼ **`.default('usd')` on a _removed_ field fabricates a value** the vendor never sent, at
  `verbose` — the quietest level.
- **A tolerant schema is a blind one.** `z.union([number, string])` and `z.unknown()` pass the
  raw string through with **zero** findings. `.optional()` lets a field be deleted in total
  silence.
- **Caching divides your drift rate by the miss ratio.** A cache hit emits `start` + `result` and
  no drift (`engine.ts:1605-1613`), so 5 calls against a vendor drifting on **100%** of responses
  measured **20%**.
- **Findings are not calls** — 2 findings on one response reads as 200% unless you collapse on
  `ctx.spanId`.
- **`.report()` / `.inspect()` are fresh probes** — fourth sighting in this pass (see
  [`clock-and-diagnostic-side-effects`](clock-and-diagnostic-side-effects.md)). Here `.report()`
  called immediately after a drifting call reported **zero** findings, because the probe hit a
  clean response — _and_ it added a request and a tick to the rate's denominator.
- **`severity` filtering deletes the data from the sink too** — it is an emission-time allowlist
  (`drift.ts:147`), not a display filter, so a filtered finding never reaches a sink that might
  have counted it.
- **A schema strips what it doesn't declare.** The engine serves the _validated_ value
  (`engine.ts:1224`), so an added field is `undefined` on `data` — reachable only via
  `.inspect().raw`, a fresh request.
