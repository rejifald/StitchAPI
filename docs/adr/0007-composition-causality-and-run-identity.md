# ADR 0007 — Composition causality: run identity for the event stream

-   **Status:** Proposed (DRAFT — pending review; no code yet)
-   **Date:** 2026-06-16
-   **Tags:** observability, tracing, otlp, playground, composition, causality, browser-first

> [!NOTE]
>
> This is a **design draft to review before any code** — the dogfooding roadmap item #5a. It is FOUNDATIONAL for #7's `pipe()` ([ADR 0008](./0008-non-http-surfaces-and-pipe.md)), so it lands first. The _Open questions_ are genuine forks I want a decision on before implementing.

## Context

A stitch's events are a **flat per-call stream**: `start → progress* → (info|drift|delta)* → result|error → done`, modelled by `StitchEvent` ([`types.ts`](../../packages/core/src/types.ts)) and drained/teed to the trace sink in `tee()` ([`stitch.ts`](../../packages/core/src/stitch.ts)). Each `execute()` ([`engine.ts`](../../packages/core/src/engine.ts)) is **one logical run**. There is no notion of one run having spawned another — the stream carries no parent/child identity at all.

Two consumers already want that identity and cannot get it:

-   **The playground DAG** (PR [#94](https://github.com/rejifald/StitchAPI/pull/94)). `StitchTraceEntry.dependsOn` ([`docs/sandbox/component/runner.ts`](../../docs/sandbox/component/runner.ts)) exists and `traceToMermaid` already draws edges from it — but **nothing populates it**. The trace collector ([`docs/sandbox/runtime/trace-collector.ts`](../../docs/sandbox/runtime/trace-collector.ts)) is a `TraceSink` that mints synthetic `stitch-N` ids and correlates a stitch instance's calls by a per-instance FIFO, and its own header says the edges _"need the composition graph core doesn't emit"_. PR #94's open questions are exactly: does `stitch()`/`seam` **emit parent identity** into the trace, or is it inferred statically — and is an edge runtime causality or `extends` derivation?
-   **The OTLP sink** ([`otlp.ts`](../../packages/core/src/otlp.ts)). It maps each call to one CLIENT span, but **mints a fresh `traceId`/`spanId` per `start`** and guesses correlation from a `name`-keyed stack. Sibling/child calls get unrelated trace ids; `parentSpanId` is never emitted. It is a tree-shaped exporter fed a flat, un-correlated stream.

A run **already** spawns another in one shipped case: `cookieSession` runs its login stitch via `__raw` → `executeRaw` ([`auth.ts`](../../packages/core/src/auth.ts) `doRefresh`). `executeRaw` drives `attemptLoop` directly and **emits no events** — so today that child run is entirely invisible to tracing. #7's `pipe()` will spawn a child run per step. Both need a way to say "this run is a child of that one".

The roadmap item: add **optional run identity** — a `runId` per call, a `parentId` when one run spawns another — kept **OTLP-span-aligned** so the existing exporter and a future trace-based diagram are just span-tree renders.

## Decision (proposed — these are what I want to firm up before coding)

1.  **Three ids, OTLP-aligned.** Each `execute()` mints a `runId` (the OTel **spanId**, 16 hex chars) and belongs to a `traceId` (32 hex chars, the root identity of a run tree). A run spawned by another **inherits the parent's `traceId`** and sets `parentId` = the parent's `runId` (the OTel **parentSpanId**); a root run has a fresh `traceId` and no `parentId`. This is the OTel span model verbatim, so the OTLP sink stops guessing — it keys its open-span map on `runId`, sets `parentSpanId` from `parentId`, and shares one `traceId` across a tree — and any trace-based Mermaid diagram is a span-tree walk.

2.  **Identity rides on the `TraceSink` `ctx`, not on every `StitchEvent`.** Today the sink is `handle(event, ctx: { name })`. Widen the ctx to `{ name; runId; traceId; parentId? }`. Identity is **per-run** — constant across all of a run's events — so it belongs on the run-scoped ctx, not duplicated onto every event. Both consumers that need it are **sinks** (the playground DAG collector _is_ a `TraceSink`; OTLP _is_ a `TraceSink`) and already receive ctx, so this is additive: a sink that reads only `ctx.name` (the built-in JSONL/console/logger sinks) is unchanged. The three ids are strings, so the ctx round-trips as JSON (contract gate). I prefer this over per-event ids; see **Q1**.

3.  **Child propagation is EXPLICIT, never ambient.** No `AsyncLocalStorage` — it is Node-only (breaks the browser-first gate, and stitches run in the playground Web Worker). Instead a run that may spawn children carries a small `RunContext { traceId, runId }`, and the engine threads it into a child's run as an optional `parent?: RunContext` (on the internal run path / `makeRuntime` / a new traced `executeRaw` variant). The child mints its own `runId`, inherits `parent.traceId`, and sets `parentId = parent.runId`. Explicit threading is portable; ambient context is not.

4.  **What counts as a child run (scope).**

    -   **YES — a `pipe()` step** (#7): each step's run is a child of the pipe's run.
    -   **YES — a `cookieSession` login**: it is a sub-call of the call that triggered apply/refresh. (It runs via `executeRaw` today and emits nothing — making it a _traced_ child is a real change; see **Q3**.)
    -   **NO — retry attempts**: already modelled as `attempt` on events within one run; not separate runs.
    -   **NO — coalescing followers**: a follower awaits the leader's one shared result and runs no chain of its own — same logical result, not a child.
    -   **OPEN — paginate pages**: today one run with `paginate` progress events; promoting each page to a child run is a behaviour/noise change (see **Q2**). Streaming `delta`s are emphatically NOT child runs — they are values within one streaming run.

5.  **Id minting is browser-safe and shared.** Reuse the exact helper `otlp.ts#hex` already uses — `crypto.getRandomValues` where available, else `Math.random` (ids need to be unique-ish, not secret) — promoted to a shared zero-dep util. The engine mints; a **caller never supplies a run id** (an externally-named id is a correlation-spoofing surface — the same reasoning that keeps `principal` off `StitchInput` in [ADR 0002](./0002-seam-primitive-and-principal-scoped-auth.md)).

## Consequences

-   PR #94's DAG edges populate from **real runtime causality**: the collector uses `ctx.runId` as the node id (dropping synthetic `stitch-N`) and `ctx.parentId` for `dependsOn`, so concurrent calls on one instance correlate exactly instead of "degrading gracefully" through a FIFO.
-   The OTLP exporter becomes a real span tree (shared `traceId`, populated `parentSpanId`) with no heuristic — a strict improvement to a shipped capability.
-   #7's `pipe()` gets the identity it needs for step→step edges; a trace-based diagram becomes a span-tree render.
-   Cost: a ctx widening threaded through `execute`/`tee`/the sinks; a `RunContext` arg on the internal run path; and — if we take Q3's "trace the login" option — a traced `executeRaw` variant. All additive; the flat-stream behaviour and every existing sink are unchanged.

## Open questions (where I want to stop for your input)

-   **Q1 — Carrier: sink `ctx` (recommended) vs. the `StitchEvent`s themselves.** ctx is per-run, lean, and both consumers are sinks. But a `.stream()` consumer (an async-iterable reader that is _not_ a sink — e.g. a future client building a DAG straight off the stream) would not see causality. If we want that, the ids must be on the events — cheapest is on `start` only (1:1 with a run). Sink channel enough, or also on `start`?
-   **Q2 — Are paginate pages child runs?** Keep pagination as one run with `paginate` progress events (my default — additive, no behaviour change to a shipped surface), or promote each page to a child span (richer DAG, noisier traces)?
-   **Q3 — Trace the `cookieSession` login as a child run?** (a) Leave it invisible — smallest, but the `fetch-token → call` edge PR #94's own test fixture implies stays unshown; (b) route the login through a traced path that tees to the seam's shared sink with `parentId` set — lights up the edge, but changes how login runs and adds the login's events to the stream. Which?
-   **Q4 — `extends` derivation vs. runtime causality.** PR #94 conflates two edge meanings. This ADR provides **only runtime causality** (which run spawned which). The **static `extends` derivation** (which stitch was composed from which fragment) is a different axis the collector can't see at runtime. I propose it stays **out of scope** here — a separate optional overlay (distinct edge style / DAG toggle) if we ever want it. Agree?

## Alternatives considered

-   **`AsyncLocalStorage` ambient run context.** Rejected: Node-only, breaks browser-first and the playground Worker. Explicit `RunContext` threading is portable and makes the parent/child relation visible at the call site.
-   **Per-event ids on every `StitchEvent` (as the default).** Rejected as default: duplicates per-run data on every event with no consumer that needs it there. Kept as **Q1** for the non-sink `.stream()` case.
-   **Caller-supplied run/correlation ids.** Rejected: ids must be engine-minted and unforgeable; a caller-named id spoofs correlation (mirrors the `StitchInput`-principal rejection in ADR 0002). A future _inbound_ `traceparent` continuation (W3C Trace Context) is a separate, opt-in feature, not this.

## Gates

-   **browser-first** — ids via `crypto.getRandomValues`/`Math.random` (the existing `otlp.ts#hex`), no `AsyncLocalStorage`, no Node-only API on the hot path.
-   **bundle-frugal** — a ctx widening + a small `RunContext`; no new statically-imported hot-path module (OTLP and the playground collector are already opt-in / out-of-core).
-   **contract-not-dependency** — the three ids are strings on the run-scoped ctx; they round-trip as JSON, and no new vendor capability is introduced.
