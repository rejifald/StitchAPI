# ADR 0013 — Schema-anchored drift detection

-   **Status:** Accepted (decided 2026-06-28 in the [issue #327](https://github.com/rejifald/StitchAPI/issues/327) design review). Supersedes the **snapshot** drift mechanism (which shipped without an ADR) and the interim **Zod issue-code** mapping; supersedes in part the drift clauses of [ADR 0005](./0005-surfaces-and-the-authoring-model.md). Implementation follows in the same PR line.
-   **Date:** 2026-06-28
-   **Tags:** validation, drift, schema, observability, breaking-change

## Context

Drift detection originally compared a live response's _shape_ against a committed **snapshot** baseline (`DriftSpec.snapshotFile`, with `readonly` / `onMissing` and a `stitch drift generate` CLI). It carried a parallel severity system — `critical` / `watch` paths leveling each change to `error` / `warn`.

Two problems, one shallow and one deep.

**Shallow:** a single snapshot is one observation, so it cannot tell real drift from natural response variance. An optional field that happens to be absent, a `string | null` that happens to be null, an empty-vs-populated array, a heterogeneous array — each looks like drift to a one-shot baseline. A multi-sample _profile_ was prototyped to learn the variance envelope; it reduced the noise but never eliminated it (it still cannot "cover all paths") and added a calibration/maintenance burden.

**Deep — there are three contracts, not one:**

1.  **What the API returns right now** — the live response.
2.  **The author's contract** — what the upstream actually promises, which evolves without telling you. Knowable only from a published spec (OpenAPI) or by _observing responses over time_ — which is exactly what a snapshot approximates.
3.  **The consumer's contract** — the `output` schema you declared = "what I need."

A snapshot tries to reconstruct (2) by observation. But validating against the declared schema speaks to (3): **"will my code break?"** — a different question. A validation failure is ambiguous between _the author drifted_ and _my schema was wrong/over-broad from day one_, and the system cannot distinguish them from a single response. Conflating (2) and (3) is the root of the variance false positives, and it tempts a consumer to mirror the _whole_ API in their schema (brittle, and still blind to author-drift in fields they didn't mirror).

## Decision

**Drift is anchored to the consumer contract** — the declared `output` schema — and reports "the response no longer matches **what you declared**." It never asserts "the API changed." Author-contract drift in undeclared fields is out of scope (it needs a spec or observation, both deliberately not done here).

### Two tiers

1.  **Validation — the hard contract.** A missing _required_ field, an incompatible value, or a structural restructure (an object re-wrapped under `data`, a scalar where an array was declared) **throws** (`STITCH_VALIDATION`). Validation **returns the validated value** — defaults applied, types coerced, unknown keys stripped — so the runtime result matches the declared TS type. (Previously the engine returned the _raw_ post-transform body, which could carry keys/types the inferred type denied: a latent unsoundness this fixes.)

    Severity lives **in the schema**: a field is required (its loss throws) or optional (its loss is tolerated). There is no parallel `critical` / `watch` system — that duplicated what required/optional already express. (This is [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md)'s principle — "schema reuse is the validator's job" — applied to severity.)

2.  **Drift — the soft, opt-in, notify-only layer.** When enabled, drift computes a structural **diff of the raw body against the validated value**. The delta _is_ the drift:

    | diff op  | meaning                                  | finding      |
    | -------- | ---------------------------------------- | ------------ |
    | `REMOVE` | a key the schema stripped                | `undeclared` |
    | `CHANGE` | a value the schema coerced (`"42"`→`42`) | `coerced`    |
    | `CREATE` | a `.default()` fired (field was absent)  | `defaulted`  |

    `undeclared` is the honest name (we observe a present-but-undeclared field; we cannot prove it is _new_). `coerced` is novel intel: a wire-type shift that validation _hides_ — a defensive `z.coerce.number()` makes `count: "42"` validate clean, and only the diff catches that the wire type changed.

    Findings are **non-fatal** `drift` events, rendered with the `[]` array-path grammar and deduped (a stripped field on 100 array elements is one `items[].x` finding, not 100). Soft drift never carries `error` — fatality is the schema's job (make the field required → it becomes a hard `invalid`). The three soft levels are `warn` / `info` / `verbose` (quietest), with per-kind **defaults**: `undeclared` → `info`, `coerced` → `warn`, `defaulted` → `verbose`.

### Leveling — `severity`

`DriftOptions.severity` controls the soft levels, in three shapes:

-   a **single level** or a **bare list** of levels — an _allowlist_ of which severities to surface (others dropped), keeping the per-kind defaults; `'warn'` ≡ `['warn']`.
-   a **map** of soft-kind → level — _re-levels_ a kind (all kinds still surface).

Omitted ⇒ each kind surfaces at its default. (A single value/list can't assign two levels to one finding, so it can only be a filter; re-leveling needs the map.)

### Opt-in and suppression

-   **The opt-in boundary is drift itself.** No `output` wrapper → validation only, no diff. Enable drift → all soft signals are on; there is no per-signal toggle (filter with `severity`).
-   **Suppress known/irrelevant fields with `ignore: string[]`** (prefix / `*` grammar) in the drift config, **never in the schema**. A narrow consumer schema means "undeclared" ≠ "new" — the API returns fields you knowingly don't consume — so `ignore` acknowledges the known surface without bloating the typed contract. This is the part of the snapshot that was actually load-bearing ("what is known"), kept as a **human-curated, path-only** list — no typed full-payload baseline, so no variance false positives, and a stale entry is harmless (you keep ignoring a field that is still there).

    > **Known surface = what you _consume_ (the schema) ∪ what you _acknowledge_ (`ignore`).** Drift fires on the complement.

### Vendor-neutral

The diff compares two plain values, so drift works for any validator that returns a parsed `value` (Zod, Valibot, ArkType, any Standard Schema) — no Zod issue-code introspection. The diff algorithm is reimplemented in-house (~50 lines, the microdiff approach) to keep core **zero-dependency**.

## Consequences

**Accepted trade-offs**

-   **Drift watches only the declared surface.** Author-contract change in fields that are neither consumed nor in `ignore`-scope is invisible. That is change you do not consume — acceptable, and the honest limit of a consumer-anchored model.
-   **Enabling drift on a wide API floods until `ignore` is populated.** The cost of the feature; relieved by wildcard `ignore` (`['meta', '_links', 'debug']`).
-   **In-schema `.transform()` pollutes the diff.** A transform inside the schema makes `validated` differ from `raw` by _your_ logic, which reads as drift. Keep reshaping in the pipeline `transform` stage (it runs _before_ validation); the diff is for pure type/shape schemas.
-   **Returning the validated value is a behavior change.** A caller leaning on stripped extras breaks — but those keys were never in its declared type.

**Wins**

-   No snapshot to generate, commit, calibrate, or invalidate; no first-call write side-effect.
-   No `.strict()` ceremony: stripped keys surface as `REMOVE` in the diff, so undeclared fields are detected **and** the output stays clean. The strict-to-see-vs-strip-for-clean-output contradiction dissolves.
-   The diff is naturally **deep**, so nested undeclared/coerced fields are caught for free.
-   Declared variance (optional absent, nullable null, empty/heterogeneous arrays) validates clean → no finding. The variance false positives are structurally impossible.

## Alternatives considered

-   **Snapshot baseline (single-sample), and a multi-sample learned profile.** Rejected: conflates variance with drift; cannot cover all paths; maintenance/footgun. The profile was prototyped and discarded.
-   **Zod issue-code taxonomy** (map `invalid_type` / `unrecognized_keys` → `missing` / `type-changed` / `nullable` / `new`). Rejected: Zod-coupled, and it re-derived structural findings that are either validation throws (hard) or diff results (soft). The diff subsumes it, vendor-neutrally.
-   **Auto-`strict()` to detect new fields.** Rejected: forces unknown-key surfacing (and dirties output, or needs deep strict-ification); the diff detects stripped keys without it.
-   **`watch` as "tolerate-but-observe"** (warn-but-succeed on a shape change). Dropped with `critical` / `watch`. Re-add a narrow hatch only if real demand appears.

## Deferred (separate decisions / ADRs)

-   **Expose the raw body + drift findings (+ stitch config, attempt #, and other diagnosis) on a non-enumerable result field** for later analysis. Its own decision — drift detection should not dictate the analysis surface.
-   **"Rescue"** — a best-effort recovery feature that _would_ attempt the structural "sneak peek" (recognize an object re-wrapped under `data`, a scalar↔array flip) and try to recover. Deliberately **not** folded into drift: silently recovering a hard restructure can mask a serious break. Whether to have it at all is its own ADR.
-   **Nested-path nuances and structural-restructure diagnostics** beyond the plain diff.

## Supersedes in ADR 0005

-   **Decision 11** lists "drift snapshots" among the things that round-trip as JSON. Snapshots no longer exist; that example is struck (see this ADR).
-   **Q4-revisited (streaming)** noted that `DriftSpec.snapshotFile` is not applied per-delta and only "schema + leveling" applies per-delta. The `snapshotFile` parenthetical is obsolete; the per-delta path is now simply schema validation (with optional diff per emitted value) — which is what that clause already described.
