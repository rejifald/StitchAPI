# ADR 0016 — `.inspect()`: expose the raw body + drift findings

- **Status:** Accepted (decided 2026-06-28; builds on [ADR 0015](./0015-schema-anchored-drift.md), merged in [#331](https://github.com/rejifald/StitchAPI/pull/331)). Implementation follows in the same PR line.
- **Date:** 2026-06-28
- **Tags:** drift, diagnostics, inspect, result-object, security, api-surface, accepted

> [!NOTE]
>
> Numbering follows ADR 0015 (the drift redesign, PR #331). 0013/0014 (#328) are
> also in flight; if a collision lands first, renumber at PR time — as 0015 did.

> [!IMPORTANT]
>
> **Depends on [ADR 0015 — schema-anchored drift](./0015-schema-anchored-drift.md)**,
> which must land first. 0015 makes a stitch return the **validated** value
> (coerced/defaulted/stripped) and computes soft drift as
> `diff(raw, validated)` (`classifyDiff` in `packages/core/src/diff.ts`). This ADR
> is the follow-up 0015 itself flags ("expose the raw body + drift findings on a
> non-enumerable result field"). It **sharpens** that bullet: 0015 lumped in
> "stitch config, attempt #, and other diagnosis"; we hold the line at
> `{ value, raw, findings, status, error }` and push config/attempts/timing to a
> **separate enhanced-result-object** decision.

## Context

Under [0015](./0015-schema-anchored-drift.md):

- A stitch resolves to the **validated** value, so the **raw body is lost** to
  an `await` consumer.
- Soft findings (`undeclared` / `coerced` / `defaulted`) ride the **event
  stream only** (`{ type: 'drift', finding }`), so an `await` consumer never
  sees them.

For after-the-fact analysis — "the schema `coerced` `user.age`; what did the
server actually send?" — you need both, on the resolved result, without
consuming a stream. And because soft findings come from `diff(raw, validated)`,
a finding's `path` resolves against `raw` — so exposing `raw` alongside
`findings` makes the pair self-explanatory.

**The value can't carry it.** The awaited value is the raw `T`
([`stitch.ts`](../../packages/core/src/stitch.ts)) and is frequently a
**primitive or array** — you cannot attach a property (Symbol or string) to a
`number`. Object spread drops non-enumerable symbol props; array spread copies
none. Attachment-on-the-value is out.

## Decision

Add a method on the stitch callable, beside `.safe` / `.unwrap` / `.stream`:

```ts
api.users.inspect(input): Promise<Inspection<T>>

interface Inspection<T> {
    value: T | null;          // validated value (per 0015); null iff `error` is set
    raw: unknown;             // the pre-validation body findings are diffed against
    findings: DriftFinding[]; // soft + hard findings (per 0015), incl. those that ride the stream
    status: number;
    error: StitchError | null;
}
```

1.  **A method, not value-attachment.** The wrapper is always an object, so a
    primitive/array `T` sits in `wrapper.value` — the attachment problem
    evaporates. It joins the `.with()` re-bind list, composing with partial-input
    binding for free.

2.  **Scope = `{ value, raw, findings, status, error }`.** `status` rides along
    because it makes `raw` interpretable (a `422` body reads nothing like a
    `200`) and it is already on the result event. Attempt count, timing, and
    config echo stay in the enhanced-result-object decision.

3.  **Never throws — the `.safe()` of drift.** 0015's hard tier throws
    (`invalid`/`error`); the failure path is exactly when raw matters most, so
    `.inspect()` catches it: `{ value: null, error }` with `raw` and `findings`
    still populated. `value` and `error` are **inverse** — `value` is `null` iff
    `error` is set; otherwise `value` is the validated result.

4.  **`raw` = the pre-validation body** — the left side of 0015's
    `diff(raw, validated)`, the coordinate space `finding.path` is anchored to.
    (Per 0015, in-schema `.transform()` pollutes the diff; reshaping belongs in
    the pipeline `transform` stage, which runs _before_ validation. So `raw` is
    the post-pipeline-transform body, matching what the diff already uses.)

5.  **`raw` is a non-enumerable, unredacted field.** Redacting it would blind the
    one tool meant to catch a stray token/PII in an undeclared field, so it is
    **not** redacted. The real risk is _accidental_ leakage, which
    non-enumerability closes: `JSON.stringify(wrapper)`, spread, and trace-walkers
    skip it — you reach for `wrapper.raw` deliberately. This mirrors the existing
    `__rawConfig` (non-enum, full) vs `__config` (redacted) split and the
    `ERROR_SOURCE` discipline. The other fields stay enumerable.

6.  **Baked into core, opt-in by call.** Not a subsystem like the cache/pipe
    subpaths — 0015 already computes findings and holds `raw` at diff time, so the
    marginal code is a `retainRaw` branch + a wrapper consumer. Ships always
    (tiny); **retains `raw` in memory only when `.inspect()` is called**.

7.  **Bypasses the cache, transparently, by default.** A cache hit (stores only
    `{ value, status }`, no `raw`) defeats the purpose. `.inspect()` sets
    `bypassCache` — reusing the engine's existing bypass branch — and does
    **neither read nor write**, so it is side-effect-free and repeatable (a
    write-back would warm the cache and mask the drift you are chasing).
    `.inspect(input, { cache: true })` opts caching back in, with `raw: null` on a
    hit. Bypass also keeps `.inspect()` out of single-flight coalescing — it runs
    its own request, whose `raw` it can see.

### Required engine change

The hard-fail (contract-violation) path throws before surfacing the body. Carry
`raw` on it — preferably pinned to the `StitchError` via the existing
`ERROR_SOURCE` channel (non-enumerable, never serialized to traces) — so
`.inspect()` recovers it on the failure case and the §5 posture comes for free.

## Caveats (documented behaviour)

- **`.inspect()` diverges from `await`.** `await api.users(input)` may be a 0 ms
  cache hit; `.inspect(input)` always hits the network. It is "probe a fresh
  call now," not "observe what my cached call did."
- **Streaming surfaces:** `raw` is `null` (no single buffered body — the engine
  refuses to buffer an unbounded delta spine). `findings` and `status` still
  populate; use `.stream()` `delta`/`drift` events for incremental inspection.

## Consequences

- One new method per stitch; one new exported type (`Inspection<T>`).
- No change to `await` / `.safe()` / `.unwrap()` types — `value` stays pure `T`.
- Cache-bypass-by-default makes `.inspect()` a network call; documented loudly.

## Future work / Out of scope

- **Default redaction of `raw`** — ships unredacted-but-non-enumerable; revisit
  with a `redact` option if an incident or demand justifies it.
- **`source: 'live' | 'cache' | 'stream'` discriminator** — would disambiguate
  why `raw` is `null`; it is diagnostic metadata → the enhanced-result-object,
  not here.
- **Array drift summarization in `classifyDiff`** — for an array-typed value,
  summarize homogeneous drift as one finding (`detail: "all N elements: …"`,
  optional sample index), per-element only on heterogeneity, so findings stay
  proportional to distinct problems, not data size. This is a refinement to
  **0015's `diff.ts`**, recommended alongside this work; `actual` retention here
  keeps the full per-element detail recoverable regardless.
- **The enhanced result object** (config, attempts, timing) — a separate ADR;
  this one holds the line.
