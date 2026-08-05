# `diff` and `classifyDiff` exist and are unreachable, and `pool: 'host'` re-keys the breaker

**Status:** drafted, not filed
**Scenario:** [dual-run-migration](../dual-run-migration.md)
**Proofs:** `docs/scenarios/proofs/dual-run-migration/` (8 scripts, 142 checks, offline)

## 1. Two value-vs-value comparators ship in the tree and neither is exported

Of the 33 root exports, exactly one is comparison-shaped: `drift()` — which takes a **schema**
and performs no value-vs-value comparison at all. Meanwhile the tree contains two functions that
do exactly that:

- `diff(before, after)` — `packages/core/src/diff.ts:94`
- `classifyDiff(a, b, opts)` — `packages/core/src/drift.ts:113`

Neither is reachable from any of the **17 subpaths** in the package `exports` map.

Any user comparing two responses — a v1/v2 migration diff, a cache-vs-live check, a
before-and-after on a write — has to hand-write a walker that already exists twice.

**Ask:** export one of them, most usefully `diff`. It is a small surface addition and it removes
a whole category of hand-rolled walkers.

**One caveat so a fix aims correctly:** for this use case `classifyDiff` is the _worse_ of the
two, because it is built for schema drift and reports **kinds, not values**. It renders a planted
regression (`balance_cents` 1200 → 1500) as the detail `"number -> number"` — a type delta with
no numbers in it. Measured, a 23-line hand-written comparator was strictly better precisely
because it carries both values. `diff` is the one worth exporting.

## 2. `DriftOptions.ignore` is suppression, not relevancy

`ignore` (path, `*`, prefix, `[]` for array elements) is the only declarative filtering surface,
and it is reachable only through the source-only `classifyDiff`. On a realistic v1→v2 change — a
rename, a retype, an array reorder, a new field, and one planted regression — it took 7 diff ops
to 1 with four clauses.

But it silences by **path**, not by reason. Measured, both ways:

- the clause silencing a benign **tag reorder** also silences a real tag **change**;
- the clause silencing the `created` → `created_at` **rename** also silences a v2 reporting the
  **wrong instant**.

There is no field aliasing, no unordered-array comparison, no coercion hook and no numeric
tolerance anywhere in the tree. So the relevancy model that the shadow-testing literature calls
the core of the technique is 24 lines of user code, and the declarative option that looks like it
does the job quietly hides real regressions.

**Ask:** either document `ignore` as _suppression by path_ with that caveat stated, or grow the
comparison surface an alias/unordered/tolerance clause.

## 3. `pool: 'host'` fixes cost accounting and silently re-keys the breaker

Two stitches against the same vendor, each with `throttle: '20/s'`, put **4 requests through in
one gap** — the vendor saw 40/s. Two constructions fix it, and they are **not** equivalent:

| construction        | throttle      | circuit                            |
| ------------------- | ------------- | ---------------------------------- |
| seam-level throttle | one bucket ✅ | left keyed per path ✅             |
| `pool: 'host'`      | one bucket ✅ | **also re-keyed onto the host** ⚠️ |

`seamBucket` (`seam.ts:58`) returns the inner throttle unchanged when `pool: 'host'` is set —
`// host key already pools across the seam` — and the host key then applies to the circuit too.
Measured: under `pool: 'host'` a failing shadow stitch fast-failed the **primary**, which got
**0** requests.

So the one setting a reader reaches for to make two stitches share a rate budget also makes them
share a breaker, and nothing says so.

**Ask:** note the coupling in the `throttle.pool` docs, or let `circuit.key` override it
independently.

## 4. A construction-time method gate is bypassable by a surface

Not a library bug so much as a trap worth documenting, found while building a guard that prevents
shadowing a write.

A gate written against `__config.method` refuses a plain `POST` stitch — and the `llm` surface
reports `__config.method === undefined`, passes the gate, and then POSTs. Measured. The same
holds for any surface that supplies its own method.

The construction that actually works is an `Adapter` wrapper, which sits below every authoring
surface: 3 shadow write attempts (a plain POST, an `llm`-surface call, a `.with()`-bound handle)
reached the wire **0 times**.

**Ask:** a line in the surfaces reference noting that `__config.method` is not a reliable
predicate for "what HTTP method will this send", and that the `Adapter` is the seam below all
surfaces.

## 5. Smaller

- **`linked` returns a `Promise`, not a `Composable`**, so it cannot be a member of `all`/`any`.
  That is a reasonable design, and it is not stated anywhere the combinator docs would show it.
- **`.with()` binds a constant through the broadcast.** A bound partial _does_ survive
  `runMember` — but a group built once and called twice sent the shadow to the customer from the
  **first** call. This is the near-miss workaround for
  [#643](https://github.com/rejifald/StitchAPI/issues/643) and it fails silently.
- **A bare `void stitch(input)` sends zero requests**, because `StitchResult` extends
  `PromiseLike` (`types.ts:1962`) and nothing runs until `.then`. Already filed as
  [#660](https://github.com/rejifald/StitchAPI/issues/660); recording the second sighting because
  a fire-and-forget shadow is exactly the shape that hits it, and there the symptom is "the
  comparison silently never ran."

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
drafting. Runnable proof scripts live under `docs/scenarios/proofs/dual-run-migration/` on the
branch `claude/api-integration-scenarios-436a38`._
