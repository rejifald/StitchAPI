# ADR 0003 — Surfaces: one authoring model across http / graphql / sse / upload

-   **Status:** Proposed (12 decisions firm; the three open implementation questions — adapter-stream shape, `stream` decode default, `sse`/`stream` decoder sharing — resolved into decisions 5 and 9)
-   **Date:** 2026-06-14
-   **Tags:** authoring-surface, surfaces, graphql, sse, file-upload, multipart, bundle
-   **Supersedes parts of:** the ad-hoc `kind` discriminator and the standalone `graphql()`
    helper introduced before this ADR.

## Context

A stitch today is "one HTTP request as data". But "HTTP request" is not one shape — REST,
GraphQL, server-sent events, and file upload each have a different **wire envelope**
(method/body framing), and some a different **response lifecycle** (one value vs. a stream)
or **error model** (a 200 carrying `errors`). The library currently expresses that variety
three inconsistent ways at once:

1.  A user-facing `kind: 'http' | 'graphql'` discriminator on `StitchConfig`, dispatched
    inside the engine ([`engine.ts`](../../packages/core/src/engine.ts) — `cfg.kind ===
'graphql'` at the body envelope, the error-model check, and the paginate path).
2.  A standalone `graphql()` helper and a `seam.graphql()` method that both set that `kind`
    plus `method: 'POST'` and `unwrap: 'data'`.
3.  Raw `stitch({ kind: 'graphql' })`, which compiles **without** a `query` — the same
    concept, a third spelling, with the invariant unenforced.

So GraphQL has three doors with inconsistent guarantees, while two real surfaces have **no**
door at all:

-   **SSE / streaming.** The event spine already exists — `execute` is an async generator,
    `StitchResult.stream()` is public, and a `delta` `StitchEvent` is **defined but never
    emitted** ([`types.ts`](../../packages/core/src/types.ts)). There is no surface that
    parses `text/event-stream` and turns frames into `delta` events. Native `EventSource`
    is GET-only and cannot send headers/body, which is exactly why a fetch-based SSE surface
    is needed (the same gap `@microsoft/fetch-event-source` fills).
-   **Upload.** `bodyType: 'multipart'` exists, but its encoder is broken for any nested
    value: [`http-adapter.ts`](../../packages/core/src/http-adapter.ts) `appendForm` falls
    through to `form.append(key, String(v))`, so a nested object becomes the literal
    `"[object Object]"`. multipart/form-data (RFC 7578) is a deliberately **flat**
    `(name) -> bytes` model; any hierarchy must be encoded into the names or into a part's
    bytes by a convention both client and server agree on. The library gives no such
    convention, so users hand-roll it (e.g. a `json` string field + separate `files`
    parts, reassembled server-side).

A survey of modern clients (axios, ky, ofetch, openapi-fetch; graphql-request, urql, Apollo;
`@microsoft/fetch-event-source`) shows the ecosystem has **settled on keeping protocols
separate**, exposed as **named entrypoints**, never crammed behind one generic
`call({ kind })` switch — because a single discriminator forces a lowest-common-denominator
type signature and loses each protocol's ergonomics (typed `query`/`variables`, the GraphQL
error array, SSE reconnection). The middle path the strongest libraries use is **one shared
core (base URL, auth, retry, interceptors) + thin per-surface adapters**. That core already
exists in this library: it is the **seam** (ADR 0002).

This ADR records the model we converged on. There are **no production users**, so the
user-facing `kind` discriminator and the standalone `graphql()` spelling are replaced
outright, with no deprecation window. Every decision is checked against the project's three
gates: **browser-first**, **bundle-frugal**, **contract-not-dependency** (capabilities
round-trip as JSON).

## Decision

1.  **A "surface" is an imported plugin value passed as `kind`; the authoring verb stays
    `stitch` (+ `seam.stitch`).** A surface (`graphql`, `sse`, `stream`, `upload`, `download`)
    is a typed object imported from its own module and handed to the engine as `kind` — it
    carries the protocol's envelope / decoder / error-model the way `auth` and `adapter` carry
    behavior. There is **one** authoring model, not N constructor functions:

    -   `stitch({ kind: graphql, query })` — the underlying generic form (any surface, dynamic
        kinds, binding onto a seam).
    -   `graphql.stitch({ query })` — sugar every surface object exposes, with `kind`
        pre-bound. The **recommended** form: **one import**, and being _monomorphic_ it gives
        **better types and errors** than the generic `stitch({ kind })` (whose inference is
        generic over the surface).
    -   `graphql.seam({ baseUrl })` — a surface-flavoured seam (members default to that kind).

    So `graphql.stitch(cfg)` ≡ `stitch({ kind: graphql, ...cfg })`: one concept, a recommended
    sugar over a generic base — **not** three independently-maintained spellings. `kind` absent
    = http (the core base). Surfaces share one authoring _model_ but **not** one return _type_:
    each resolves `await` to what fits (`graphql` -> `T`, `download` -> `{ blob, filename }`,
    `stream` -> the collected chunks).

    **Mixed seams.** A seam is surface-agnostic; members pick their kind, all inheriting the
    shared runtime — auth, **one** rate budget, the principal boundary:

    ```ts
    const partner = seam({ baseUrl, auth, throttle: '20/s' });
    partner.stitch({ path: '/users' }); //                       http
    partner.stitch({ kind: graphql, path: '/graphql', query }); // graphql
    partner.as(userId).stitch({ kind: sse, path: '/events' }); //  sse + principal
    ```

    For a seam with many same-surface members, `graphql.seam(existingSeam)` returns a
    surface-flavoured **view sharing that seam's runtime** — the surface-first dual of
    `.as(principal)`: `const gql = graphql.seam(partner); gql.stitch({ path, query })`. Both
    `gql.stitch` and `partner.stitch({ kind })` draw on the same auth + rate budget + principal;
    that cross-surface sharing is the seam's whole point and the strongest case for the model.

2.  **`kind` is freed of its old string values and repurposed as the typed surface slot.** The
    `kind: 'http' | 'graphql'` magic-string union is removed; `kind?: Surface<TInput, TResult>`
    now takes an imported surface value (or is absent, meaning http). This is the opposite of a
    regression: what we kill is the **unguarded string** (`stitch({ kind: 'graphql' })` compiled
    with no `query`); what we add is a **typed plugin** that enforces the surface's input
    (graphql requires `query`) and infers its result. `kind` stays Omitted from `SeamConfig`
    (it is per-member, not a shared default — ADR 0002 follow-up).

3.  **Surfaces still reduce to declarative config — a surface value is a live handle like
    `auth` / `adapter`, normalised to its `id` string in `__config`.** The contract gate asks
    that _capabilities_ round-trip as JSON; `StitchConfig` already carries live,
    non-serialisable handles (`auth`, `adapter`, `store`) that ADR 0002 **redacts** from the
    public `__config`. A surface plugin is the same category: `kind: graphql` is a live behavior,
    and `__config.kind` shows the normalised string `'graphql'` (the surface's `id`). The
    declarative remainder each surface contributes is plain data:

    -   `graphql` -> `{ method: 'POST', unwrap: 'data' }` (+ the graphql error model)
    -   `stream` -> `{ responseType: 'stream', decode }` (default `decode: 'bytes'`);
        `sse` -> `{ responseType: 'sse' }` (the event-stream framing is the surface's)
    -   `upload` -> `{ method: 'POST', bodyType: 'multipart', multipart: { nesting } }`
    -   `download` -> `{ method: 'GET', responseType: 'blob', progress: true }`

    **A surface whose behavior cannot be carried this way — a live handle plus declarative
    config, inspectable as an `id` — is out of scope.** That is the test a candidate surface
    must pass.

4.  **Lifecycle vs. sugar is now an _internal_ distinction, not an authoring one.** Every
    surface is authored identically (a `kind` plugin); they differ only in what they cost the
    engine:

    -   **Lifecycle surfaces** (`graphql`, `sse`, `stream`) own a genuinely different
        request/response shape — graphql's envelope + 200-with-`errors` error model; sse/stream's
        N-chunk cardinality — so each adds a real engine path.
    -   **Sugar surfaces** (`upload`, `download`) share the plain HTTP lifecycle and only
        **preset config** (multipart + nesting; GET + blob + progress). Their capabilities live
        in config and work on a plain `stitch` too; the surface value exists for discoverability
        and clean types.

    This keeps us from minting a lifecycle path for every content-type, and marks the line
    (decision 11): a surface is one request whose (possibly streamed) response reduces to config.
    WebSocket (bidirectional, stateful) is beyond it — future exploration, not core.

5.  **`sse` and `stream` ride the existing event spine; both emit `delta`.** A streaming
    surface fetches a long/unbounded body, decodes it into chunks, and emits each as the
    dormant `delta` `StitchEvent` (these are `delta`'s first producers). The awaited path
    collects chunks into the final value; `.stream()` yields them live. Parsing is a
    hand-written reader over the adapter's byte-chunk stream (decision 9; browser-first, no
    `EventSource`, no dependency). Method may be GET **or** POST with headers/body — the
    capability native `EventSource` lacks. The two are kept **separate** because they answer
    different questions:

    -   **`sse`** commits to the **SSE protocol** — `text/event-stream`, the `data:` /
        `event:` / `id:` / `retry:` line framing, `\n\n` records, UTF-8, and server-driven
        reconnect. It is `stream` with the event-stream decoder _plus_ the protocol's
        reconnect/identity semantics, which earn a named surface. (Reconnection /
        `Last-Event-ID` resume is deferred — [#71](https://github.com/rejifald/StitchAPI/issues/71).)
    -   **`stream`** is the generic case: a configurable `decode` that **defaults to
        `'bytes'`** — `'bytes'` (raw `Uint8Array` chunks, the assumption-free default),
        `'lines'` (raw text lines), `'ndjson'` (newline-delimited JSON, one record per line),
        or a custom decoder. Use cases that are **not** SSE: NDJSON change-feeds and bulk
        exports (CouchDB `_changes`, Elasticsearch scroll), log / line tailing
        (`?follow=true`), non-SSE token streams (e.g. Ollama emits NDJSON, not
        `text/event-stream`), and incremental parsing of a large body without buffering it
        whole. `sse` would mis-frame all of these.

    **Default `decode: 'bytes'` (resolved).** `'bytes'` is the only assumption-free default,
    and `stream` is the _generic_ surface, so its default must not presume a wire format: raw
    chunks are lossless and reinterpretable downstream, whereas a structural default that
    mis-frames either corrupts data or — for `'ndjson'` — **throws** on the first non-JSON
    line. Defaulting to `'bytes'` is thus equivalent to "no framing chosen yet" without forcing
    ceremony on every `stream` call (requiring an explicit `decode` buys no safety that
    `'bytes'` does not already give); structure is opt-in exactly where the caller can assert
    the framing. `sse`, by contrast, _is_ a committed protocol, so it carries **no** `decode`
    knob.

    **`sse` reuses the shared _substrate_, not the `stream` _surface_ (resolved, impl-only).**
    The genuinely common, bug-prone work — draining the adapter's `AsyncIterable<Uint8Array>`
    and an incremental UTF-8 line decoder that buffers across chunk boundaries (multibyte
    chars, split lines) — is factored into one un-exported core module (`internal/byte-lines`)
    that **both** surfaces import. `stream`'s `'lines'` / `'ndjson'` decoders are that line
    layer (+ `JSON.parse`); `sse` layers its own `text/event-stream` frame parser
    (`data:` / `event:` / `id:` / `retry:` fields, `\n\n` records, reconnect identity) on the
    same line layer. So `sse` reuses the shared substrate, **not** the `stream` surface module
    — which the bundle-frugal gate (decision 10) requires: importing `sse` must not drag in
    `stream`'s `ndjson` / `bytes` decoders or its surface object. DRY the hard shared
    primitive; keep the protocol-specific parsers decoupled.

6.  **Nested multipart is a declarative `nesting` strategy; default `bracket`, opt-in
    `json`.** `appendForm` gains a `multipart.nesting` config:

    -   `'bracket'` **(default)** — flatten the object tree into bracketed leaf names
        (`author[name]`, `tags[0]`, `items[0][id]`); file leaves become parts under the same
        bracketed name. Server-standard: Express+`qs`, Rails, Laravel, FastAPI parse it
        natively.
    -   `'dot'` — the same, dotted (`author.name`).
    -   `'json'` — all **non-file** fields collapse into one JSON-string part (field name
        `multipart.jsonField`, default `'json'`); each file is **stripped** out of that JSON
        and appended as its own part keyed by its path — **no** placeholder or reference is
        left in the blob (the server re-stitches files to structure by part name / filename).
        This is the user's existing wire format — "a `json` field + file parts, reassembled
        server-side" — now first-class, **zero backend change**.
    -   `'none'` — today's flat behaviour (back-compat / escape hatch).

    File leaves are detected as today (`Blob` / `Uint8Array` / `{ value, filename?, type? }`)
    in every mode. The flattener is ~30 lines, no `qs` / `object-to-formdata` dependency
    (bundle-frugal), over the web-standard `FormData` (browser-first), and the whole strategy
    is config (contract gate).

7.  **Reframe the promise from "any coding _style_" to "any _surface_".** The docs line that
    the library "fits any style" today implies multiple **authoring syntaxes** for the same
    request — which this ADR (with the Builder removal, ADR 0003's sibling change) explicitly
    rejects in favour of **one** config-object authoring model. The defensible, true version
    of the promise is **one authoring model across many protocols**: REST, GraphQL, SSE,
    uploads. The "any X" claim moves from syntax variety (a liability) to surface coverage
    (the feature).

8.  **`download` resolves to `{ blob, filename }` (+ progress) and never _saves_; the download
    manager is future exploration, not core.** `download` is the response-side counterpart to
    `upload` — a sugar surface (`GET` + `responseType: 'blob'`) that emits byte-progress
    (`transferred` / `total` from `Content-Length`, via `onProgress` — decision 9), honours a
    caller `AbortSignal` for
    cancel, and reads the `Content-Disposition` filename. Its `await` result is its **own
    type** — `{ blob, filename }` — not the universal `T` (decision 1: surfaces share an
    authoring model, not a return type); progress comes via `.stream()`. It does **not** save —
    saving is a DOM concern in the browser (anchor + `objectURL`) and a filesystem concern in
    Node, so it stays user-land, keeping core **DOM-free** and browser/Node-symmetric. It is
    still valuable on the frontend (inline, progress-aware downloads instead of a naked `href`
    the browser may open inline and whose filename is unreadable cross-origin). A higher-level
    **download manager** — a queue with concurrency, auto-retry/backoff, and per-item status
    (`queued` / `downloading` / `retrying` / `completed` / `failed` / `cancelled`) — is **not in
    this ADR's scope**, but is explicitly kept for **later exploration** (see decision 11),
    because its hard parts already exist or compose cheaply:

    -   **Concurrency / batching** is the **seam's shared throttle bucket** (ADR 0002 §3):
        `download.seam({ throttle: { concurrency: 3 } })` pools download capacity (sequential /
        batched / parallel) — no new queue primitive. (Downloads are finite requests, so they
        **do** hold concurrency slots — unlike streams, decision 12.)
    -   **Retry/backoff** is the existing `retry` policy; **cancel** is the `AbortSignal`
        plumbing; **progress** is the `progress` / `delta` event spine.

    What remains is thin **status aggregation** for a UI — the React `useDownloadManager` shape
    in `~/Development/strimko`. For **now** that layer stays out: `@tanstack/react-query`
    already solves request status/queue on the frontend, so core ships the `download` surface
    plus the primitives a manager composes from, and stops there — no `@stitchapi/react`
    companion is being built today.

9.  **Extend the `Adapter` contract so every adapter has equal capabilities — streaming and
    progress, never a built-in-only fast path.** The single `(req) => Promise<AdapterResponse>`
    shape grows two optional channels rather than being bypassed for streaming surfaces:

    -   a **streaming response body** as a plain **`AsyncIterable<Uint8Array>`** on a new
        `AdapterResponse.stream?` field (the unary `body` is left undefined for streams). An
        async-iterable — **not** a web `ReadableStream` — is chosen because it is the smallest
        contract _and_ the cheapest for BYO/custom adapters to satisfy: a Node response stream
        already **is** an `AsyncIterable<Uint8Array>` (axios-in-Node returns one directly), a
        custom/mock adapter is one `async function*`, and only the built-in `fetchAdapter` pays
        an adaptation cost — a ~6-line `response.body.getReader()` bridge (browser-safe;
        async-_iterating_ a `ReadableStream` is not yet universal in browsers, so the engine
        drains the iterable with `for await`). Byte-level `Uint8Array` chunks keep the adapter
        protocol-agnostic: decoding into `delta`s (lines / ndjson / sse-frames) is the engine's
        job (decision 5), so no adapter needs to understand a surface.
    -   an **`onProgress`** hook on `AdapterRequest` — `(e: TransferProgress) => void` — for
        upload/download byte counts.

    The exact contract delta (the `Adapter` _function_ shape is unchanged — still one call):

    ```ts
    interface AdapterResponse {
        status: number;
        headers: Record<string, string>;
        body: unknown; // parsed unary value; undefined when `stream` is set
        stream?: AsyncIterable<Uint8Array>; // streaming surfaces only
    }

    interface AdapterRequest {
        // …existing fields…
        onProgress?: (e: TransferProgress) => void;
    }

    interface TransferProgress {
        direction: 'up' | 'down';
        transferred: number; // cumulative bytes in this direction
        total?: number; // Content-Length / known request size, if any
    }

    type Adapter = (req: AdapterRequest) => Promise<AdapterResponse>;
    ```

    **`onProgress` and the streamed body never double-count, because exactly one party pulls a
    given byte off the socket and `responseType` fixes which.** Request-body (`'up'`) bytes are
    only ever visible to the adapter, so `onProgress({ direction: 'up' })` is their sole channel
    and the engine is structurally uninvolved. For the response body the two cases are mutually
    exclusive: a **streaming** surface (`responseType: 'sse' | 'stream'`) hands the engine the
    _undrained_ `res.stream`, the **engine** pulls each chunk and that chunk _is_ the progress (a
    `delta` event), so the adapter must **not** also fire `'down'` `onProgress` for those bytes;
    a **unary** surface (incl. `download`, `responseType: 'blob'`) is the inverse — the
    **adapter** reads the body to completion as the sole `'down'` reporter and sets no
    `res.stream`, so the engine never re-counts. Response bytes therefore have exactly one
    counter — engine-as-`delta` for streams, adapter-as-`onProgress` for unary.

    Because these live in the contract, a **BYO adapter** (axios or custom) can implement SSE,
    streaming, and progress too — not a privilege of the built-ins. Concretely: `fetchAdapter`
    streams responses natively (and reports download progress by reading the body) but
    **cannot** report _request_ upload progress portably (a streaming request body needs
    `duplex: 'half'` + HTTP/2, Chromium-only). `XMLHttpRequest` exposes `upload.onprogress`, so
    a first-party zero-dep **`xhrAdapter`** (XHR, **browser-only**) is the portable way to get
    upload + symmetric download progress. In Node, upload progress is unavailable — an accepted,
    browser-only capability gap. The existing `axiosAdapter` stays BYO; **no axios dependency is
    ever added**.

10. **Each surface (and each non-default adapter) is a separate entry point; the core stays
    small.** The package exposes subpath exports — `stitchapi` (core: `stitch`, `seam`,
    `fetchAdapter`), `stitchapi/graphql`, `stitchapi/sse`, `stitchapi/stream`,
    `stitchapi/upload`, `stitchapi/download`, `stitchapi/xhr-adapter` — each its own module. Each
    surface module exports a surface object carrying its `id` + behavior **and** the `.stitch()`
    / `.seam()` sugar (decision 1); importing `graphql` pulls graphql + core, never `upload`'s
    multipart code or `sse`'s parser. This is what reconciles a **growing surface set** with the
    **bundle-frugal gate**: surfaces are pay-for-what-you-import, and the core a user always pays
    for stays just `stitch` + `seam` + the engine. It is also _why_ the **seam stays
    surface-agnostic** (no `seam.graphql()` method): a per-surface method on the seam object
    would drag every surface into the core bundle for everyone.

11. **The surface line is "one request whose (possibly streamed) response reduces to config" —
    held for now, with WebSocket and a download manager kept as _future exploration_, not
    rejected.** A candidate surface is in scope when it is a single request whose response (even
    a stream of deltas) reduces to declarative config (decision 3). That line keeps `graphql` /
    `sse` / `stream` / `upload` / `download` in, and keeps two things out **for now**:
    **WebSocket** (bidirectional, long-lived, stateful — not one request → response) and a
    **download manager** (UI / queue state, not a request). But the project's intent is that
    _all common communication is handled by one library_, so both are explicitly on the
    **later-exploration** list — a `ws` connection wrapper and a download-manager primitive —
    revisited once the surfaces here land. The line is the _current_ boundary, not a permanent
    doctrine.

12. **Streaming members are exempt from the seam's _concurrency_ budget (but not its rate
    budget).** A seam's `throttle.concurrency` is throughput fairness — it assumes a request
    starts and finishes. A long-lived `sse` / `stream` member would hold a slot for its entire
    lifetime, so on a mixed seam three open streams could park a 4-slot bucket and starve every
    REST call. Therefore streaming surfaces acquire the **rate** gate on connect (an open is
    still one request against `N/s`) but do **not** hold a **concurrency** slot — a parked stream
    is not consuming throughput. This refines ADR 0002 §3's shared-bucket model for the streaming
    case; finite members (http / graphql / upload / download) are unchanged and still hold slots.

## Consequences

**Positive**

-   GraphQL collapses from three inconsistent spellings to **one** surface with the invariant
    (`query` required) enforced; the unguarded `kind` door is gone.
-   Streaming and binary surfaces gain first-class, **discoverable** entrypoints: `sse` and
    `stream` (finally emitting the dormant `delta` event), `upload` (fixing the
    `"[object Object]"` bug and making "nested data + files" the happy path), and `download`
    (progress-aware, cancellable, filename-aware).
-   Cross-cutting concerns (auth, retry, throttle, trace, the principal boundary) are shared
    **once** at the seam and inherited by every surface — the seam-as-core payoff.
-   Every surface stays declarative, so traces/mocks/inspection keep working uniformly across
    protocols.

**Accepted trade-offs**

-   The surface set grows (`sse`, `stream`, `upload`, `download` + an `xhrAdapter`), but each is
    a **separate import** (decision 10), so the core a user always pays for stays `stitch` +
    `seam` + engine — the bundle cost is opt-in per surface. The engine still gains `sse` /
    `stream` paths and `kind: 'sse' | 'stream'` branches, and the `Adapter` contract gains a
    streaming body + progress hook (decision 9) that every BYO adapter must tolerate.
-   `kind` changes from a magic-string union to a typed surface plugin, and GraphQL moves from
    the old `graphql(cfg)` shape to `graphql.stitch(cfg)` / `stitch({ kind: graphql })` —
    breaking, with **no migration path** (pre-1.0, no users).
-   The generic `stitch({ kind })` form has weaker inference / error messages than the
    monomorphic `surface.stitch()`; the sugar is the recommended front door for that reason
    (decision 1), with the generic form reserved for binding onto seams and dynamic kinds.
-   Upload progress is **browser-only** (via `xhrAdapter`); Node uploads report no progress —
    an accepted capability gap (decision 9).
-   Per-surface imports (decision 10) genuinely **advance** bundle-frugality — a surface you
    don't import isn't bundled — but only if backed by real ESM module boundaries +
    `exports` subpaths, not named exports off one barrel. The shared engine still ships once;
    `kind`-branch code for unused surfaces should be code-split or kept behind the surface
    module, not the core.

**Required follow-ups**

-   Engine: `kind: 'sse'` / `kind: 'stream'` branches that drain `res.stream` and emit `delta`,
    over a shared internal byte-pump + incremental line decoder (`internal/byte-lines`) that
    both surfaces import; `stream`'s configurable decoder (`'bytes'` **default** / `'lines'` /
    `'ndjson'` / custom) and `sse`'s own `text/event-stream` frame parser layer on it;
    `responseType: 'sse' | 'stream'` values in
    [`http-adapter.ts`](../../packages/core/src/http-adapter.ts); byte-progress via `onProgress`
    (`transferred` / `total`) for `download`.
-   Adapter contract: add `AdapterResponse.stream?: AsyncIterable<Uint8Array>` and
    `AdapterRequest.onProgress?: (e: TransferProgress) => void` (where
    `TransferProgress = { direction: 'up' | 'down'; transferred: number; total?: number }`);
    implement both in `fetchAdapter` (wrap `response.body.getReader()`; download progress by
    reading the body) and the new **`xhrAdapter`** (upload + download progress, browser-only);
    confirm `axiosAdapter` still satisfies the widened contract — its Node response stream is
    already an `AsyncIterable<Uint8Array>`.
-   Types: a `Surface<TInput, TResult>` plugin type; `kind?: Surface` on `StitchConfig`; the
    generic `stitch<S>({ kind: S } & InputOf<S>): Stitch<ResultOf<S>>` overload + the http
    default; the monomorphic `surface.stitch` / `surface.seam` / `surface.seam(existingSeam)`
    signatures.
-   Packaging: `exports` subpaths (`stitchapi/graphql`, `/sse`, `/stream`, `/upload`,
    `/download`, `/xhr-adapter`), each a separate build entry exporting a surface object that
    carries its `id` + behavior and the `.stitch()` / `.seam()` sugar (decision 1).
-   Throttle: exempt streaming members from the concurrency bucket while still charging the rate
    gate (decision 12) — a refinement to the seam-bucket / `createStoreThrottle` path.
-   `appendForm`: implement `nesting` (`bracket` / `dot` / `json` / `none`) + recursive
    flattener with file-leaf detection; in `json` mode, strip files from the blob (decision 6).
-   Surface objects: each surface's `id`, behavior hooks (envelope / decode / error-model), and
    the `.stitch()` / `.seam()` sugar; keep `SeamConfig`'s Omit of `kind` aligned.
-   Tests: `sse.spec.ts`, `stream.spec.ts` (lines/ndjson/bytes decoders),
    `multipart-nesting.spec.ts` (bracket/dot/json round-trips, files + nesting),
    `download.spec.ts` (blob, progress, abort, filename), and an `xhr-adapter.spec.ts`
    (upload + download progress).
-   Docs: `sse` / `stream` / `upload` / `download` guides; rewrite the "fits any style" line
    (decision 7); a surfaces overview; remove the `graphql()`-as-config framing.
-   Gates re-check per surface: stream parsers browser-first (no `EventSource`); multipart over
    web `FormData`; download over `fetch` streaming; `xhrAdapter` adds no dependency.

## Alternatives considered

-   **A. Keep one entrypoint with a magic-_string_ `kind: 'graphql' | 'sse'` switch.** Rejected
    as a string: unguarded (no required `query`), not tree-shakable, stringly-typed. But the
    _shape_ — one authoring verb + a `kind` discriminator — is **adopted** in its typed-plugin
    form (`kind: graphql`, an imported value that enforces the surface's input + infers its
    result), with the monomorphic `surface.stitch()` sugar restoring per-surface types and
    errors. Decisions 1–3.
-   **G. Dedicated constructor functions taking a seam (`graphql(api, cfg)`).** Rejected in
    favour of the `kind`-plugin + `surface.stitch()` model: positional `graphql(api, cfg)`
    needed an overload (first arg a seam? config?), gave no clean place for `api.stitch({ kind })`
    on a mixed seam, and split the authoring verb per surface. `kind: Surface` keeps one verb,
    and `surface.seam(existingSeam)` covers the many-same-surface mixed-seam case.
-   **B. Make `upload` a full lifecycle surface (its own engine path).** Rejected: upload has
    the **same** request/response lifecycle as plain HTTP — only the body encoding differs.
    Modelling it as sugar over `multipart` config (decision 4) keeps the capability in data
    and avoids a redundant path. The `upload()` helper survives only for discoverability.
-   **C. Add a `qs` / `object-to-formdata` dependency for nested multipart.** Rejected:
    breaks bundle-frugality for ~30 lines of flattening, and pulls encoding semantics out of
    declarative config. A built-in `nesting` strategy keeps it BYO-free and as data.
-   **D. Use native `EventSource` for SSE.** Rejected: GET-only, cannot send
    headers/body/auth — useless for an authenticated POST stream. A `fetch` + manual frame
    parser is browser-first and carries the seam's auth.
-   **E. Ship WebSocket now as a surface.** Deferred, not rejected: a different lifecycle
    (bidirectional, long-lived, its own backpressure + reconnect model) that does not reduce
    cleanly to request config — beyond the current line (decision 11). Kept on the
    later-exploration list as a `ws` wrapper, since the project wants one library for all
    common comms.
-   **F. Bypass the adapter for streaming surfaces (built-in `fetch` only).** Rejected: it
    would make SSE / `stream` / upload-progress a privilege of the built-in adapters and leave
    BYO adapters (axios, custom) unable to stream — a silent capability cliff. Extending the
    `Adapter` contract instead (decision 9) keeps every adapter at parity.

## Open questions (resolved)

_Resolved: surfaces are **imported `kind` plugins** authored via `stitch({ kind })` +
`surface.stitch()` / `surface.seam()` sugar, the seam stays surface-agnostic (1, 2, 10);
mixed seams bind via `kind` per member or `surface.seam(existingSeam)` (1); `kind` freed of its
string union, typed + user-facing, not `@internal` (2); surfaces are live handles normalised to
an `id` in `__config` (3); `json`-mode strips files (6); SSE reconnection deferred to
[#71](https://github.com/rejifald/StitchAPI/issues/71) (5); `stream` added, distinct from `sse`
(1, 5); `download` -> `{ blob, filename }`, never saves (8); download manager + WebSocket are
future exploration beyond the line (8, 11); the `Adapter` contract is **extended** (streaming
body + `onProgress`), never bypassed (9, F); streaming members skip the concurrency budget (12);
per-surface return types are fine (1, 8). The three open **implementation** questions are now
resolved and folded into the decisions above:_

-   **The streaming `body` shape on `AdapterResponse`** → a plain **`AsyncIterable<Uint8Array>`**
    on a new `AdapterResponse.stream?` field, **not** a web `ReadableStream`: the smallest
    contract and the cheapest for BYO/custom adapters (a Node stream already is one; only
    `fetchAdapter` pays a `getReader()` bridge). `onProgress` and the stream never double-count
    — the sole counter of a byte is whoever pulls it off the socket, fixed by `responseType`
    (engine-as-`delta` for streams, adapter-as-`onProgress` for unary; request bytes are always
    adapter-only). Folded into **decision 9**, with the exact signatures.
-   **`stream` default `decode`** → **`'bytes'`**, the only assumption-free default for a
    _generic_ surface: lossless raw chunks never mis-frame, where `'ndjson'` would **throw** on
    the first non-JSON line and requiring an explicit `decode` buys no extra safety. Structure
    (`'lines'` / `'ndjson'` / custom) is opt-in. Folded into **decision 5**.
-   **Does `sse` reuse `stream`'s decoder internally?** → it reuses the shared **substrate** (an
    internal byte-pump + incremental line decoder both surfaces import), **not** the `stream`
    _surface module_ (which the bundle gate forbids — decision 10); `sse` carries its own
    `text/event-stream` frame parser on top. DRY the hard primitive, decouple the protocol
    parsers. Folded into **decision 5**.
