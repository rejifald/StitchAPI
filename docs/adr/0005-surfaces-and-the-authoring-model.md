# ADR 0005 — Surfaces & the authoring model

-   **Status:** Proposed (decisions firm; implemented in stages — see _Staged rollout_). Supersedes the closed `kind: 'http' | 'graphql'` union in [`packages/core/src/types.ts`](../../packages/core/src/types.ts).
-   **Date:** 2026-06-14
-   **Tags:** authoring-surface, surfaces, streaming, multipart, packaging, browser-first, runtime

> [!NOTE]
>
> The numbering is **0005**, not 0003. The "ADR 0003" referenced in the implementation brief is a typo: `0003` is the derived-key response cache ([`0003-derived-key-response-cache-and-coalescing.md`](./0003-derived-key-response-cache-and-coalescing.md)) and `0004` is the Standard Schema fingerprint. This is the next free number.

## Context

A stitch today is a JSON-over-HTTP call: `buildRequest` reads `cfg.kind` — a closed `'http' | 'graphql'` string union — and the engine special-cases the one non-default member (`graphql`) inline in three places ([`engine.ts`](../../packages/core/src/engine.ts): `buildRequest`, `runFrom`, `paginated`). Two pressures have built up against that shape:

-   **The kind is a closed enum the library owns.** Every new request _style_ — Server-Sent Events, a raw chunked stream, a binary download — would be another member baked into core, another `if (cfg.kind === …)` branch on the hot path, and another lump of engine code that `import { stitch }` pays for whether or not a caller ever streams. GraphQL already demonstrates the smell: its POST-`{query,variables}` shaping, its `data` unwrap, and its "200-with-`errors`-is-a-failure" rule are scattered through the engine rather than owned by one cohesive unit.
-   **The transport contract is buffer-only.** `Adapter` is `(req) => Promise<AdapterResponse>` where `AdapterResponse.body` is "parsed JSON when possible, else text" — fully read before the engine sees it. There is no way for a transport to hand back a live byte stream, and no way for a caller to observe upload/download progress. The `delta` `StitchEvent` (`{ type: 'delta'; chunk: unknown }`) was reserved in the event spine for exactly this and has sat **dormant** — defined, never emitted.

The shape we converged on: a **surface** is a first-class, pluggable _request style_ — an `id` plus a small set of behaviour hooks — that owns how a call is built, how its response is interpreted, and (for streaming styles) how bytes become `delta` chunks. `http` is just the default surface; `graphql`, `sse`, `stream`, and `download` are peers. The closed `kind` union is replaced by "the kind **is** the surface."

This is **forward-looking** and lands in stages (each its own reviewable PR), but the core decisions are firm. There are no production users, so every choice optimises for correctness and the three project gates over continuity:

-   **Browser-first** — every surface runs on `fetch` + Web Streams, available in the browser, Node ≥ 18, and workers. No `EventSource`, no Node-only stream deps, no `fs`.
-   **Bundle-frugal** — `import { stitch }` pulls in **no** surface engine beyond `http`. Each surface (and each adapter) is its own subpath export, loaded only when used, exactly as the cache engine is reached through a lazy `import('./cache')` today.
-   **Contract-not-dependency** — a stitch's declaration must round-trip as JSON. A surface is named by a **string id** in `__config`; its behaviour closures are runtime-only and never serialised (Decision 11).

## Decision

1.  **A surface is a plugin, not an enum member.** Introduce `Surface<TInput, TResult>` — an object with a stable string `id` and a small set of **behaviour hooks** that the engine calls instead of branching on `kind`. The minimum hooks cover the three things the engine special-cases today and the two things streaming adds:

    -   `buildRequest(cfg, input) => AdapterRequest` (or a patch over the http default) — how the call is shaped. `graphql` puts `{ query, variables }` in the body and forces `POST`; `download` forces `GET` + `responseType: 'blob'`; `http` is the identity.
    -   `interpret(res, cfg) => { value } | { error }` — how a buffered response becomes the result (or a failure). `graphql`'s "200-with-`errors`" rule lives here, not in the engine.
    -   `stream?(res, cfg) => AsyncIterable<unknown>` — present only on streaming surfaces (`sse`, `stream`); each yielded item is emitted as a `delta` chunk. Its presence is what marks a surface as **streaming** (Decision 12).

    Surfaces are **pure data + closures**; they hold no per-call state. The engine owns retry/throttle/circuit/cache/validation; a surface owns only _shaping_ and _interpretation_. This keeps the cross-cutting machinery in one place and lets a surface stay a small, testable unit.

2.  **`kind` becomes the surface; the closed union is dropped; `__config` normalises it to the id string.** `StitchConfig.kind` changes from `'http' | 'graphql'` to `Surface` (object) — with `http` as the default when omitted. The engine never sees a string union again; it asks the surface. For the **contract-not-dependency** gate, the public `__config` stores only the surface's **`id` string** (the live `Surface` object, like `auth`, `adapter`, and `store`, is stripped in `redactConfig`): a stitch's declaration still serialises to `{ "kind": "graphql", … }` for MCP, the playground, and `llms.txt`. `__rawConfig` keeps the live object for composition.

3.  **Typed authoring: one generic overload + monomorphic per-surface helpers; the seam stays surface-agnostic.** Two co-existing spellings, same engine:

    -   **Generic, on the core `stitch`** — `stitch<S extends Surface>({ kind: S, …InputOf<S> })` infers the call-argument and result types from the surface, the same way `stitch` already infers from `config.output` / `config.input`. Pass any surface; `http` is the default when `kind` is omitted, so every existing call is unchanged.
    -   **Monomorphic, per surface** — each surface ships a **subpath export** exposing its own `.stitch()` (and `.seam(...)`) pre-bound to that surface, so `import { sse } from 'stitchapi/sse'; sse.stitch({ … })` needs no `kind` and gives surface-specific types and docs. This mirrors the existing top-level `graphql(...)` preset, generalised.
    -   The **seam does not fork per surface.** `seam.stitch({ kind: … })` and `surface.seam(existingSeam)` both produce members of the _same_ seam — one shared runtime, one principal boundary, one registry (ADR 0002). A surface customises _a stitch_, never the seam's identity/lifecycle.

4.  **`sse` surface — Server-Sent Events over `fetch`, not `EventSource`.** A streaming surface whose `stream` hook parses the **`text/event-stream`** wire format (events separated by blank lines; `event:` / `data:` (multiple `data:` lines joined with `\n`) / `id:` / `retry:` fields; `:`-prefixed comments ignored) off the response's `ReadableStream`, and yields one parsed event per `delta` chunk (`{ event?, data, id?, retry? }`, with `data` JSON-parsed when it parses, else the raw string). `EventSource` is rejected: it is GET-only, has no custom headers (so no auth), and is absent in Node — all three gates fail. Using `fetch` + Web Streams keeps SSE on the same auth/retry/headers path as every other surface.

5.  **`stream` surface — raw response streaming with a configurable decoder.** The generic streaming sibling of `sse`: its `stream` hook reads the `ReadableStream` and decodes each chunk per `stream.decode`:

    -   `'bytes'` — raw `Uint8Array` chunks, lossless, no encoding assumed (**the default** — see _Open questions_ Q2).
    -   `'lines'` — UTF-8, split on `\n`, each `delta` chunk a `string`.
    -   `'ndjson'` — `'lines'` + `JSON.parse` per line, each chunk a parsed value.

    Decoders share an internal byte→line reader with `sse` (Decision 4) but `sse` layers its own frame parser on top — see _Open questions_ Q3.

6.  **Nested multipart — `multipart.nesting`.** `encodeRequestBody` / `appendForm` ([`http-adapter.ts`](../../packages/core/src/http-adapter.ts)) currently iterate top-level keys only, so a nested object becomes `[object Object]`. Add `multipart.nesting`:

    -   `'bracket'` (**default**) — recursive flatten to `parent[child][0]` keys (PHP/Rails convention), the broadest server compatibility.
    -   `'dot'` — `parent.child.0` keys.
    -   `'json'` — scalars/objects without files are `JSON.stringify`-ed into one part; any **file leaf** is hoisted out into its own path-keyed part, so a JSON metadata blob can still carry binary siblings.
    -   `'none'` — today's behaviour (top-level only), kept as an escape hatch.

    A **file leaf** is a `Blob`, a `Uint8Array`, or a `{ value, filename?, type? }` wrapper (the same detection `appendForm` already uses). No new dependencies — recursion + the existing `FormData`.

7.  **Positioning: "fits any style" becomes "any surface."** The surface is now the unifying noun for "REST, GraphQL, SSE, a stream, a download — one authoring model, one resilience/auth/observability spine." Docs and the README reframe the "fits any style" line around the concrete, enumerable set of surfaces and the fact that they all ride the same engine.

8.  **`download` surface — a buffered binary GET with progress and a filename.** A non-streaming surface for "fetch a file": `GET` + `responseType: 'blob'` + byte progress (Decision 9 `onProgress`) + an `AbortSignal`, resolving to `{ blob, filename }`. `filename` is parsed from `Content-Disposition` (`filename*`/`filename`), falling back to the URL's last path segment. It **never writes to disk** — returning a `Blob` keeps it browser-first; saving is the caller's choice. (Distinct from `stream`: `download` _buffers_ the whole body into a Blob while reporting progress; `stream` hands back live chunks.)

9.  **Adapter contract extension — streaming `body` + `onProgress`.** The minimal transport widening that every streaming/progress surface rides on (resolutions in _Open questions_ Q1):

    -   `AdapterRequest` gains `stream?: boolean` (ask the transport **not** to buffer/parse — return the live body) and `onProgress?: (p: ProgressEvent) => void` where `ProgressEvent = { phase: 'upload' | 'download'; loaded: number; total?: number }`.
    -   `AdapterResponse.body` is **reused** as the stream slot: when `req.stream` is set, `body` is the response's `ReadableStream<Uint8Array>` (the field is already `unknown`, so no type break); otherwise it is the parsed/encoded value as today. The surface that asked for a stream narrows it.
    -   `fetchAdapter` implements both (return `response.body` when streaming; report `download` progress while reading a buffered binary body via `Content-Length` + the body reader). A new **browser-only**, zero-dep `xhrAdapter` ([`xhr-adapter.ts`](../../packages/core/src/xhr-adapter.ts)) adds **upload** progress (which `fetch` cannot report). `axiosAdapter` stays buffered-only: it ignores `onProgress` and **throws a clear error** if `req.stream` is set, and must keep compiling against the widened contract.

10. **Packaging: every surface and adapter is a subpath export.** `package.json` `exports` gains `./sse`, `./stream`, `./download`, `./graphql`, and `./xhr` (the xhr adapter) alongside the existing `./cache`, `./fingerprint`, etc. The engine reaches a streaming surface's code the same way it reaches the cache: only when a stitch actually uses it. `import { stitch }` from the root entry bundles `http` only. The generic `stitch<S>(...)` overload is type-level (free at runtime); the per-surface helpers live behind their subpaths.

11. **Capabilities round-trip as JSON (the contract-not-dependency gate, applied).** A surface is **identified**, in everything a stitch exposes publicly, by its string `id`. `__config.kind` is the id string; `redactConfig` strips the live `Surface` object exactly as it strips `store`/`auth`/`adapter`. So a stitch built with any surface still serialises losslessly to JSON for MCP tools, the playground, drift snapshots, and `llms.txt`; the behaviour hooks are an implementation detail of the running process, never part of the contract. A surface id that a consumer doesn't recognise degrades to "an http-shaped call of unknown style," never a crash.

12. **Streaming members are exempt from the seam concurrency bucket but DO charge the rate gate.** A long-lived SSE/stream connection that held a concurrency slot would pin it for the connection's whole lifetime and could deadlock a seam with a small `concurrency` cap. So a **streaming** surface (one with a `stream` hook, Decision 1) **skips concurrency acquisition** entirely — it never takes or releases a `concurrency` slot — but **still charges the rate limiter** once at open, because _opening_ a stream is a request the partner counts. Concretely, the engine's throttle step ([`engine.ts`](../../packages/core/src/engine.ts) `attemptLoop`, [`resilience.ts`](../../packages/core/src/resilience.ts) / [`store.ts`](../../packages/core/src/store.ts)) learns a "rate-only" acquire for streaming surfaces. Retry/timeout semantics for a broken stream are out of scope here (the connection either opens or fails to open).

## Open questions (resolved)

Stage 0 of the rollout is to **resolve** the three questions left open when this surface model was first sketched, and record the decisions here before any code.

### Q1 — How does a streaming `body` sit on `AdapterResponse`, and how does it coexist with `onProgress`?

**Resolved:** _reuse the `body` slot for the stream; keep `onProgress` orthogonal._

`AdapterResponse.body` is already typed `unknown`. Rather than add a second `stream?: ReadableStream` field that every non-streaming reader must learn to ignore (two sources of truth for "the payload"), a streaming request is signalled by `AdapterRequest.stream === true`, and the adapter then returns the response's `ReadableStream<Uint8Array>` **in `body`**, un-read and un-parsed. The surface that set `stream` narrows `body` to a stream; nothing else changes. This is the minimal widening (no new response field, no type break) and keeps `body` meaning exactly "the response payload."

`onProgress` is **independent of `stream`**, on two axes:

-   **Direction.** `onProgress` reports `{ phase: 'upload' | 'download', loaded, total? }`. Upload progress has nothing to do with how the response body is read; download progress is meaningful whether the body is streamed _or_ buffered.
-   **Buffering.** `download` (Decision 8) sets `onProgress` **without** `stream`: it wants the bytes _buffered_ into a `Blob` but reported as they arrive. `sse`/`stream` set `stream` and may also set `onProgress` for byte counts.

So the two flags are composable, not coupled: `stream` controls _buffering_, `onProgress` controls _reporting_. An adapter that cannot stream (axios) throws on `stream: true` and silently no-ops `onProgress`.

### Q2 — What is the `stream` surface's default decoder?

**Resolved:** _`'bytes'`._

A surface literally named `stream`, reached only by a caller who has opted out of the buffered path, should hand back exactly what is on the wire — `Uint8Array` chunks — losslessly, assuming **no** encoding and **no** framing. `'bytes'` is the only decoder that is _total_ (never throws) and _never wrong_: `'lines'` silently mis-decodes binary as UTF-8, and `'ndjson'` throws on the first non-JSON line. Decoding is a choice the author states explicitly (`decode: 'lines' | 'ndjson'`), mirroring how `responseType` stays content-type-driven rather than forcing a shape. This also draws a clean line against `sse`: `sse` is the _framed_ streaming surface, `stream` is the _raw_ one.

### Q3 — Does `sse` reuse the `stream` surface's decoder?

**Resolved:** _shared byte→line plumbing, but `sse` has its own frame parser; it does **not** reuse `stream`'s `lines`/`ndjson`/`bytes` decoder._

`text/event-stream` is a real protocol, not "lines": an event spans multiple lines, `data:` fields concatenate with `\n`, blank lines delimit events, and `event:`/`id:`/`retry:`/comments have meaning. None of the three `stream` decoders can express that. So `sse` ships a dedicated **event-stream frame parser**.

What the two surfaces _do_ share is the lower-level mechanics that turn a `ReadableStream<Uint8Array>` into UTF-8 lines across chunk boundaries (a single internal `lineReader` helper). `sse`'s frame parser and `stream`'s `'lines'` / `'ndjson'` decoders both sit on top of that one helper. They reuse the **plumbing**, not the **decoder** — which keeps SSE semantics correct without duplicating the byte-handling.

### Q4 — What does the `await` path resolve to for a streaming surface? (Stage 5)

**Resolved:** _the collected array of every `delta` chunk._

A streaming run ends, like every run, `… → result → done`, and `await stitch()` (via `consume()`) returns the terminal `result.value`. For a streaming surface that value is the **ordered collection of everything emitted as a `delta`**: `await` means "give me the whole stream", `.stream()` means "give me it incrementally". The alternatives both lose. Resolving to `undefined` makes streaming the lone surface whose `await` returns no data, forcing `.stream()` even for a bounded stream. Resolving to the **last chunk** silently discards data — catastrophic for `sse`, where every event matters. The array is the only choice that is lossless and consistent with the event spine, and it reads like `Array.fromAsync(stream)`. The trade-off (documented at the call site): `await` buffers the whole stream in memory, so it is for **bounded** streams; an unbounded / long-lived stream is consumed incrementally via `.stream()`, which yields each `delta` as it arrives and buffers nothing. transform / unwrap / `output` validation are buffered-response concepts and are **not** applied to the delta path.

## Consequences

**Positive**

-   New request styles stop touching the engine. A surface is a small unit (`id` + a few hooks) with its own tests and its own subpath; the hot path is `surface.buildRequest` / `surface.interpret`, not a growing `switch (kind)`.
-   `graphql`'s three scattered special-cases collapse into one surface, proving the model against existing behaviour (Stage 4 is a refactor, not a feature).
-   The `delta` event finally has emitters; SSE/stream/streaming-progress are expressible without a second event channel.
-   Bundle-frugal holds: a REST-only app bundles zero streaming/multipart-nesting code; a streaming app pays only for the surface it imports.

**Accepted trade-offs**

-   Real engine work, not a config tweak: the engine gains a surface-dispatch seam, a streaming execution path that emits `delta` and bypasses concurrency (Decision 12), and a widened adapter contract every adapter must satisfy (even if only to reject streaming).
-   **Two adapters with different capabilities** (`fetch` streams + download progress; `xhr` adds upload progress; `axios` buffered-only). Callers pick the adapter whose capabilities match the surface; a mismatch is a clear throw, not a silent degrade.
-   `AdapterResponse.body` now means "stream **or** value" depending on the request flag — a small overload of one field, chosen over a second field (Q1).

**Required follow-ups (tracked as the rollout stages)**

-   Surface dispatch + the `Surface` type + `kind` normalisation/redaction (Stage 3).
-   Streaming execution path: `delta` emission, the rate-only throttle acquire, the `lineReader` helper, the SSE frame parser, the `stream` decoders (Stage 5).
-   `xhrAdapter` + `fetchAdapter` streaming/progress; axios compile-check (Stage 2).
-   `package.json` `exports` per surface/adapter; docs reframe (Stages 7, 10).

## Staged rollout

Each stage is a single reviewable PR against `main`, in order; review stops between stages. A later stage may build on an earlier one but each is green on its own (full suite + typecheck on src **and** test + eslint + prettier; gates re-checked).

0.  **This ADR.** Resolve the three open questions (above); no code.
1.  **Nested multipart** (Decision 6) — `multipart.nesting` in `http-adapter.ts`; `multipart-nesting.spec.ts`.
2.  **Adapter contract extension** (Decision 9) — `stream` + `onProgress` on the contract; `fetchAdapter` streaming + download progress; zero-dep browser-only `xhrAdapter` (upload + download progress); axios still compiles.
3.  **Surface plugin model** (Decisions 1–3, 10, 11) — `Surface<TInput, TResult>`; `kind?: Surface` + redaction to id; generic `stitch<S>` overload + `http` default; per-surface subpath skeleton; seam stays surface-agnostic.
4.  **graphql as a surface** — move the inline `kind: 'graphql'` engine logic behind the `graphql` surface plugin; update `graphql-and-headers.spec.ts`.
5.  **`sse` + `stream`** (Decisions 4, 5, 12) — engine streaming paths emitting `delta`; SSE frame parser + `stream` decoders; streaming exempt from the concurrency bucket, charged on the rate gate. SSE reconnection is **out** (issue #71). `sse.spec.ts`, `stream.spec.ts`.
6.  **`download`** (Decision 8) — GET + blob + byte progress + `Content-Disposition` filename + `AbortSignal`; resolves to `{ blob, filename }`; `download.spec.ts`.
7.  **Packaging & docs** (Decisions 7, 10) — `exports` subpaths; "any surface" reframe; surfaces overview + per-surface guides.

## Gates

-   **Browser-first.** `fetch` + Web Streams everywhere; SSE via `fetch`, never `EventSource`; `xhrAdapter` uses `XMLHttpRequest` (browser-native) and is explicitly browser-only; `download` returns a `Blob`, never touches `fs`.
-   **Bundle-frugal.** Root `import { stitch }` bundles `http` only. Every other surface and the `xhr` adapter are subpath exports / lazily reached, like the cache engine. The generic `stitch<S>` overload is erased at runtime.
-   **Contract-not-dependency.** Surfaces are named by a string id; `__config` carries the id, never the closures (Decision 11). A stitch's declaration round-trips to JSON for MCP/playground/`llms.txt`; an unknown surface id degrades, never crashes.

## Out of scope (considered, deferred)

-   **SSE auto-reconnection / `Last-Event-ID` resume** — real and wanted, but a feature of its own (backoff policy, replay semantics). Tracked as issue #71.
-   **GraphQL `variables` typing** — inferring the call argument from a typed `variables` schema is the existing deferred gql-vars work (#75/#76), orthogonal to making graphql a surface.
-   **Builder removal** — the fluent `stitch.use(...)` Builder is on its own deprecation track (the API-grill round); surfaces neither need nor block it.
-   **Disk-writing downloads / streamed uploads from a file path** — Node-only, breaks browser-first; `download` returns a `Blob` and upload bodies are in-memory `Blob`/`Uint8Array`.
-   **A distributed concurrency semaphore for streams** — concurrency stays in-process (Decision 12 exempts streams from it entirely); the rate gate is already store-backed.

## Alternatives considered

-   **A. Keep the closed `kind` union; add `'sse' | 'stream' | 'download'` members.** Rejected: every style baked into core, more hot-path branches, and `import { stitch }` pays for streaming it never uses — the bundle-frugal gate.
-   **B. Make a surface a full adapter (own transport).** Rejected: surfaces would re-implement retry/throttle/circuit/cache/auth. A surface shapes and interprets; the _adapter_ is the transport; the _engine_ owns cross-cutting concerns. Three roles, kept separate.
-   **C. `EventSource` for SSE.** Rejected: GET-only, no custom headers (no auth), Node-absent — fails all three gates. `fetch` + a frame parser keeps SSE on the shared spine.
-   **D. `stream` defaults to `ndjson` (or `lines`).** Rejected: a `stream` default must be total and lossless; `ndjson` throws on non-JSON, `lines` silently mangles binary. `bytes` is the only never-wrong default (Q2).
-   **E. A second `AdapterResponse.stream` field.** Rejected: `body` is already `unknown` and already _is_ "the payload"; a second field forces every reader to branch and invites the two fields to disagree (Q1).
-   **F. Surfaces carry serialisable behaviour (so the whole plugin round-trips).** Rejected: behaviour is closures; only the _identity_ (id) is a contract. The JSON round-trip carries the id, and the running process supplies the behaviour — the contract-not-dependency gate as written (Decision 11).
