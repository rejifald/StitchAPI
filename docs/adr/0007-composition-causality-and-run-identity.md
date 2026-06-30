# ADR 0007 — Composition causality: an OTLP span tree for the event stream

-   **Status:** Accepted (decisions resolved in the 2026-06-16 review of PR [#163](https://github.com/rejifald/StitchAPI/pull/163); implemented in PR [#163](https://github.com/rejifald/StitchAPI/pull/163))
-   **Date:** 2026-06-16
-   **Tags:** observability, tracing, otlp, playground, composition, causality, browser-first

> [!NOTE]
>
> The four open questions are now **resolved** (review of PR #163, recorded below). The guiding principle the review set: **trace richly, for OTLP operators analysing real traffic** — every retry, page, login, and composed step is visible, with per-iteration performance, not just a flat per-call stream. This is FOUNDATIONAL for #7's `pipe()` ([ADR 0008](./0008-non-http-surfaces-and-pipe.md)), so it lands first.

> [!IMPORTANT]
>
> **Amendment — `RunContext` field names aligned to OpenTelemetry.** This ADR was written with `runId` / `parentId`; the fields were since renamed to the OTel-canonical **`spanId`** / **`parentSpanId`** (`traceId` was already canonical), so the internal struct, the `start`-event fields, and the OTLP export all use the same names and the exporter's mapping is an identity. Read `runId` as `spanId` and `parentId` as `parentSpanId` throughout the text below. Rationale and the "wire form is a projection, not a replacement" rule live in [ADR 0017 Decision 7](./0017-outbound-trace-context-propagation.md); the reader-facing explainer is [concepts/run-identity](../../apps/docs/content/docs/concepts/run-identity.mdx).

## Context

A stitch's events are a **flat per-call stream**: `start → progress* → (info|drift|delta)* → result|error → done` (`StitchEvent`, [`types.ts`](../../packages/core/src/types.ts)), drained/teed to the trace sink in `tee()` ([`stitch.ts`](../../packages/core/src/stitch.ts)). Each `execute()` ([`engine.ts`](../../packages/core/src/engine.ts)) is **one logical run**, and the stream carries no notion of one run having spawned another, nor of structure _within_ a run.

Two consumers want that structure and cannot get it:

-   **The OTLP sink** ([`otlp.ts`](../../packages/core/src/otlp.ts)) maps each call to one CLIENT span, but **mints a fresh `traceId`/`spanId` per `start`** and guesses correlation from a `name`-keyed stack; `parentSpanId` is never emitted, and a retry/page/login is at best a point-in-time **span event**, never a child span with its own latency and status. An operator cannot see "how each of the 3 attempts performed" or "page 4 took 800ms".
-   **The playground DAG** (PR [#94](https://github.com/rejifald/StitchAPI/pull/94)). `StitchTraceEntry.dependsOn` ([`runner.ts`](../../docs/sandbox/component/runner.ts)) exists and `traceToMermaid` draws edges from it — but the trace collector ([`trace-collector.ts`](../../docs/sandbox/runtime/trace-collector.ts)) mints synthetic `stitch-N` ids and FIFO-correlates because _"the composition graph core doesn't emit"_ parent identity.

A run **already** spawns another: `cookieSession` runs its login stitch via `__raw` → `executeRaw` ([`auth.ts`](../../packages/core/src/auth.ts) `doRefresh`), and `executeRaw` drives `attemptLoop` directly and **emits no events** — so that child run is invisible today. #7's `pipe()` will spawn a child run per step.

## Decision (resolved 2026-06-16)

1.  **Model the whole thing as one OTLP trace tree.** Every traced unit is a **span** with a `spanId` (16 hex), a `traceId` (32 hex, shared across a tree), and a `parentId` (=OTel `parentSpanId`). This is the OTel span model verbatim, so the OTLP sink stops guessing — it reads ids, sets `parentSpanId`, shares one `traceId` — and a trace-based Mermaid diagram is a span-tree walk. Ids are **engine-minted** (reusing the browser-safe `otlp.ts#hex`), never caller-supplied (a caller-named id spoofs correlation — the same reasoning that keeps `principal` off `StitchInput` in [ADR 0002](./0002-seam-primitive-and-principal-scoped-auth.md)). A future _inbound_ `traceparent` continuation (W3C Trace Context) is a separate opt-in feature.

2.  **Three kinds of span — runs, intra-run sub-spans, child runs.** The taxonomy that reconciles "retries are not runs, but must be traced":

    | Span kind              | What it is                                             | Examples                                       | New `runId`?                             |
    | ---------------------- | ------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------- |
    | **Run span**           | One `execute()` — a whole logical call                 | the call itself                                | yes (the `runId`)                        |
    | **Intra-run sub-span** | A sub-operation _within_ one run — not a separate call | each **retry attempt**, each **paginate page** | no — a child span under the run          |
    | **Child-run span**     | A nested `execute()` the run caused                    | `cookieSession` **login**, a `pipe()` **step** | yes — its own `runId`, `parentId`=caller |

    A **retry attempt is a sub-span, not a run** (no separate `execute()`), but it is still a child span in the tree with its own start/end/status — so the operator sees count _and_ per-attempt latency/outcome. A **page** is the same. A **coalescing follower** is neither (it awaits the leader's shared result, runs no chain). Streaming `delta`s are values within the run span, not sub-spans.

3.  **Trace everything, with per-iteration performance (the review's principle).** Retries, pages, the `cookieSession` login, and `pipe()` steps are all traced. Each retry/page sub-span carries its duration and outcome (status, retry reason); the login and each pipe step are full child-run spans. The flat per-call stream is unchanged for existing consumers; the richness is built in the **sink**, which assembles the tree from run identity + the sub-span structure the events already imply (`progress.attempt`, the `paginate` detail, the surfaced login run).

4.  **Carrier — run identity on the `TraceSink` ctx _and_ on the `start` event; sub-span structure from the events; NOT every event** (resolves Q1). Run identity (`runId`/`traceId`/`parentId`) goes on the run-scoped sink ctx — `handle(event, ctx: { name; runId; traceId; parentId? })` — because it is per-run-constant and both rich consumers (OTLP, the DAG collector) are sinks. It is **also** stamped on the `start` event (1:1 with a run) so a non-sink `.stream()` consumer can learn a run's identity once. Intra-run **sub-span** structure (which attempt/page) rides the events that already exist (`progress.attempt`; the engine will signal page/attempt boundaries explicitly rather than have the sink fragile-infer them). We deliberately do **not** stamp identity on _every_ event — see _Resolved questions Q1_ for the full give/backfire analysis; the short of it is that per-event ids add nothing to the OTLP tree (the sink has ctx) and cost the most exactly on the high-frequency `delta` path.

5.  **Child propagation is EXPLICIT, never ambient.** No `AsyncLocalStorage` (Node-only — breaks the browser-first gate and the playground Web Worker). A run that may spawn children carries a small `RunContext { traceId, runId }`, threaded into a child run as an optional `parent?: RunContext` (on the internal run path / `makeRuntime` / a **traced `executeRaw` variant** for the login). The child mints its own `runId`, inherits `parent.traceId`, sets `parentId = parent.runId`.

6.  **OTLP gets the full sub-span waterfall; the DAG stays readable.** The OTLP export is the rich view: a run span with per-attempt and per-page child spans (timing + status), and child-run spans for logins/pipe steps. The playground DAG shows **run and child-run nodes + edges**, with attempt/page **counts as node annotations** (the `stream: { chunks }` annotation is the precedent), not as separate DAG nodes — intra-run detail belongs in the OTLP waterfall, not the composition graph.

## Resolved questions

-   **Q1 — Trace identity on events too? What it gives, where it backfires (asked in review).**
    -   _What stamping every event gives:_ a non-sink `.stream()` consumer (reading the async-iterable directly, not via a `TraceSink`) can attribute each event to a run without external correlation, and could demultiplex if multiple runs' events were ever merged onto one stream.
    -   _Where it backfires:_ **(a) bloat on the hot path** — identity is ~64 bytes (3 hex ids) repeated on every event, and the `delta` event fires once per chunk (thousands for an LLM/SSE stream), so per-event ids multiply event size precisely where volume is highest and already-truncated payloads live; **(b) redundancy** — the ids are per-run-constant, so per-event is denormalised run data; **(c) no OTLP benefit** — the operator consumes via the OTLP sink, which already has full identity on ctx and builds the rich tree from ctx + sub-span structure, so per-event ids add nothing to the waterfall (the richness comes from **sub-spans**, not from stamping ids on each event); **(d) public-API churn** — `StitchEvent` is a public discriminated union, so 3 new fields hit all 8 variants, ~20 engine construction sites, and every consumer's exhaustive switch.
    -   _Resolution:_ run identity on **ctx** (sinks/OTLP — full richness) **+ on `start`** (non-sink stream consumers, 1:1 with the run, zero delta-path cost). Revisit stamping all-but-`delta` only if we later expose a merged multi-run stream.
-   **Q2 — Paginate pages as child runs? (resolved: consistent with retries, both traced.)** Pages are **not** child runs and retries are **not** child runs — both are **intra-run sub-spans** (Decision 2). Both are traced the same way, so an operator sees how many retries were made, how many pages were scanned, and **how each performed** (per-iteration latency/status). This is the review's explicit ask.
-   **Q3 — Trace the `cookieSession` login? (resolved: yes, as a child run.)** The login is routed through a traced path that tees to the seam's shared sink with `parentId` set — lighting up the `login → call` edge PR #94's own fixture implies. Concretely: a **traced `executeRaw` variant** so the login emits its own run span (its events no longer vanish).
-   **Q4 — `extends` derivation vs. runtime causality? (resolved: out of scope.)** This ADR provides **only runtime causality** (which run/sub-span spawned which). The static `extends` derivation (which stitch was composed from which fragment) is a different axis the collector can't see at runtime; if ever wanted it is a separate optional overlay (distinct edge style / DAG toggle), not part of this work.

## Consequences

-   The OTLP exporter becomes a real, rich span tree: shared `traceId`, populated `parentSpanId`, **per-attempt and per-page child spans** with timing/status, and child-run spans for logins/pipe steps. A strict, operator-facing upgrade to a shipped capability.
-   PR #94's DAG edges populate from real runtime causality (the collector uses `ctx.runId` for the node id, `ctx.parentId` for `dependsOn`, attempt/page counts as annotations), dropping its synthetic ids and FIFO heuristic.
-   #7's `pipe()` gets the parent/child identity its step→step edges need.
-   Cost: a ctx widening + a `start`-event field; a `RunContext` arg on the run path; a **traced `executeRaw` variant** (Q3); the OTLP sink rebuilt to assemble a tree with intra-run sub-spans; the engine signalling attempt/page span boundaries. All additive — the flat-stream behaviour and every existing sink that reads only `ctx.name` are unchanged.

## Alternatives considered

-   **Identity on every `StitchEvent` (as the default).** Rejected — see Q1: per-event bloat (esp. `delta`), redundancy, public-API churn, and zero OTLP benefit. Kept narrowly as the `start`-event stamp for non-sink consumers.
-   **Retries/pages as enriched span _events_ rather than child spans.** Rejected: a span event is a timestamp, not a duration — it can't show "how each attempt/page performed". Child sub-spans are the OTel-idiomatic way to surface per-iteration latency and status, which is exactly the review's ask.
-   **`AsyncLocalStorage` ambient run context.** Rejected: Node-only, breaks browser-first and the playground Worker. Explicit `RunContext` threading is portable and makes the parent/child relation visible at the call site.
-   **Caller-supplied run/correlation ids.** Rejected: ids must be engine-minted and unforgeable (mirrors the `StitchInput`-principal rejection in ADR 0002). Inbound `traceparent` continuation is a separate, opt-in future feature.

## Gates

-   **browser-first** — ids via `crypto.getRandomValues`/`Math.random` (the existing `otlp.ts#hex`), no `AsyncLocalStorage`, no Node-only API on the hot path.
-   **bundle-frugal** — a ctx widening, one `start` field, a small `RunContext`; the richer tree assembly lives in the **opt-in** OTLP sink / out-of-core playground collector, not on the `import { stitch }` hot path.
-   **contract-not-dependency** — the ids are strings on the run-scoped ctx (+ `start`); they round-trip as JSON, and no new vendor capability is introduced.

## Staged implementation (proposed)

1. Run identity (`runId`/`traceId`/`parentId`) on ctx + `start`; OTLP sink reads them (shared `traceId`, `parentSpanId`); DAG collector uses `ctx.runId`/`ctx.parentId`. 2. Traced `executeRaw` variant → the `cookieSession` login becomes a child-run span (Q3). 3. Intra-run **sub-spans** for retries + pages (engine signals boundaries; OTLP renders per-iteration timing/status; DAG annotates counts). Stage 1 unblocks #7's `pipe()`; stages 2–3 deliver the operator-facing richness.
