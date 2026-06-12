# StitchAPI — Feature Lenses

> A companion to [`OVERVIEW.md`](OVERVIEW.md) (the why) and [`DESIGN.md`](DESIGN.md) (the how).
> This doc is the **map of what we've built** — every feature grouped under a _lens_, lenses
> grouped into four _families_, all laddering into one north star. Working draft · 2026-06.

---

## How to read this

A **lens** is a viewpoint, not a bucket. The same feature shows up under several lenses on
purpose — `throttle` is both reliability and scale; `cookieSession` is both security and
state; the event stream is observability _and_ developer experience _and_ agent-native. Don't
try to file each feature in exactly one place; that fights the design.

The lenses cluster into four **families** — _Runtime_ (how a call behaves in production),
_Authoring_ (the DX of declaring a stitch), _Data_ (the shape, correctness, and drift of the
payload), and _Reach_ (where it runs and what it plugs into) — above which sits the one
**north-star** lens everything serves: **agent-nativeness**.

---

## Family A — Runtime (how a call behaves in production)

### Reliability

-   Retry with backoff — `attempts`, retry-on status codes (default `429/502/503/504`),
    `expo` / `expo-jitter` / `fixed` strategies, `baseMs` / `maxMs` clamp — [`src/resilience.ts`](../src/resilience.ts)
-   `Retry-After` respected (delta-seconds **or** HTTP-date) via `respectRetryAfter`
-   Timeouts — `total` and `perAttempt`, enforced with a real `AbortSignal`
-   Lifecycle hooks — `onRequest` / `onResponse` / `onError` / `onRetry`, chained across layers
-   Auth auto-refresh on the wall — a `401` (or soft wall) re-runs the attempt with fresh
    credentials, uncounted — [`src/engine.ts`](../src/engine.ts)
-   Failure semantics — a GraphQL `200` carrying `errors` and an `error`-level drift finding both
    fail the call instead of silently passing

### Observability

-   The streaming event spine — `start → progress → drift → delta → result → done` / `error` —
    a typed async-iterable, not `Promise<bytes>` — [`src/types.ts`](../src/types.ts)
-   Progress phases — `auth` / `request` / `throttled` / `retry` / `paginate`
-   Zero-infra trace sink — console (`STITCH_TRACE_CONSOLE=1`) or JSONL file
    (`STITCH_TRACE_FILE`), pluggable via the `TraceSink` interface — [`src/trace.ts`](../src/trace.ts)
-   Timing baked into events — `waitedMs`, `attempts`, total `ms`, per-event `at`

### Security

-   Auth strategies — `bearer`, `apiKey`, `basic`, `cookieSession` (OAuth2 `client_credentials`
    in progress) — [`src/auth.ts`](../src/auth.ts)
-   Secret resolvers — `env()` and `keychain()`, resolved at **call time**
-   The caller gets a capability, not a credential — the stitch holds the secret; an agent
    invoking it never sees the token
-   Session handling — cookie capture + replay, TTL, refresh on `refreshOn` / `refreshWhen`,
    sessions shareable across stitches via a `key` + shared store

### Performance & scale

-   Proactive throttle — `rate` (e.g. `"2/s"`) spacing **+** `concurrency` cap (FIFO),
    scoped per-stitch or per-`host` — [`src/resilience.ts`](../src/resilience.ts)
-   Streaming delivers early instead of blocking for the whole body
-   Pluggable state store (`get` / `set` / `incr` + TTL) turns throttle **distributed** and
    sessions **persistent / shared across workers** — [`src/store.ts`](../src/store.ts)
-   Zero runtime dependencies, tree-shakeable

> **On "performance":** as a standalone lens it's thin — most of what looks like performance
> here is really politeness (throttle → reliability) or horizontal scale (shared store →
> scalability). We fold it into **scale** rather than overselling a perf story.

---

## Family B — Authoring (the DX of declaring a stitch)

### Developer experience

-   `stitch(url | config)` → a typed, callable function — the core "declare an endpoint, get a
    function" move — [`src/stitch.ts`](../src/stitch.ts)
-   One handle, two modes — `await theStitch()` **or** `theStitch().stream()`
-   Fluent builder — `.get/.post/.put/.delete/.returns/.unwrap/.auth/.retry/.throttle/.timeout`
-   URL templates (full RFC 6570 — operators, explode `*`, prefix `:n`) and a `qs`-style query builder for nested objects/arrays, plus predefined query baked into the path
-   `.with(partial)` partial application — reuses the same runtime so cookies/throttle persist

### Composability & reuse

-   `extends` — recursive layering of fragments (string · object · another stitch), deep-merged
-   `preset()` — a named bundle of reusable defaults
-   `defineStitch(...fragments)` — bind a base, get a stitch factory
-   `stitch.use(...)` — the same composition through the fluent builder
-   Hook chaining — `onRequest` runs base→child, the rest unwind child→base

---

## Family C — Data (shape, correctness, and drift of the payload)

> This family exists because of a deliberate call: response shaping is **advanced data
> management**, not a footnote under DX. Grouping shaping, validation, and drift together makes
> the data story first-class.

### Data management

-   `unwrap` — pull the part you want by dot-path
-   `transform` — reshape before unwrap/validate (e.g. scrape HTML → structured)
-   Pagination — auto-loop pages and aggregate items (`next` / `items` / `max`), each page a
    full request so auth/retry/throttle still apply — [`src/engine.ts`](../src/engine.ts)
-   Request encodings — `json` / `form` / `multipart`; GraphQL variables

### Type safety & validation

-   On-the-fly validation of `params` / `query` / `body` / `headers` **and** the response
-   Standard Schema support — bring any compliant validator — [`src/validator.ts`](../src/validator.ts),
    [`src/standard-schema.ts`](../src/standard-schema.ts)
-   Inferred TypeScript types from the schemas; `ValidationError` fails fast, before the request

### Contract & drift

-   `drift()` — leveled findings (`error` / `warn` / `info`) instead of pass/fail — [`src/drift.ts`](../src/drift.ts)
-   Snapshot baselines — `<name>.contract.json`, written on first run, compared after
-   `critical` / `watch` path globs, `onNew` level for brand-new fields
-   Change classification — `missing` / `type-changed` / `nullable` / `new` / `invalid`

---

## Family D — Reach (where it runs, what it plugs into)

### Portability

-   Browser **and** Node
-   Validator-agnostic, store-agnostic, adapter-agnostic
-   Zero runtime dependencies

### Extensibility

-   Every seam is swappable — `Adapter`, `StitchStore`, `TraceSink`, `AuthStrategy`, `Hooks`,
    `transform` — [`src/http-adapter.ts`](../src/http-adapter.ts)
-   Pluggable HTTP transport — `fetchAdapter` (default) or the shipped `axiosAdapter(client)`
    that wraps your own axios instance; any `Adapter` function works (got, a fake, your own)
-   The adapter doubles as a test seam (inject a fake transport)

### Protocol coverage

-   `http` today; `graphql()` preset (POST `{ query, variables }`, unwrap `data`, `errors` → failure)
-   Shell and LLM kinds on the roadmap — one primitive across protocols (see [`OVERVIEW.md`](OVERVIEW.md))

---

## ★ North star — Agent-nativeness

Not a peer category; the thesis every other lens ladders into. An agent invoking a stitch gets:

-   A **capability, not a credential** (← Security)
-   **Machine-readable progress** as typed events, not opaque bytes (← Observability)
-   **Drift surfaced as data** it can react to (← Contract & drift)
-   **Validation as guardrails** with fail-fast errors (← Type safety)
-   **One uniform primitive** across HTTP/GraphQL/shell/LLM (← Protocol coverage)
-   **Declarative, deterministic** configuration it can author and reason about (← Authoring)

When deciding whether a new feature belongs, the test isn't "which bucket" — it's "which lens
does it strengthen, and does it ladder into the north star."
