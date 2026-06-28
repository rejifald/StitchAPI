# ADR 0017 — Array drift summarization in `classifyDiff`

-   **Status:** Proposed (designed 2026-06-28; refines [ADR 0015](./0015-schema-anchored-drift.md), merged in [#331](https://github.com/rejifald/StitchAPI/pull/331)). One of the four items [ADR 0016](./0016-inspect-raw-and-findings.md) deferred.
-   **Date:** 2026-06-28
-   **Tags:** drift, diff, findings, proportionality, correctness

> [!NOTE]
>
> Numbering continues past 0016 (`.inspect()`, PR #334, in flight) and the
> 0013/0014 pair (#328, in flight). If a lower number lands first, renumber at PR
> time — as 0015/0016 did.

> [!IMPORTANT]
>
> **Refines [ADR 0015](./0015-schema-anchored-drift.md)'s soft-drift layer**
> (`classifyDiff` in [`packages/core/src/drift.ts`](../../packages/core/src/drift.ts),
> over the structural `diff` in [`diff.ts`](../../packages/core/src/diff.ts)). It
> depends only on 0015, which is **merged**. It is independent of `.inspect()`
> (ADR 0016): the change is in the classify layer that feeds _both_ the `drift`
> event stream and (once 0016 lands) `Inspection.findings`.

## Context

0015 computes soft drift as `diff(raw, validated)` and renders each diff op into
a leveled `DriftFinding`. The diff is index-precise (array element `i` → numeric
path segment `i`), but `renderPath` collapses every numeric segment to the `[]`
grammar, and `classifyDiff` then dedupes by `change|path`:

```ts
const key = `${change}|${path}`;
if (seen.has(key)) continue; // first finding wins; the rest are dropped
```

So a field stripped from 100 array elements becomes **one** `items[].x`
`undeclared` finding rather than 100. That dedup is load-bearing — it keeps
findings proportional to distinct problems, not data size — and 0015 already
ships it. **This ADR is not "add array dedup"; it sharpens the dedup that
exists.** Three gaps in the current first-wins collapse:

1.  **No count.** The single finding does not say _how many_ elements drifted.
    "`items[].x` undeclared" hides whether that is 1 element or 10 000.
2.  **No drill-down coordinate.** Findings render `[]`, so a consumer cannot jump
    to a concrete element to see the offending value.
3.  **Silent heterogeneity loss — a correctness gap.** First-wins keys on
    `change|path` _only_, so two genuinely different problems at the same
    collapsed path are merged and one is dropped. If element 0 coerced
    `string → number` and element 1 coerced `boolean → number`, both share
    `coerced|items[].x`; the engine reports `string -> number` and **silently
    discards** the `boolean -> number` problem. A heterogeneous array (the exact
    variance 0015 tolerates at validation time) can hide a real distinct drift.

Gap 3 is the reason to act now; gaps 1–2 are the ergonomic payoff that comes with
the fix.

## Decision

Replace `classifyDiff`'s per-diff first-wins dedup with **group-then-summarize**.
Group the diffs by `change|path` (the existing collapse key); within each group
that came from an array (its rendered path contains `[]`), branch on homogeneity.

### Homogeneity test

Two diffs in a group are **the same problem** iff they would render the
**identical `detail` string** (the output of `detailFor`). This is the right
test because `detail` already encodes exactly the distinguishing facts and
_nothing else_:

| change       | `detail` shape                 | what makes elements differ   |
| ------------ | ------------------------------ | ---------------------------- |
| `coerced`    | `<kindOf old> -> <kindOf new>` | the wire-type transition     |
| `undeclared` | `undeclared field (<kindOf>)`  | the stray value's kind       |
| `defaulted`  | `default applied` (constant)   | nothing — always homogeneous |

Defining homogeneity as `detail` equality keeps the test self-consistent with
what a finding reports: elements collapse iff they'd say the same thing. (Note
`detailFor` emits **kinds only, never values** — so neither the summary nor the
per-variant findings ever leak a payload value, a property ADR 0018 leans on.)

### Emitted shape

-   **Homogeneous group** (one distinct `detail`): **one** finding.
    -   `path` stays the `[]` grammar (`items[].x`) — dedup-stable and
        `ignore`-compatible.
    -   `detail` becomes **`all N elements: <detail>`** where `N` is the count of
        affected elements.
    -   add `sample` = a **concrete-index path** for the first occurrence
        (`items[0].x`) so a consumer can drill into the real value.
-   **Heterogeneous group** (>1 distinct `detail`): **one finding per distinct
    `detail` variant**, each with its own `count` and `sample` concrete index.
    Output stays proportional to _distinct problems_, degrading to one-per-element
    only when every element genuinely differs (the honest worst case). This is
    strictly stronger than ADR 0016's note ("per-element only on heterogeneity"):
    per-variant subsumes per-element and never floods on a near-homogeneous array
    with a single outlier.

`ignore` (path-based) and `severity` (change-based) apply **after** grouping, to
the summarized/variant findings — unchanged semantics, since all elements share
the `[]` path and `change`.

### Finding type

`DriftFinding` gains **one** optional field, `sample?: string`:

```ts
interface DriftFinding {
    level: DriftSeverity | 'error';
    path: string; // unchanged: the [] grammar
    change: SoftDriftChange | 'invalid';
    detail: string; // now may read "all N elements: …"
    sample?: string; // NEW: concrete-index path, e.g. "items[3].x" (array summaries only)
}
```

The count `N` rides in the human-readable `detail` rather than as a structured
field — it is legible there and avoids a second optional. `sample` _is_
structured, because its sole job is to be a machine coordinate into `raw` (see
below), where a parsed-from-prose index would be fragile.

### Interaction with `.inspect()`'s full-raw retention (ADR 0016)

Summarization deliberately drops per-element specifics _from the finding_, but
loses nothing, because **`raw` is the source of truth**. `.inspect()` retains the
entire untouched body (ADR 0016 §5), so every element's actual value is
recoverable by indexing `inspection.raw` — `sample` (`items[3].x`) is a ready
coordinate, and the `[]` path names the array to iterate. A summarized finding is
an **index into `raw`, not a replacement for it.**

The one honest limit: a **stream-only** consumer (no `.inspect()`, so `raw` is
not retained — the engine refuses to buffer the spine) gets the summary, `count`,
and `sample` but cannot recover per-element values. That matches 0016's existing
streaming caveat and is documented, not hidden.

## Alternatives considered

-   **Keep first-wins dedup (status quo).** Rejected: silently drops
    heterogeneous problems (gap 3) and reports no count/coordinate.
-   **Always one finding per element (no collapse).** Rejected: findings scale
    with data size, not distinct problems — floods on large arrays, the precise
    failure 0015's `[]` dedup was built to prevent.
-   **One finding per `change|path` always, just append a `count`.** Rejected:
    fixes gaps 1–2 but not gap 3 — heterogeneous problems still merge and vanish.
-   **Cap at the first K elements sampled.** Rejected: a silent cap; a divergent
    element past K is missed — the no-silent-truncation principle. (If a future
    bound is ever needed, it must be logged, not silent.)
-   **Put `count`/`sample` in `diff.ts` (the structural diff).** Rejected: the
    diff must stay index-precise so heterogeneity is _detectable_. Summarization
    is a classify-layer concern; `diff.ts` is untouched.

## Consequences

-   `classifyDiff` gains a group/summarize pass; `diff.ts` unchanged.
-   `DriftFinding` gains one optional `sample` — additive; existing consumers and
    the `drift` event are unaffected.
-   The existing "stripped field on 100 elements = 1 finding" test stays green,
    now asserting `detail: "all 100 elements: …"` and `count`-in-detail.
-   Heterogeneous arrays surface every distinct problem instead of the first —
    a behavior change that can _increase_ finding count on genuinely mixed data
    (the point).

## Engine / type touch-points

-   [`packages/core/src/drift.ts`](../../packages/core/src/drift.ts) —
    `classifyDiff`: swap the per-diff `seen` loop for group-by-`change|path`, then
    a `summarizeGroup` helper that branches on `detail` homogeneity; reuse
    `detailFor` per variant. Apply `ignore`/`severity` after grouping.
-   [`packages/core/src/types.ts`](../../packages/core/src/types.ts) —
    `DriftFinding`: add `sample?: string`. Flows to `Inspection.findings` and the
    `drift` event for free (same type).
-   [`packages/core/src/diff.ts`](../../packages/core/src/diff.ts) — **no change**
    (stays index-precise; precision is what makes heterogeneity detectable).
-   Tests: homogeneous vs heterogeneous array cases; scalar-array coercion; the
    single-outlier-in-a-large-array case (one variant finding + one summary, not a
    flood).

## Relationship to the other 0016 deferrals

Stands **alone**. Different subsystem from the other three: this is the diff/
classify layer (refining 0015), while ADR 0018 (`raw` redaction) and ADR 0019
(enhanced result object) refine the `.inspect()` result surface (ADR 0016).
