// @generated — do not edit by hand.
// Regenerate: pnpm --filter @stitchapi/docs run gen:completions
import type { Completion } from '@codemirror/autocomplete';

/** Config-key completions inside primitive({…}) call arguments. */
export const PLAYGROUND_COMPLETIONS: Record<string, Completion[]> = {
    "stitch": [
        {
            label: "name",
            type: "property",
            detail: "string",
            info: "Label used in events and traces; defaults to `path` or `'stitch'`.",
        },
        {
            label: "kind",
            type: "property",
            detail: "Surface",
            info: "Request style — a  plugin (ADR 0005 Decisions 1-2). Omitted = the built-in `http` surface. The public `__config` exposes only the surface's `id` string (so a stitch's declaration round-trips as JSON — Decision 11); the live object stays on `__rawConfig`.",
        },
        {
            label: "method",
            type: "property",
            detail: "string",
            info: "HTTP method; defaults to `GET`.",
        },
        {
            label: "bodyType",
            type: "property",
            detail: "'json' | 'form' | 'multipart'",
            info: "Request body encoding. Default `'json'`.",
        },
        {
            label: "multipart",
            type: "property",
            detail: "MultipartOptions",
            info: "Multipart serialisation options (ADR 0005 Decision 6) — how nested objects/arrays become field names. Only meaningful with `bodyType: 'multipart'`. Default nesting `'bracket'`.",
        },
        {
            label: "stream",
            type: "property",
            detail: "StreamOptions",
            info: "Streaming options (ADR 0005 Decision 5) — how a `stream` surface decodes the live body (`'bytes'` default / `'lines'` / `'ndjson'` / `'json'`). `'json'` is the structural, unframed streaming-JSON decoder (issue #111): one `delta` per complete value / top-level array element, tolerant of internal newlines and concatenated values. Only meaningful for the `stream` surface.",
        },
        {
            label: "sse",
            type: "property",
            detail: "SseOptions",
            info: "Resumable-SSE options (issue #71) — sibling to , but for the `sse` surface. **Off by default**: with no `sse.reconnect` the engine opens the live body once (today's behaviour). When enabled, a dropped stream reconnects, replaying the last `id:` as `Last-Event-ID` and honouring a server `retry:` (else `reconnect.backoffMs` / the `retry` policy), capped at `maxAttempts`. Plain JSON (the contract gate). Only the `sse` surface reads it.",
        },
        {
            label: "responseType",
            type: "property",
            detail: "ResponseType",
            info: "How to read the response body. Default: auto by content-type.",
        },
        {
            label: "url",
            type: "property",
            detail: "string | (() => string)",
            info: "Full request endpoint as one string — the atomic spelling, when a stitch is exactly one endpoint with no base to share. Templated (`{param}`, incl. the host) and `?query`-aware like `path`; may be a thunk for lazy/env resolution. ⚠️ `url` is the COMPLETE endpoint and is **not** joined to `baseUrl` — setting `url` makes `baseUrl` ignored. To address an endpoint *relative to* a shared `baseUrl` (e.g. a seam/fragment origin), use `path`, not a relative `url`: `url: '/users'` resolves to the un-fetchable `/users`, whereas `path: '/users'` resolves to `${baseUrl}/users`. Mutually exclusive with `baseUrl`/`path`: when both are set `url` wins, and across composed fragments the last fragment to write either spelling wins the whole slot.",
        },
        {
            label: "baseUrl",
            type: "property",
            detail: "string | (() => string)",
            info: "Origin that `path` is appended to, as a string or a thunk resolved at call time. Ignored when `url` is set (which carries its own origin).",
        },
        {
            label: "path",
            type: "property",
            detail: "string",
            info: "Path appended to `baseUrl` — use THIS (not a relative `url`) for an endpoint relative to a shared `baseUrl`; may include `{param}` slots and a `?query` string. Ignored when `url` is set.",
        },
        {
            label: "headers",
            type: "property",
            detail: "Record<string, string>",
            info: "Static default headers merged into every request.",
        },
        {
            label: "query",
            type: "property",
            detail: "string",
            info: "GraphQL query string (`kind: 'graphql'`).",
        },
        {
            label: "operationName",
            type: "property",
            detail: "string",
            info: "GraphQL `operationName` sent alongside `query` + `variables` (`kind: 'graphql'`). Omit to derive it from the first named operation in `query`; set it explicitly to override (e.g. a multi-operation document) or pass `''` to suppress the field entirely.",
        },
        {
            label: "input",
            type: "property",
            detail: "InputSchemas",
            info: "Schemas validating params, query, body, headers, and (GraphQL) variables before the request.",
        },
        {
            label: "output",
            type: "property",
            detail: "SchemaLike | DriftSpec",
            info: "Response schema, or a  for leveled drift detection. Accepts any (raw Zod / Standard Schema / Validator / predicate); the stitch infers its result type from it (see `InferOutput`), so a hand-written generic is rarely needed. No `toValidator()` cast is needed — raw Zod is the visible default, but any Standard Schema validator or a `(value) => boolean` predicate works in the same slot.",
        },
        {
            label: "unwrap",
            type: "property",
            detail: "string",
            info: "Dot-path selecting the part of the response to return.",
        },
        {
            label: "transform",
            type: "property",
            detail: "(body: unknown) => unknown",
            info: "Reshape the raw body before unwrap and validation (e.g. scrape HTML to structured data).",
        },
        {
            label: "paginate",
            type: "property",
            detail: "{ /** * Given the previous page's raw body and how many pages were fetched, return the * input (merged over the original) for the next page, or `undefined` to stop. */ next: ( prevBody: unknown, pagesFetched: number, ) => StitchInput | undefined; /** Pull the array from each unwrapped page. Default: the value if it is an array. */ items?: (value: unknown) => unknown[]; /** Safety cap on pages. Default 50. */ max?: number; }",
            info: "Auto-loop pages, aggregating items, with auth/retry/throttle applied to every page.",
        },
        {
            label: "auth",
            type: "property",
            detail: "AuthStrategy",
            info: "Auth strategy — the stitch holds the credential; the caller never sees it.",
        },
        {
            label: "retry",
            type: "property",
            detail: "number | RetryOptions",
            info: "Retry-and-backoff policy. A bare number is shorthand for the attempt count — `retry: 3` ≡ `retry: { attempts: 3 }`.",
        },
        {
            label: "acceptStatus",
            type: "property",
            detail: "number[] | ((status: number) => boolean)",
            info: "Statuses that are a NORMAL result rather than an error — a number list or a predicate. An accepted non-2xx flows through interpret → transform → unwrap → validate exactly like a 2xx (the response body becomes the result), instead of throwing a . Use this when an endpoint treats e.g. `404`/`400` as expected control flow (resource-gone → fall back to a broader call) so the happy path no longer runs through a `catch`. `retry.on` still wins while attempts remain: a status listed in BOTH is retried until attempts are exhausted, then accepted (returned) on the final attempt. Orthogonal to `rateLimit.delegate`, which surfaces a  on rate-limit statuses earlier.",
        },
        {
            label: "throttle",
            type: "property",
            detail: "ThrottleOptions",
            info: "Rate and concurrency limits.",
        },
        {
            label: "timeout",
            type: "property",
            detail: "number | string | TimeoutOptions",
            info: "Total and per-attempt timeouts. A bare number (ms) or duration string is shorthand for the total — `timeout: '5s'` ≡ `timeout: { total: '5s' }`.",
        },
        {
            label: "circuit",
            type: "property",
            detail: "CircuitOptions",
            info: "Circuit breaker that fast-fails a repeatedly failing dependency.",
        },
        {
            label: "rateLimit",
            type: "property",
            detail: "{ /** Surface rate-limit outcomes instead of retrying/throttling them. Default `false`. */ delegate?: boolean; /** Statuses treated as a rate-limit signal. Default `[429]`. */ on?: number[]; }",
            info: "Delegate backoff to the host (issue #145). When `delegate: true`, a rate-limit response (status in `on`, default `[429]`) is **not** retried internally and the built-in `throttle` is **bypassed** for the call — instead the outcome surfaces as a (carrying `status`, the `retryAfterMs` parsed from `Retry-After`, and the raw `response`) on the awaited path, and as an `error` event with `retryAfterMs` on `.stream()`. Use this when an OUTER gate/circuit owns the backoff (its own `Retry-After` hook, a DB-persisted budget) and StitchAPI's internal retry+throttle would double-count against it. ⚠️ In delegate mode the `throttle` config becomes **inert** for this stitch (the host owns the gate). A `circuit` block, if also set, still applies — the host may layer both. Non-rate-limit failures (5xx, etc.) behave exactly as today unless their status is listed in `on`. Validation, templating, transform/unwrap, and drift on the success path are unchanged.",
        },
        {
            label: "idempotency",
            type: "property",
            detail: "IdempotencyOptions",
            info: "Inject a stable Idempotency-Key header on writes so safe retries don't duplicate.",
        },
        {
            label: "cache",
            type: "property",
            detail: "number | string | CacheConfig",
            info: "Read-through response cache + in-process coalescing (ADR 0003). Off unless set; the engine is loaded lazily from the `stitchapi/cache` subpath only when this block is present. A bare number (ms) or duration string is shorthand for the TTL — `cache: '1m'` ≡ `cache: { ttl: '1m' }` (still subject to the fingerprint / `version` rules before an entry is actually stored).",
        },
        {
            label: "sensitive",
            type: "property",
            detail: "boolean",
            info: "Opt this stitch out of the cache **and** coalescing entirely — never stored, always a live call. The honest \"do not persist this response\" hatch for one-time tokens or compliance- bound data; the opaque key + principal scope already cover leak-protection, so the default `false` is not fail-open. Only meaningful alongside a `cache` block.",
        },
        {
            label: "arrayFormat",
            type: "property",
            detail: "'indices' | 'brackets' | 'repeat'",
            info: "How arrays are serialised in the query string. - `'indices'` (default) — `ids%5B0%5D=1&ids%5B1%5D=2` - `'brackets'`          — `ids%5B%5D=1&ids%5B%5D=2` - `'repeat'`            — `ids=1&ids=2`",
        },
        {
            label: "hooks",
            type: "property",
            detail: "Hooks",
            info: "Request/response/error/retry lifecycle hooks.",
        },
        {
            label: "extends",
            type: "property",
            detail: "(Partial<StitchConfig> | Stitch | string)[]",
            info: "Fragments to deep-merge under this config — strings, partials, or other stitches.",
        },
        {
            label: "adapter",
            type: "property",
            detail: "Adapter",
            info: "Test seam / custom transport.",
        },
        {
            label: "clock",
            type: "property",
            detail: "Clock",
            info: "Injectable time (ADR 0010). Defaults to the system clock; inject a `manualClock()` (from `stitchapi/testing`) to drive retry backoff, throttle pacing, the per-attempt timeout, and circuit cooldown deterministically in tests. Live object — stripped from `__config`.",
        },
        {
            label: "store",
            type: "property",
            detail: "StitchStore",
            info: "Pluggable state store for throttle + session. Default in-memory.",
        },
        {
            label: "trace",
            type: "property",
            detail: "TraceSink | 'console' | false",
            info: "Observability sink — **off by default**, because a stitch's only effect on the world is its call. Opt in with `'console'` (the colored stderr stream), a sink from `fileSink(path)` / `createTrace(...)` for JSONL on disk, or any custom . `false` forces it off even when the `STITCH_TRACE_*` env vars are set. Unset falls back to the env-driven sink, which is itself silent unless `STITCH_TRACE_CONSOLE` / `STITCH_TRACE_FILE` / `STITCH_EXPORT` opt in.",
        },
    ]
};

/** Member completions on the value returned by a primitive call. */
export const PLAYGROUND_INSTANCE_COMPLETIONS: Record<string, Completion[]> = {
    "stitch": [
        {
            label: "stream",
            type: "method",
            detail: "(...args: Args<TIn>) => AsyncGenerator<StitchEvent<TOut>, void>",
        },
        {
            label: "safe",
            type: "method",
            detail: "(...args: Args<TIn>) => Promise<SafeResult<TOut>>",
            info: "Call without throwing: resolves to a `SafeResult` — `{ ok, data, error }`. The eager shortcut for `stitch(...).safe()`, mirroring `.stream()`.",
        },
        {
            label: "unwrap",
            type: "method",
            detail: "(...args: Args<TIn>) => Promise<TOut>",
            info: "Call and unwrap to the value, throwing a `StitchError` on failure. The named twin of `.safe()` (and an explicit spelling of the throwing bare call).",
        },
        {
            label: "inspect",
            type: "method",
            detail: "(...args: [...Args<TIn>, opts?: InspectOptions]) => Promise<Inspection<TOut>>",
            info: "Probe a fresh call and return an  — `{ value, raw, findings, status, error }` — **without throwing** (ADR 0016). Use it after the fact to ask \"the schema coerced/stripped this; what did the server actually send?\": `raw` is the pre-validation body, `findings` the soft + hard drift between it and `value`. `.inspect()` **always hits the network and bypasses the cache by default**, so it is a fresh probe — *not* an observer of what your cached `await` call did. Pass `{ cache: true }` to honour the cache policy (then `raw` is `null` on a hit). On a streaming surface `raw` is `null` too (no single buffered body). ⚠️ `raw` is unredacted and non-enumerable — read `wrapper.raw` deliberately; never log the whole wrapper.",
        },
        {
            label: "with",
            type: "method",
            detail: "(partial: P) => Stitch<TOut, RelaxKeys<TIn, keyof P>>",
        },
        {
            label: "invalidate",
            type: "method",
            detail: "(input?: StitchInput) => Promise<void>",
            info: "Cache surface (ADR 0003). A no-op unless this stitch has a `cache` block. - `invalidate(input)` — **exact** eviction of the one entry that `input` would hit. - `cache.invalidate()` — **bulk** eviction of every entry this stitch produced (a per-stitch generation bump; prior entries become unreachable and TTL out). - `cache.key(input)` — the derived opaque key, for introspection.",
        },
        {
            label: "cache",
            type: "property",
            detail: "{ invalidate(): Promise<void>; key(input?: StitchInput): Promise<string | undefined>; }",
        },
        {
            label: "__config",
            type: "property",
            detail: "RedactedStitchConfig",
        },
        {
            label: "__stitch",
            type: "property",
            detail: "true",
        },
    ]
};
