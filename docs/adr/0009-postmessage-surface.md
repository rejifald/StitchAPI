# ADR 0009 — The `postMessage` surface: typed iframe↔parent RPC + events

-   **Status:** Accepted
-   **Date:** 2026-06-17
-   **Tags:** surfaces, transport, postmessage, browser, iframe, messageport, events, security, browser-first

> [!NOTE]
>
> This rides the surface model ([ADR 0005](./0005-surfaces-and-the-authoring-model.md)) and the transport-replacing `Surface.execute` hook ([ADR 0008](./0008-non-http-surfaces-and-pipe.md)) — the same machinery `shell` and `llm` use — plus the run-identity spans of [ADR 0007](./0007-composition-causality-and-run-identity.md). The load-bearing decision is the **security model**: origin is first-class and gated **before** any dispatch or validation, the "structural, not advisory" bar that rejected `inferBearer` in #6 and shaped the `shell` surface.

## Context

The browser's `postMessage` is how a page talks to an iframe it embeds (or that embeds it), to a popup, to a Web Worker, or across a `MessageChannel`. It is _also_ a perennial source of three bugs, every one of which StitchAPI exists to remove:

1.  **Drifted contracts.** The two sides agree on a message shape by convention — `{ type: 'focus', payload: … }` — written twice, in two codebases, with nothing checking they still match. The receiver reads `e.data.user.id` and one rename later it is `undefined`. This is exactly the response-shape drift `output` validation catches for HTTP, with no equivalent on the message bus.
2.  **No validation.** `e.data` is `any`. A handler trusts whatever crossed the wire — wrong types, missing fields, a hostile peer's payload — because there is no schema between the `MessageEvent` and the application code.
3.  **`postMessage('*')` with no origin check.** The single most common postMessage vulnerability: posting to (or accepting from) `targetOrigin: '*'`, which leaks the message to whatever document currently occupies the frame and accepts a reply from anywhere. The browser API makes the unsafe path the easy path — `'*'` is one character shorter than the right answer.

A fourth, smaller waste: `postMessage` carries no request/response correlation. Every RPC-over-postMessage reinvents a `{ id }` field and a pending-promise map by hand, usually subtly wrong (no timeout, no abort, leaks the pending entry on a dropped reply).

The `Surface` model already has the two pieces this needs. `Surface.execute` ([ADR 0008](./0008-non-http-surfaces-and-pipe.md)) lets a surface **replace the transport** at the engine's adapter call site, _inside_ the resilience chain, so `retry`/`throttle`/`circuit`/per-attempt `timeout`/`signal`/`trace`/`auth`/`hooks` all wrap it. `Surface.stream` ([ADR 0005](./0005-surfaces-and-the-authoring-model.md) Decision 12) marks a surface streaming and decodes a live body into `delta` chunks. A `postMessage` RPC is a custom transport (`execute`); a `postMessage` event subscription is a stream (`stream`). Nothing in the core engine needs to change.

## Decision

**Ship a `postMessage` surface family behind a `stitchapi/postmessage` core subpath** — typed, validated, observable RPC + events over a `Window`, an iframe's `contentWindow`, or a `MessagePort`, riding `Surface.execute` / `Surface.stream`.

1.  **A `channel` abstraction binds the transport + the security policy at construction.** The browser primitive (where messages go, what origin they must carry) is _not_ a per-call concern — it is the channel's identity, bound once, exactly as a seam binds `baseUrl`/`auth` once. The entry points are `windowChannel({ target, targetOrigin, allowedOrigins? })` (a `Window`, or a `() => Window` thunk for a frame that mounts late), `portChannel(port, { allowedOrigins? })` (a `MessagePort`), and the low-level `channel(transport, { allowedOrigins })` over any `MessageTransport` (the in-memory seam the tests drive). A `MessageTransport` is the one small interface between this surface and a concrete primitive — `post(message, transfer?)` + `subscribe(handler) → unsubscribe` — which is what lets the whole surface be exercised over a fake linked pair with no DOM.

2.  **Four verbs, two surface ids.** A `PostMessageChannel` mints:

    -   **`request(opts)`** — correlated request→response. A **buffered** surface (`id: 'postmessage'`) whose `execute` mints an id, posts `{ type, id, payload }`, registers a pending entry, and resolves when the matching `{ type: reply, id }` lands (`reply` defaults to `` `${type}-result` ``). The reply payload is the value; `output` validates it.
    -   **`emit(opts)`** — fire-and-forget. The same buffered surface, but `execute` posts `{ type, payload }` (no id) and resolves immediately; result `void`.
    -   **`events(opts)`** — inbound event subscription. A **streaming** surface (`id: 'postmessage-event'`) whose `execute` hands the engine a live `ReadableStream` the channel feeds; `await` resolves to the collected payload array, `.stream()` yields live deltas; `output` validates each payload (per-`delta`, [ADR 0005](./0005-surfaces-and-the-authoring-model.md) Addendum).
    -   **`respond(type, handler, opts?)`** — the **receiving** side (e.g. an iframe answering a parent's `focus`). Origin-gated, validates the inbound payload against `input`, runs `handler`, validates the result against `output`, posts `{ type: reply, id, payload: result }`. It is the only verb that is **not** a stitch — it makes no outbound call, so it returns a plain unsubscribe.

    The registry — the pending-request map, the responder map, the event-subscription set — lives **per channel**, behind a **single** demux listener attached once at construction (the decision: per-channel, not per-surface; one listener, not one per stitch). `close()` detaches it, rejects every pending request, and ends every event stream.

3.  **The demux gates origin FIRST.** On each inbound `(data, origin)` the channel: (1) **origin-gates** — an origin not in `allowedOrigins` is dropped _before_ anything else (a `MessagePort` carries no origin, `''`, and skips the gate — a port is already a private capability); (2) shape-guards `{ type: string }`; (3) correlates a **reply** by id _and_ type; (4) dispatches to a **responder** (validate inbound → run → validate result → post reply); (5) fans to matching **event** subscriptions; (6) drops the unmatched. Gate-before-validation is the security bar, not an optimisation (Decision 5).

4.  **Correlation, timeout, and abort reuse the resilience chain — no bespoke timer.** `request`'s `execute` wires the engine's per-attempt `signal` (which `withTimeout` aborts on `timeout`, and a caller's `signal` aborts on cancellation) to reject-and-deregister the pending entry. A request with no matching reply therefore rejects via the engine's `timeout`/`signal`, surfacing as an ordinary `StitchError` — the concrete payoff of [ADR 0008](./0008-non-http-surfaces-and-pipe.md) Decision 1, identical to how `shell` gets timeout/cancel for free. No second timer is invented.

5.  **A core subpath, not a peer package.** Unlike `shell` (Node-only, quarantined out of core), `postMessage` is the **most browser-native capability StitchAPI has** — it needs nothing but `postMessage`/`MessageEvent`/`MessagePort`/`ReadableStream`/`globalThis.crypto`. So it ships as a core subpath (`stitchapi/postmessage`), reached only through `cfg.kind`, exactly like `sse`/`stream`/`graphql`. The root entry never imports it.

## How it holds the three gates

-   **browser-first** — the module uses only browser-native APIs; no `node:*`, no `Buffer`. It is pinned in the `browser-bundle.spec` matrix both as a `BROWSER_LEGIT` subpath and in the streaming-surface set (its `events` verb carries a `stream` hook), asserting it bundles for `"browser"` with no `node:*` and no `EventSource`.
-   **bundle-frugal** — reached only through the `stitchapi/postmessage` subpath; `import { stitch }` pulls in none of it (the engine reaches the surface via `cfg.kind` at runtime, never a static import).
-   **contract-not-dependency** — `kind` round-trips to its `id` string on `__config` ([ADR 0005](./0005-surfaces-and-the-authoring-model.md) Decision 11): `'postmessage'` for request/emit, `'postmessage-event'` for events, both valid JSON. The live `execute`/`stream` hooks and the target `Window` are redacted, never serialised. The non-serializable bits — a `Window` thunk, a `MessagePort` instance — are acknowledged **sugar** in the exact category the library already draws the line at (`transform`, `paginate.next`, `cache.key`, `pipe`'s step mapping): the channel's _binding_ is sugar; a stitch's _declaration_ (its `kind` id, `type`, schemas) serializes.

## Security model

Origin handling is **structural, not advisory** — the bar that rejected host-inferred bearer tokens in #6 and that the `shell` surface set for command injection:

-   **The `Origin` type forbids `'*'`.** `Origin = ` `` `https://${string}` | `http://${string}` `` — `'*'` is not assignable to either arm, so a wildcard `targetOrigin` is a **compile error**, not a lint warning. The unsafe path is unspellable in typed code.
-   **`windowChannel` also throws at runtime on `'*'`** — defense in depth, so an `as any` cast past the type still fails fast at construction rather than leaking the first message.
-   **The gate runs before dispatch and before validation.** A message from a disallowed origin is dropped in step 1 of the demux — never correlated to a pending request, never handed to a responder, never validated, never delivered to an event stream. An attacker on the wrong origin learns nothing from timing or from a validation error, because neither runs.
-   **An empty `allowedOrigins` over an origin-bearing transport fails closed** (drops everything) — a misconfigured channel is silent, not promiscuous.
-   **`MessagePort` is exempt by construction.** A port is a private, already-handed-out capability with no origin; gating it would be theatre. The exemption is documented, not silent.

A responder DROPS a payload that fails its `input` schema rather than replying with an error (a hostile peer learns nothing from the reply shape), and never posts a result that fails its `output` schema (an off-contract reply is suppressed, not sent).

## Observability (ADR 0007)

Every verb is an ordinary stitch run, so each gets a run-identity span ([ADR 0007](./0007-composition-causality-and-run-identity.md)) and the full `start → request → (delta…) → result → done` event spine for free: a `request`'s `start`/`result`, an `events` subscription's per-payload `delta`s, a drift finding when a payload violates `output`. A `postMessage` exchange becomes visible in the same trace/DAG as an HTTP call — the message bus stops being a blind spot.

## Packaging

-   New file `packages/core/src/postmessage.ts`; a `stitchapi/postmessage` subpath entry in `tsup.config.ts` and a `./postmessage` export block in `package.json` (browser/import/require), mirroring `./sse` exactly.
-   Browser-bundle matrix updated: `'src/postmessage.ts'` in `BROWSER_LEGIT` and in the streaming-surface `test.each`.
-   **Zero core-engine change.** The surface rides `execute`/`stream`/`contractValue` as-is; the absolute-URL guard is already bypassed for any surface carrying `execute` (the `postmessage:<type>` pseudo-endpoint passes), and the streaming path already drives `cfg.kind.execute` for a future non-HTTP streaming surface.

## Alternatives considered

-   **Overload the user `adapter` instead of a surface.** Rejected for the same reason [ADR 0008](./0008-non-http-surfaces-and-pipe.md) rejected it for `shell`: `adapter` is the user's HTTP-client slot. A `postMessage` channel is a protocol with its own request shaping, correlation, and a stateful registry behind a single listener — that is a `Surface` identity (`buildRequest` + `execute`/`stream` bundled with the `id`), not a transport swap. Overloading `adapter` would also lose the per-channel registry and muddy redaction.
-   **A full RPC `serve`-style responder primitive.** `respond` is deliberately the **minimal** responder — register one handler per `type`, validate-in/validate-out, reply. A richer surface (a routed responder table, method namespaces, a `serve`-style declarative receiver, schema-negotiated handshakes) is **future work**; it is not needed to remove the three bugs in Context, and shipping the minimum keeps the first version reviewable. The channel abstraction leaves room for it (a responder registry already exists per channel).
-   **Use `EventSource`-style auto-reconnect / replay for `events`.** Out of scope, mirroring the `sse` decision: a dropped channel is the caller's to re-establish; buffering/replay is a separate concern.
-   **A single callable default export** (à la `sse(config)`). Rejected: `postMessage` has _four_ verbs (request/emit/events/respond) with no single "the call", and the transport+origin must be bound before any of them. The **channel factory is the entry point**; the builders and the two `Surface` identities are the named exports.

## Gates

-   **browser-first** — only browser-native APIs; pinned in the `browser-bundle.spec` matrix (both legit-subpath and streaming-surface), no `node:*`, no `EventSource`.
-   **bundle-frugal** — subpath-only; `import { stitch }` pulls in none of it.
-   **contract-not-dependency** — `kind` round-trips as its `id` (`'postmessage'` / `'postmessage-event'`); live hooks + the target `Window`/`MessagePort` are redacted sugar, the channel's binding being in the same category as `transform`/`pipe`.
-   **security** — origin is a first-class, non-`'*'` type **and** a runtime guard; the gate runs **before** correlation/validation/delivery; responders fail closed on bad input/output; `MessagePort` is exempt by construction with that exemption documented.
