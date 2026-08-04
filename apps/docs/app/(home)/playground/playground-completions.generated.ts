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
            info: "Request style — a Surface plugin (ADR 0005 Decisions 1-2). Omitted = the built-in `http` surface. The public `__config` exposes only the surface's `id` string (so a stitch's declaration round-trips as JSON — Decision 11); the live object stays on `__rawConfig`.",
        },
        {
            label: "method",
            type: "property",
            detail: "string",
            info: "HTTP method; defaults to `GET`.",
        },
        {
            label: "wire",
            type: "property",
            detail: "AtLeastOne<WireOptions>",
            info: "Wire-format options — request body encoding, response decoding, and urlencoded array serialisation, grouped by category rather than by request/response phase (CONTRACT.md P24). The opaque `wire: {}` is rejected (P20); no field dominates, so there is no scalar shorthand (P14), exactly as with StitchConfig.input.",
        },
        {
            label: "stream",
            type: "property",
            detail: "StreamDecode | AtLeastOne<StreamOptions>",
            info: "Streaming options (ADR 0005 Decision 5) — how a `stream` surface decodes the live body (`'bytes'` default / `'lines'` / `'ndjson'` / `'json'`). `'json'` is the structural, unframed streaming-JSON decoder (issue #111): one `delta` per complete value / top-level array element, tolerant of internal newlines and concatenated values. Only meaningful for the `stream` surface. A bare StreamDecode string is shorthand for the object form — `stream: 'ndjson'` ≡ `stream: { decode: 'ndjson' }` (CONTRACT.md P12); the opaque `stream: {}` is rejected (P20).",
        },
        {
            label: "sse",
            type: "property",
            detail: "boolean | AtLeastOne<SseOptions>",
            info: "Resumable-SSE options (issue #71) — sibling to StitchConfig.stream, but for the `sse` surface. **Off by default**: with no `sse` block the engine opens the live body once (today's behaviour). When enabled, a dropped stream reconnects, replaying the last `id:` as `Last-Event-ID` and honouring a server `retry:` (else `reconnect.delay` / the `retry` policy), capped at `reconnect.attempts`. Plain JSON (the contract gate). Only the `sse` surface reads it. `true` is shorthand for `{ reconnect: true }` (CONTRACT.md P13); the object form must set at least one field (P20).",
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
            label: "document",
            type: "property",
            detail: "string",
            info: "GraphQL document string (`kind: 'graphql'`) — sent as the request body's `query` field.",
        },
        {
            label: "operationName",
            type: "property",
            detail: "string",
            info: "GraphQL `operationName` sent alongside the document + `variables` (`kind: 'graphql'`). Omit to derive it from the first named operation in `document`; set it explicitly to override (e.g. a multi-operation document) or pass `''` to suppress the field entirely.",
        },
        {
            label: "input",
            type: "property",
            detail: "AtLeastOne<InputSchemas>",
            info: "Schemas validating params, query, body, headers, and (GraphQL) variables before the request. At least one slot must be set — the opaque `input: {}` is rejected (CONTRACT.md P20).",
        },
        {
            label: "output",
            type: "property",
            detail: "SchemaLike | DriftSpec",
            info: "Response schema, or a DriftSpec for leveled drift detection. Accepts any SchemaLike — a raw Zod schema, any Standard Schema (Valibot, ArkType), or a `(value) => boolean` predicate — directly; the stitch infers its result type from it (see `InferOutput`), so a hand-written generic is rarely needed.",
        },
        {
            label: "pick",
            type: "property",
            detail: "string",
            info: "Dot-path picking the part of the response to return (e.g. `'data.items'`).",
        },
        {
            label: "transform",
            type: "property",
            detail: "(body: unknown) => unknown",
            info: "Reshape the raw body before `pick` and validation (e.g. scrape HTML to structured data).",
        },
        {
            label: "paginate",
            type: "property",
            detail: "PaginateOptions",
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
            detail: "number | AtLeastOne<RetryOptions>",
            info: "Retry-and-backoff policy. A bare number is shorthand for the attempt count — `retry: 3` ≡ `retry: { attempts: 3 }`; the opaque `retry: {}` is rejected (CONTRACT.md P20).",
        },
        {
            label: "acceptStatus",
            type: "property",
            detail: "StatusMatch",
            info: "Status(es) that are a NORMAL result rather than an error — a number, a list, or a predicate (CONTRACT.md P7). An accepted non-2xx flows through interpret → transform → pick → validate exactly like a 2xx (the response body becomes the result), instead of throwing a StitchError. Use this when an endpoint treats e.g. `404`/`400` as expected control flow (resource-gone → fall back to a broader call) so the happy path no longer runs through a `catch`. `retry.on` still wins while attempts remain: a status listed in BOTH is retried until attempts are exhausted, then accepted (returned) on the final attempt. Orthogonal to `throttle.delegate`, which surfaces a RateLimitError on rate-limit statuses earlier.",
        },
        {
            label: "throttle",
            type: "property",
            detail: "string | AtLeastOne<ThrottleOptions>",
            info: "Rate and concurrency limits. A bare rate string is shorthand — `throttle: '2/s'` ≡ `throttle: { rate: '2/s' }` (CONTRACT.md P12); the opaque `throttle: {}` is rejected (P20).",
        },
        {
            label: "timeout",
            type: "property",
            detail: "number | string | AtLeastOne<TimeoutOptions>",
            info: "Total and per-attempt timeouts. A bare number (ms) or duration string is shorthand for the total — `timeout: '5s'` ≡ `timeout: { total: '5s' }`; the opaque `timeout: {}` is rejected (CONTRACT.md P20).",
        },
        {
            label: "circuit",
            type: "property",
            detail: "| [failures: number, cooldown: number | string] | AtLeastOne<CircuitOptions>",
            info: "Circuit breaker that fast-fails a repeatedly failing dependency. `failures` + `cooldown` are required by design (P15), so the empty object is rejected (P20 — `AtLeastOne`). The positional form names both at once — `circuit: [5, '30s']` ≡ `circuit: { failures: 5, cooldown: '30s' }`.",
        },
        {
            label: "idempotency",
            type: "property",
            detail: "boolean | AtLeastOne<IdempotencyOptions>",
            info: "Inject a stable Idempotency-Key header on writes so safe retries don't duplicate. `true` enables it with defaults (header `Idempotency-Key`, a random uuid per call); the object form customizes it and **must** set at least one field — the opaque `idempotency: {}` is rejected (CONTRACT.md P20).",
        },
        {
            label: "cache",
            type: "property",
            detail: "number | string | CacheOptions",
            info: "Read-through response cache + in-process coalescing (ADR 0003). Off unless set; the engine is loaded lazily from the `stitchapi/cache` subpath only when this block is present. A bare number (ms) or duration string is shorthand for the TTL — `cache: '1m'` ≡ `cache: { ttl: '1m' }` (still subject to the fingerprint / `version` rules before an entry is actually stored).",
        },
        {
            label: "sensitive",
            type: "property",
            detail: "boolean",
            info: "Opt this stitch out of the cache **and** coalescing entirely — never stored, always a live call. The honest \"do not persist this response\" hatch for one-time tokens or compliance- bound data; the opaque key + principal scope already cover leak-protection, so the default `false` is not fail-open. Only meaningful alongside a `cache` block.",
        },
        {
            label: "hooks",
            type: "property",
            detail: "AtLeastOne<Hooks>",
            info: "Request/response/error/retry lifecycle hooks. At least one — the opaque `hooks: {}` is rejected (CONTRACT.md P20).",
        },
        {
            label: "extends",
            type: "property",
            detail: "| Partial<StitchConfig> | Stitch | string | (Partial<StitchConfig> | Stitch | string)[]",
            info: "Fragment(s) to deep-merge under this config — strings, partials, or other stitches. A single fragment is shorthand for a one-element list (CONTRACT.md P7).",
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
            info: "Observability sink — **off by default**, because a stitch's only effect on the world is its call. Opt in with `'console'` (the colored stderr stream), a sink from `fileSink(path)` / `createTrace(...)` for JSONL on disk, or any custom TraceSink. `false` forces it off even when the `STITCH_TRACE_*` env vars are set. Unset falls back to the env-driven sink, which is itself silent unless `STITCH_TRACE_CONSOLE` / `STITCH_TRACE_FILE` / `STITCH_EXPORT` opt in.",
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
            detail: "(...args: [...Args<TIn>, opts?: boolean | AtLeastOne<InspectOptions>]) => Promise<Inspection<TOut>>",
            info: "Probe a fresh call and return an Inspection — `{ data, raw, findings, status, error }` — **without throwing** (ADR 0016). Use it after the fact to ask \"the schema coerced/stripped this; what did the server actually send?\": `raw` is the pre-validation body, `findings` the soft + hard drift between it and `data`. `.inspect()` **always hits the network and bypasses the cache by default**, so it is a fresh probe — *not* an observer of what your cached `await` call did. Pass `true` (≡ `{ cache: true }`) to honour the cache policy (then `raw` is `null` on a hit). On a streaming surface `raw` is `null` too (no single buffered body). ⚠️ `raw` is unredacted and non-enumerable — read `wrapper.raw` deliberately; never log the whole wrapper.",
        },
        {
            label: "report",
            type: "method",
            detail: "(...args: [...Args<TIn>, opts?: boolean | AtLeastOne<InspectOptions>]) => Promise<RunReport<TOut>>",
            info: "Probe a fresh call and return a RunReport — an Inspection (`{ data, raw, findings, status, error, source }`) **plus** run diagnostics: `attempts`, `timing` (`{ elapsed, waited? }`), the resolved+redacted `config`, and the fine-grained `cache` outcome (ADR 0019). Like `.inspect()` it **never throws** (a hard contract violation comes back with `error` set and the diagnostics populated) and is a **network probe**: it always hits the network and **bypasses the cache by default** — pass `true` (≡ `{ cache: true }`) to honour the cache policy (then `cache` reports the real `hit`/`miss` and `raw` is `null`/`source` is `'cache'` on a hit). Use `.report()` to ask \"how did this run go?\"; `.inspect()` stays the minimal \"raw + drift\" probe. ⚠️ `raw` is inherited unredacted and non-enumerable — the rest of the report is safe to log.",
        },
        {
            label: "with",
            type: "method",
            detail: "(partial: P) => Stitch<TOut, RelaxKeys<TIn, keyof P>>",
            info: "Bind part of the call input, returning a stitch whose remaining input is relaxed by the keys just supplied. Unlike the config surfaces, a MISSPELLED input key here is not a compile error — it binds nothing, silently (`.with({ params, parms })` keeps the `params` and drops the typo). Spell the slots as StitchInput declares them.",
        },
        {
            label: "invalidate",
            type: "method",
            detail: "(input?: StitchInput) => Promise<void>",
            info: "Cache surface (ADR 0003). A no-op unless this stitch has a `cache` block. - `invalidate(input)` — **exact** eviction of the one entry that `input` would hit. - `cache.invalidate()` — **bulk** eviction of every entry this stitch produced (a per-stitch generation bump; prior entries become unreachable and TTL out). - `cache.keyOf(input)` — the derived opaque key, for introspection (CONTRACT.md P6).",
        },
        {
            label: "cache",
            type: "property",
            detail: "{ invalidate(): Promise<void>; keyOf(input?: StitchInput): Promise<string | undefined>; }",
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
