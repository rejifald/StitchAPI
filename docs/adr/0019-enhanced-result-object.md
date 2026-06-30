# ADR 0019 — The enhanced result object (`.report()`) + the `source` discriminator

-   **Status:** Accepted (designed 2026-06-28; implemented in this PR; extends [ADR 0016](./0016-inspect-raw-and-findings.md), merged in [#334](https://github.com/rejifald/StitchAPI/pull/334)). Folds in **two** of the four items ADR 0016 deferred: the `source` discriminator and the enhanced result object.
-   **Date:** 2026-06-28
-   **Tags:** inspect, diagnostics, result-object, observability, privacy, api-surface

> [!NOTE]
>
> Numbering continues past 0016 (PR #334) and 0013/0014 (#328), both in flight.
> Renumber at PR time if a lower number lands first — as 0015/0016 did.

> [!IMPORTANT]
>
> **Depends on [ADR 0016](./0016-inspect-raw-and-findings.md)** (`Inspection<T>`
> and `.inspect()`), which must land first (PR #334). 0016 deliberately **held the
> line** at `{ value, raw, findings, status, error }` and pushed attempt count,
> timing, and config echo to "a separate ADR; this one holds the line." This is
> that ADR. It also **revises** 0016's tentative placement of the `source`
> discriminator (see §1).

## Context

0016 gives an `await`-style consumer the body and the drift. The remaining
diagnostic questions are about the **run**, not the body: _How many attempts did
it take? How long? Was it served from cache or a live request? What config
actually resolved for this call?_ 0016 deliberately excluded these to keep
`Inspection<T>` the minimal "raw + drift" object.

It also left two related questions open:

-   **`source: 'live' | 'cache' | 'stream'`** — disambiguates _why_ `raw` is
    `null` (a cache hit vs. a streaming surface vs. a live miss). 0016 guessed this
    belonged on "the enhanced-result-object, not here."
-   **The enhanced result object** (config echo, attempts, timing) — its own
    decision, "the largest."

Most of the data already exists on the event spine (ADR 0007). This ADR audits
what is free vs. what needs plumbing, and lands the surface.

## Decision

A two-layer split: `source` lands on the **minimal** `Inspection<T>` because it
interprets an existing Inspection field; the heavier diagnostics land on a
**new** `RunReport<T> extends Inspection<T>` returned by **`.report()`**.

### 1. `source` goes on `Inspection<T>` — revising 0016's guess

```ts
interface Inspection<T> {
    value: T | null;
    raw: unknown;
    findings: DriftFinding[];
    status: number;
    error: StitchError | null;
    source: 'live' | 'cache' | 'stream'; // NEW
}
```

0016 speculated `source` belonged on the enhanced object. On reflection that is
incoherent: **`source` exists to explain why `raw` is `null`, and `raw` lives on
`Inspection`.** The explainer must sit with the thing it explains. `source` is
also _free_ — the engine already knows which branch ran (the
`progress { phase: 'cache', detail: 'hit' | 'miss' }` event; the streaming
surface is a separate `.inspect()` code path; live = a real request). So `source`
is the one diagnostic that earns a place on the minimal object, and this ADR moves
it there, superseding 0016's deferral note for this item.

Semantics — `source` distinguishes the **structural** nulls from the live case:

| `source`   | when                                 | `raw`                                  |
| ---------- | ------------------------------------ | -------------------------------------- |
| `'live'`   | a real request ran (miss, or bypass) | populated (unless redacted/0018)       |
| `'cache'`  | `{ cache: true }` + a hit            | `null` (cache stores `{value,status}`) |
| `'stream'` | a streaming surface                  | `null` (no single buffered body)       |

Honest limit: `source` explains the **structural** nulls fully (cache/stream —
`raw` _can never_ exist there). On `'live'`, `raw` is populated **except** when a
transport error killed the request before any body arrived (then `raw` is `null`
and `source` is still `'live'`). So the contract is "`source` tells you whether
`raw` _could_ exist," not "`source === 'live'` ⟹ `raw !== null`." Documented, not
hidden.

### 2. The heavier diagnostics go on `RunReport<T>` via `.report()`

```ts
type CacheOutcome = 'hit' | 'hit (revalidated)' | 'miss' | 'bypass' | 'disabled';

interface RunReport<T> extends Inspection<T> {
    attempts: number;             // total incl. the first
    timing: { ms: number; waited?: number }; // total wall ms; summed backoff/throttle wait
    config: RedactedStitchConfig; // the REDACTED resolved config — never __rawConfig
    cache: CacheOutcome;          // fine-grained cache outcome (source's detail)
}

// on the Stitch callable, beside .inspect():
report(...args: [...Args<TIn>, opts?: InspectOptions]): Promise<RunReport<T>>;
```

`RunReport<T>` **extends** `Inspection<T>`: a report _is_ an inspection plus run
diagnostics. So `.inspect()` stays 0016's minimal "raw + drift" tool, and
`.report()` is the "explain this run" superset — one coherent type hierarchy, the
0016 line held on the small object.

### 3. Why a separate method, not an expanded `Inspection`

-   **Expand `Inspection` with all fields** — rejected: re-breaks 0016's held line
    and makes _every_ `.inspect()` pay the config-resolve-and-redact cost for data
    most probes don't want. (We make a single exception for `source` — free, and
    the interpretant of `raw`.)
-   **Option-gated optional fields** (`.inspect(input, { trace: true })` populates
    `attempts?`, `timing?`, …) — rejected: "sometimes-undefined" fields are a
    typing wart; you can't tell "not asked for" from "genuinely empty." A distinct
    return type is cleaner.
-   **A separate `.report()` returning `RunReport<T> extends Inspection<T>`** —
    chosen. Names the diagnostics concern, keeps `.inspect()` minimal, one type
    hierarchy.

Name: **`.report()`**. Rejected `.trace()` (collides with the existing trace sink
— `trace.ts`, `TraceContext`, the JSONL/OTLP `trace`) and `.describe()`
(overloaded with the static config-summary "describe what a stitch does"). A
_report_ is the per-run dynamic artifact.

### 4. Where the data lives — the plumbing audit

| field                   | source on the spine                                 | new plumbing?                         |
| ----------------------- | --------------------------------------------------- | ------------------------------------- |
| `attempts`              | `StitchEvent.attempts` / `StitchError.attempts`     | none                                  |
| `timing.ms`             | `done.ms`                                           | none                                  |
| `timing.waited`         | Σ `progress.waitedMs` (throttle/retry/reconnect)    | none (derived)                        |
| `source` / `cache`      | `progress { phase:'cache', detail }` + surface kind | none (derived)                        |
| `config`                | `Stitch.__config` (already redacted, ADR 0002)      | redact the _resolved_ per-call config |
| **per-attempt latency** | — not on the spine —                                | **needs engine spans → DEFERRED**     |

The whole of `RunReport` v1 is buildable from the **existing event spine** plus
the already-redacted `__config`. The single gap is **precise per-attempt request
latency** (attempt N took X ms): the spine carries per-event `at` timestamps and
`progress.waitedMs`, but not request-start/request-end per attempt. v1 reports
total `ms` + total `waited` and **defers** per-attempt spans (they need the engine
to stamp attempt boundaries). We do **not** fake per-attempt latency from `at`
deltas — those deltas include validation/throttle time and would mislead.

Contrast 0016, which needed engine changes (`RAW_BODY` / `ERROR_SOURCE`): this
ADR's v1 needs **no new engine events** — it rides the spine.

### 5. Privacy posture

-   **`config` is the redacted `__config`, never `__rawConfig`.** `__rawConfig`
    carries live auth/secrets; `__config` is the auth-stripped projection (ADR
    0002). `RunReport.config` is the **resolved** per-call config (after `.with()`
    binding and per-call `deepMerge`) run through the _same_ redaction projection
    that produces `__config` — the one bit of new config-side work, and it MUST go
    through that projection. Echoing `__rawConfig` is forbidden.
-   **`raw` is inherited** from `Inspection`: non-enumerable, and ADR 0018's
    `redact` option applies to it.
-   Every other `RunReport` field (`attempts`, `timing`, `source`, `cache`,
    `config`) is secret-free and **enumerable** — a report is safe to log _except_
    don't expand `raw`. Same posture as `Inspection`.

## Consequences

-   `Inspection<T>` gains `source` (one enum, free); `RunReport<T>` + `.report()`
    are net-new. No change to `await` / `.safe()` / `.unwrap()` / `.inspect()`
    _value_ typing.
-   Like `.inspect()`, `.report()` is a network probe (bypasses cache by default,
    `{ cache: true }` to honor it) — same caveats as 0016.
-   Per-attempt latency is explicitly absent in v1; flagged so its absence reads
    as "deferred," not "covered."

## Engine / type touch-points

-   [`types.ts`](../../packages/core/src/types.ts) — add `source` to
    `Inspection<T>`; add `RunReport<T> extends Inspection<T>`, `CacheOutcome`; add
    `report(...)` to the `Stitch` interface. `InspectOptions` is shared (or a
    `ReportOptions` alias).
-   [`stitch.ts`](../../packages/core/src/stitch.ts) — a `.report()` consumer that
    drains the event stream once (like `.inspect()`): collect `attempts` (terminal
    event), `ms` (`done`), `waited` (Σ `progress.waitedMs`), `cache`/`source` (the
    `phase:'cache'` detail + surface kind), `config` (resolved + redacted
    `__config`). Add the `source` computation to the existing `.inspect()` consumer.
-   [`config-summary.ts`](../../packages/core/src/config-summary.ts) — reuse the
    redacted-config read-outs; reuse the `__rawConfig → __config` redaction
    projection to produce the resolved per-call echo.
-   `engine.ts` — **no new events for v1.** The only engine change (per-attempt
    span stamping) is the _deferred_ item, out of scope here.

## Relationship to the other 0016 deferrals

-   **Folds in the `source` item** (0016 deferral #2) — landed on `Inspection`,
    revising 0016's guess.
-   **Overlaps ADR 0018**: `RunReport` inherits `raw`, so 0018's `redact` and
    non-enumerability cover it; but `config` echo uses a _different_ redaction path
    (the `__config` projection), so the two ADRs touch redaction in
    non-overlapping places.
-   **Independent of ADR 0017** (array drift summarization — the diff/classify
    layer). `RunReport.findings` inherit 0017's summarized shape for free.

This is the **largest** of the four and rightly its own ADR, with `source`
merged in because `source` is the interpretant of `raw` and cannot stand on its
own.
