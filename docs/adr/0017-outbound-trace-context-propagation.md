# ADR 0017 — Outbound trace-context propagation: correlation is not idempotency

- **Status:** Proposed
- **Date:** 2026-06-29
- **Tags:** observability, tracing, traceparent, w3c-trace-context, propagation, correlation, idempotency, browser-first

> [!NOTE]
>
> The load-bearing decision is a **separation**, not a feature: an _idempotency
> key_ and a _correlation/trace id_ answer different questions and only
> coincidentally share "stable across a call's retries". Give correlation its own
> **outbound** door that reuses the engine's existing `traceId` — instead of
> overloading [`idempotency.header`](../../packages/core/src/types.ts), which sends a
> value that can never line up with the spans the OTLP sink already exports.

## Context

[ADR 0007](./0007-composition-causality-and-run-identity.md) mints an OTel-shaped
run identity — `traceId` (shared across a tree), `spanId` (this run), `parentSpanId` —
**engine-minted, never caller-supplied**, and exports it to OTLP. But that identity
**never reaches the wire**: the request a stitch makes carries no `traceparent`, so
a downstream server cannot continue the client's trace tree. ADR 0007 explicitly
reserved the _inbound_ `traceparent` continuation as "a separate opt-in future
feature"; the symmetric **outbound emit is simply unbuilt**.

Because of that gap, the only way to put a per-request id on the wire today is to
**repurpose `idempotency.header`** — set it to `X-Request-Id` and let the random
idempotency key double as a request id. That conflates two distinct concerns:

|                                      | **Idempotency key**           | **Correlation / trace id**          |
| ------------------------------------ | ----------------------------- | ----------------------------------- |
| Question                             | "are these the same _write_?" | "which _operation_ is this?"        |
| Server does                          | dedupe / collapse the replay  | log it, link spans                  |
| Stable across retries                | yes (must be)                 | yes (typically)                     |
| Stable across _separate submissions_ | only if **derived**           | **no** — each call is its own trace |
| Right value                          | random _or_ derived           | the engine's `traceId` / `spanId`   |
| Standard header                      | `Idempotency-Key`             | `traceparent`, `X-Request-Id`       |

The codebase already draws this line in one place and blurs it in another: the
cache's volatile-header denylist ([`cache.ts`](../../packages/core/src/cache.ts))
classifies `traceparent` / `x-request-id` / `x-correlation-id` as correlation
headers excluded from the derived key — while the idempotency docs teach
`header: 'X-Request-Id'` as a rename. The workaround is also _wrong on its own
terms_: the random idempotency key is unrelated to the real `traceId`, so the
`X-Request-Id` a server logs can never be joined to the spans StitchAPI exports.

**Current state (audited).** The in-process tree is **live, with no dead code**:
`newRunContext(parent)` ([`util.ts`](../../packages/core/src/util.ts)) inherits the
`traceId` and sets `parentSpanId` for the two paths that spawn children — a `pipe()`
step (each a child of the prior) and a `cookieSession` login (a child of the
caller) — and [`otlp.ts`](../../packages/core/src/otlp.ts) reads
`traceId`/`spanId`/`parentSpanId` as `traceId`/`spanId`/`parentSpanId`. Every field is
consumed. What is absent is purely the **wire projection, in both directions**:
nothing formats a `traceparent` onto the outbound request (this ADR), and nothing
parses an inbound one (ADR 0007's reserved continuation). So the tree is real but
**stops at the process boundary** today — it does not yet link to a downstream
server's spans.

## Decision (proposed)

**Add opt-in outbound trace-context propagation that emits the run's
engine-minted identity on the outbound request, as a field distinct from
`idempotency`. `idempotency` reverts to meaning only "the key a server dedupes
on".**

1.  **W3C `traceparent` is the default carrier.** Build it from the run's
    `traceId` + `spanId` + sampled flag, so a downstream server continues
    **the same trace tree** the OTLP sink ([`otlp.ts`](../../packages/core/src/otlp.ts))
    already emits — the outbound header and the exported span agree by construction.
    `tracestate` is carried through when present.

2.  **A configurable correlation header, for systems that don't speak W3C.**
    Some infrastructure keys on `X-Request-Id` / `X-Correlation-Id` rather than
    `traceparent`; allow naming one, carrying the same `traceId` (or `spanId`). This
    is the legitimate version of the workaround — same intent, but the value is the
    real trace id and it travels through the propagation door, not the dedupe door.

3.  **Off by default, and host-scoped when on — a policy, not a blanket switch.**
    Nothing is emitted unless propagation is configured, and configuring it names
    _which hosts_ receive the headers (an allowlist, or a predicate on the resolved
    URL), never a global "emit to everything". A correlation id is **low-sensitivity**
    — an opaque random token, not a secret like a bearer token — so this is _not_ the
    fail-closed auth posture; the scoping exists for two milder reasons: (a) sending
    the same `traceId` to several third parties lets them correlate your traffic, and
    (b) spraying W3C trace headers at APIs that don't speak them is noise.
    Default-when-enabled = only the hosts you name (typically your own services); a
    third-party API (Stripe, OpenAI) gets nothing unless you opt it in. This mirrors
    ADR 0007's reserved inbound continuation and the "a stitch's only effect is its
    call" posture.

4.  **Ids stay engine-minted and unforgeable.** No caller-supplied trace/correlation
    id (a caller-named id spoofs correlation — the same reasoning that keeps
    `principal` off `StitchInput` in [ADR 0002](./0002-seam-primitive-and-principal-scoped-auth.md)
    and run ids engine-minted in ADR 0007). Browser-safe — reuses `otlp.ts#hex`,
    no `node:*`, no `AsyncLocalStorage`.

5.  **Built on the request path, beside `applyIdempotency`, but a separate seam.**
    The two never share a field again. `idempotency.header` keeps its narrowed
    meaning; propagation owns `traceparent` / the correlation header.

6.  **One child span per retry on the wire — the deliberate asymmetry with the key.**
    Across a write's retries the idempotency key stays **fixed** ("same write"), but
    the `traceparent` does **not**: each attempt mints a child span (ADR 0007 already
    models retries as iterations), so the downstream trace shows every attempt. The
    two answer different questions — the key, "is this the same write?"; the span,
    "which attempt is this?" — so they _should_ diverge across a retry, not match.

7.  **The wire form is a projection of the run identity, never a replacement for it.**
    `traceparent` packs `traceId` + **one** span id + flags; a `RunContext` needs
    `traceId` + **two** span ids — its own `spanId` _and_ its `parentSpanId` — to both
    place itself in the OTLP tree and parent its children. The middle field of
    `traceparent` is directional: it is the sender's `spanId` going out and becomes the
    receiver's `parentSpanId` coming in, so one header can hold _either_ `(traceId, spanId)`
    _or_ `(traceId, parentSpanId)`, never all three. The engine therefore keeps the
    three-field `RunContext` struct as the source of truth and **derives** a
    `traceparent` from it on the way out (`traceId` + `spanId` + flags); the reserved
    inbound continuation **parses** one into a seed (`traceId` + `parentSpanId`, then a
    fresh `spanId`). Do not collapse the struct into a single stored `traceparent` — it
    drops one of the two span ids and silently breaks child-span parenting, and
    `otlp.ts` reads all three as fields, not substrings.

## Consequences

- `idempotency.header` documents cleanly as "rename the idempotency key" — the
  docs de-conflation (blog `idempotency-keys-safe-retries`, guide
  `resilience/idempotency`, recipe `idempotent-writes`) lands ahead of this ADR
  and stops teaching the mix.
- Correlation gets a first-class, **trace-aligned** door: the id on the wire is
  the id in the user's traces, so client and server spans actually join.
- With correlation moved here, `idempotency` is unambiguously about dedupe — so
  the idempotency feature's construction nudge (a random key with no `retry`
  usually has nothing to collapse) no longer has "but it's my request id" as a
  counter-argument: that need is served by this door instead, and the nudge stays
  silenceable (`idempotency.warn = false`) for the narrow proxy-dedupe case.
- New surface + bytes on an opt-in path. Measure against the core bundle budget
  ([`bundle-size.mjs`](../../packages/core/scripts/bundle-size.mjs)); if it doesn't
  fit the hot path, ship it behind a `stitchapi/trace` subpath like cache / sse —
  propagation is a tracing concern and consumers who don't opt in shouldn't pay
  for it.

## Open questions

- **Header set:** `traceparent` only, or also a configurable correlation header
  in the first cut?
- **Policy shape:** a host allowlist (simplest), a predicate on the resolved URL
  (most flexible), or both? And does it live on `trace` config, a dedicated
  `propagation` block, or the `seam`?
- **Home:** core hot path vs a `stitchapi/trace` subpath, given the bundle budget.
- **Pair with inbound?** ADR 0007's reserved inbound `traceparent` continuation
  is the mirror of this; decide whether they land together.
- **Fan-out into separate traces.** `traceparent` only links a child to its direct
  caller in the _same_ trace. When one initiator spawns work that runs as its own
  trace (a queue job, a batch, an async webhook with a fresh `traceId`), parent-child
  can't join them — that's OTel **span links** (explicit references to other
  spanContexts), which neither this ADR nor ADR 0007 models. Out of scope here;
  recorded so propagation isn't mistaken for covering it.

## Alternatives considered

- **Keep overloading `idempotency.header`.** Rejected: conflates dedupe with
  correlation, and the random key can never equal the `traceId`, so it never
  correlates with the spans StitchAPI exports — it _looks_ like tracing without
  being it.
- **Caller-supplied correlation id on `StitchInput`.** Rejected: ids must be
  engine-minted and unforgeable (ADR 0002 principal, ADR 0007 run identity).
