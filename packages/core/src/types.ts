// Shared vocabulary for the prototype. Leaf modules (resilience, trace, http-adapter,
// auth, mock-server) and the engine all code against these types.
import type {
    Args,
    InputOf,
    RelaxKeys,
    ResolveOutput,
    SchemaLike,
} from './infer';
import type { Surface } from './surface';
import type { Validator } from './validator';

export interface StitchInput {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    variables?: Record<string, unknown>; // GraphQL variables (kind: 'graphql')
    /**
     * Per-call cancellation (ADR 0005 Decision 8). The engine threads it onto the request and
     * links it with the per-attempt timeout, so aborting it cancels the in-flight call. Runtime-
     * only — never serialised, never on `__config`.
     */
    signal?: AbortSignal;
    /**
     * Per-call byte-progress callback (ADR 0005 Decision 9), threaded onto the request — fires as
     * the request body is sent (`'upload'`, needs `xhrAdapter`) / the response arrives
     * (`'download'`). The `download` surface's natural progress channel. Runtime-only.
     */
    onProgress?: (progress: AdapterProgress) => void;
}

// ---- Drift ----------------------------------------------------------------
/**
 * Severity of a finding. `error` is reserved for a hard validation failure (`change: 'invalid'`),
 * which fails the call; soft drift is non-fatal — `warn` / `info` / `verbose` (quietest), see
 * {@link DriftSeverity}.
 */
export type DriftLevel = 'error' | 'warn' | 'info' | 'verbose';
/**
 * What a finding reports. The three **soft** kinds come from diffing the raw response against the
 * validated value (ADR 0015): `undeclared` (a key the schema stripped), `coerced` (a value the
 * schema coerced — a hidden wire-type shift), `defaulted` (a `.default()` fired because the field
 * was absent). `invalid` is the **hard** validation failure (missing-required / incompatible) that
 * throws.
 */
export type DriftChange = 'undeclared' | 'coerced' | 'defaulted' | 'invalid';
/** The soft (diff-derived) drift kinds — the ones whose severity is configurable. */
export type SoftDriftChange = Exclude<DriftChange, 'invalid'>;
/** Non-fatal severities a soft drift finding can carry. (Fatality is the schema's job — make the field required.) */
export type DriftSeverity = 'warn' | 'info' | 'verbose';
export interface DriftFinding {
    level: DriftLevel;
    path: string;
    change: DriftChange;
    detail?: string;
}
export interface DriftOptions {
    /**
     * Paths whose soft drift is suppressed — the acknowledged-but-unconsumed surface of the API, kept
     * out of the typed schema so the contract stays tight (ADR 0015). A narrow consumer schema means
     * an undeclared field is usually one you already know about, not a true addition; `ignore` is the
     * curated, path-only "known surface" (no typed baseline, so no variance false positives).
     *
     * The grammar mirrors the finding path: nested keys join with `.`, an **array element** is `[]`
     * (so `items[].meta` matches every element's `meta`), and a pattern matches by exact path, a
     * single-segment `*` wildcard, or as a prefix (`meta` ignores `meta` and everything beneath it).
     *
     * @example `ignore: ['meta', '_links', 'debug.*']`
     */
    ignore?: string[];
    /**
     * How soft drift is leveled / filtered. Three shapes (ADR 0015):
     * - a **single level** or a **bare list** of levels — an _allowlist_ of which severities to
     *   surface (others are dropped), keeping the per-kind defaults below. `'warn'` ≡ `['warn']`.
     * - a **map** of soft-change kind → severity — _re-levels_ a kind (all kinds still surface).
     *
     * Per-kind defaults: `undeclared` → `info`, `coerced` → `warn`, `defaulted` → `verbose`.
     * Omitted ⇒ every soft drift surfaces at its default level. Soft drift is always non-fatal;
     * to fail on a change, make the field required/strict in the schema (it becomes `invalid`).
     *
     * @example severity: 'warn'                         // surface only warn-level drift
     * @example severity: ['info', 'warn']               // surface info and warn (drop verbose)
     * @example severity: { coerced: 'info', defaulted: 'info' } // re-level two kinds
     */
    severity?:
        | DriftSeverity
        | DriftSeverity[]
        | Partial<Record<SoftDriftChange, DriftSeverity>>;
}
export interface DriftSpec<T = unknown> {
    __kind: 'drift';
    schema: Validator<T>;
    options: DriftOptions;
}

// ---- Adapter (HTTP kind) --------------------------------------------------
/** How to read the response body. Default (unset) = auto: JSON when the content-type is json-ish, else text. */
export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';
/**
 * How a multipart body serialises nested objects/arrays into field names (ADR 0005 Decision 6).
 * - `'bracket'` (default) — `parent[child][0]` keys (PHP/Rails convention; broadest compatibility).
 * - `'dot'` — `parent.child.0` keys.
 * - `'json'` — non-file data is one JSON part; each file leaf is hoisted to its own path-keyed part.
 * - `'none'` — top-level keys only (legacy; a nested object stringifies to `[object Object]`).
 */
export type MultipartNesting = 'bracket' | 'dot' | 'json' | 'none';
export interface MultipartOptions {
    /** Nesting strategy for nested objects/arrays in a multipart body. Default `'bracket'`. */
    nesting?: MultipartNesting;
}
/**
 * How the `stream` surface decodes each chunk of a live response body (ADR 0005 Decision 5).
 * - `'bytes'` (default) — raw `Uint8Array` chunks, lossless, no encoding assumed.
 * - `'lines'` — UTF-8, split on `\n`; each `delta` chunk is a `string`.
 * - `'ndjson'` — `'lines'` + `JSON.parse` per non-blank line; each chunk a parsed value.
 * - `'json'` — a STRUCTURAL streaming-JSON decoder (issue #111): emits each complete JSON value
 *   (and each top-level array element) as its own `delta`, tolerant of pretty-printed records with
 *   internal newlines and of concatenated values with no separator. Distinct from `'ndjson'`
 *   (newline-FRAMED): `'json'` is unframed and follows JSON structure (nesting/strings/escapes).
 */
export type StreamDecode = 'bytes' | 'lines' | 'ndjson' | 'json';
export interface StreamOptions {
    /** Decoder for a `stream` surface body. Default `'bytes'` (total + lossless). */
    decode?: StreamDecode;
    /**
     * Max bytes the `'json'` decoder will buffer for a single in-progress value before throwing
     * (the engine turns the throw into an `error` event). Guards against a malformed / never-closing
     * value growing without limit. Default ~8 MB (see `json-stream.ts`). Only meaningful for
     * `decode: 'json'`.
     */
    maxBufferBytes?: number;
}
/**
 * Tuning for resumable SSE reconnection (issue #71). When enabled, the engine reopens a dropped
 * `text/event-stream` body and replays the last seen `id:` as the `Last-Event-ID` request header so
 * the stream continues from where it broke. Plain data only — no functions — so it round-trips as
 * JSON (the contract-not-dependency gate). Only meaningful for the `sse` surface.
 */
export interface ReconnectOptions {
    /**
     * Total reconnect attempts after the first connection drops, before the stream gives up and
     * ends/errors exactly as today. Default 3.
     */
    maxAttempts?: number;
    /**
     * Fallback reconnect backoff (ms) when the server has NOT sent a `retry:` field on the dropped
     * connection. When omitted, the stitch's `retry` (`RetryOptions` — `backoff`/`baseMs`/`maxMs`)
     * supplies the delay. A server-sent `retry:` on the connection always wins over both.
     */
    backoffMs?: number;
}
/**
 * Resumable SSE (issue #71) — how the `sse` surface recovers from a dropped stream. **Off by
 * default**: with no `sse.reconnect` block the engine opens the body exactly once (today's
 * behaviour, byte-identical). When enabled the engine tracks the last `id:` seen and replays it as
 * `Last-Event-ID` on each reconnect, honours a server-sent `retry:` as the backoff (falling back to
 * `reconnect.backoffMs` / the stitch's `retry` policy), and caps reconnects at `maxAttempts`.
 *
 * `true` = enabled with sane defaults; the object form tunes the cap / fallback backoff. Plain JSON
 * (the contract gate). Only the `sse` surface acts on this; other surfaces ignore it.
 */
export interface SseOptions {
    reconnect?: boolean | ReconnectOptions;
}
/**
 * Byte-transfer progress for a single request (ADR 0005 Decision 9). Reported through
 * {@link AdapterRequest.onProgress}, tagged by direction: `'upload'` as the request body is
 * sent, `'download'` as the response body arrives. `total` is the content length when known.
 */
export interface AdapterProgress {
    phase: 'upload' | 'download';
    loaded: number;
    total?: number;
}
export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form' | 'multipart';
    /** Multipart serialisation options (nesting); only read when `bodyType: 'multipart'`. */
    multipart?: MultipartOptions;
    responseType?: ResponseType;
    /**
     * Ask the transport NOT to buffer/parse the response — hand back the live body instead
     * (ADR 0005 Decision 9 / Q1). When set, {@link AdapterResponse.body} is a
     * `ReadableStream<Uint8Array>`. Only `fetch` honours it; buffered-only adapters (axios, xhr)
     * reject the request.
     */
    stream?: boolean;
    /**
     * Byte-progress callback (ADR 0005 Decision 9). Fires with `phase: 'download'` as the
     * response is read, and `phase: 'upload'` as the request body is sent (upload progress needs
     * `xhrAdapter` — `fetch` cannot report it). Orthogonal to {@link AdapterRequest.stream}.
     */
    onProgress?: (progress: AdapterProgress) => void;
    signal?: AbortSignal;
}
export interface AdapterResponse {
    status: number;
    headers: Record<string, string>;
    // Parsed JSON when possible, else text — OR a `ReadableStream<Uint8Array>` when `stream` was set.
    body: unknown;
    /**
     * The final response URL (after redirects), when the transport exposes it (`fetchAdapter` sets
     * it from `response.url`). The `download` surface uses it for the filename fallback (ADR 0005
     * Decision 8); other readers may ignore it.
     */
    url?: string;
}
/**
 * An optional transport feature an adapter can declare it supports:
 *
 * -   `'stream'` — honours {@link AdapterRequest.stream}, handing back a live `ReadableStream`
 *     instead of rejecting it. `fetch` only among the built-ins (`xhr`/axios buffer and reject it).
 * -   `'uploadProgress'` — reports `phase: 'upload'` byte progress through
 *     {@link AdapterRequest.onProgress}. `xhr` and axios can; `fetch` cannot (it leaves the upload
 *     phase silent).
 * -   `'downloadProgress'` — reports `phase: 'download'` byte progress through
 *     {@link AdapterRequest.onProgress} as the response arrives. `fetch`, `xhr`, and axios all can.
 */
export type AdapterCapability =
    | 'stream'
    | 'uploadProgress'
    | 'downloadProgress';
/**
 * What a transport supports, declared on the adapter itself (ADR 0005 Decision 9). An adapter is
 * still just a function — this is an OPTIONAL hint hung off it. A descriptor lists the features the
 * transport HAS in `supports`; anything not listed, it can't do. Built-in adapters declare one so
 * the engine can turn a silent no-op into a teaching note: a call that asks for `phase: 'upload'`
 * progress on a transport whose `supports` omits `'uploadProgress'` (`fetch`, axios) gets an `info`
 * event pointing at `xhrAdapter`, instead of an upload bar that never moves. A custom adapter that
 * declares nothing is treated as unknown — no checks, the open contract stands.
 *
 * Diagnostics only; never part of `__config`, never serialised.
 */
export interface AdapterCapabilities {
    /** Human label for diagnostics, e.g. `'fetchAdapter'`. */
    name?: string;
    /** The optional features this transport supports. Anything NOT listed, it cannot do. */
    supports: AdapterCapability[];
}
/**
 * A transport: take a request, return a response, never throw on a non-2xx (ADR 0005). The optional
 * {@link AdapterCapabilities} is hung off the function so a plain `(req) => Promise<res>` still
 * satisfies the type — declaring capabilities is opt-in.
 */
export type Adapter = ((req: AdapterRequest) => Promise<AdapterResponse>) & {
    capabilities?: AdapterCapabilities;
};

// ---- Resilience options ---------------------------------------------------
export interface RetryOptions {
    attempts?: number; // total attempts incl. the first (default 1 = no retry)
    on?: number[]; // status codes that trigger a retry (default [429,502,503,504])
    backoff?: 'expo' | 'expo-jitter' | 'fixed';
    baseMs?: number;
    maxMs?: number;
    respectRetryAfter?: boolean;
}
export interface ThrottleOptions {
    rate?: string; // "2/s"
    concurrency?: number;
    /**
     * Where the limiter's counter is pooled: `'stitch'` (default) keeps a per-stitch
     * budget; `'host'` shares one budget across every stitch hitting the same host. Renamed
     * from `scope` (CONTRACT.md P2) so `scope` only ever means principal/app tenancy.
     */
    pool?: 'stitch' | 'host';
    /** @deprecated Renamed to {@link ThrottleOptions.pool} (CONTRACT.md P2). Read until the 1.0 GA cut. */
    scope?: 'stitch' | 'host';
}
/**
 * Options for one throttle `acquire`. `rateOnly` charges the rate limiter but takes NO concurrency
 * slot — for streaming surfaces (`sse`/`stream`), whose long-lived connection must not pin a slot
 * (ADR 0005 Decision 12). A rate-only acquire is NOT paired with a `release` (nothing was held).
 */
export interface AcquireOptions {
    rateOnly?: boolean;
}
export interface TimeoutOptions {
    total?: number | string;
    perAttempt?: number | string;
}
export interface CircuitOptions {
    failureThreshold: number; // consecutive failures that trip the breaker OPEN
    cooldownMs: number; // fast-fail window after opening, before a half-open trial
    halfOpenAfterMs?: number; // when to allow a half-open trial (default cooldownMs)
    key?: string; // store namespace to share a breaker across stitches (default: stitch/host key)
}
export interface IdempotencyOptions {
    header?: string; // header name (default 'Idempotency-Key')
    /** Derive a stable key per logical call (default: a random uuid). Renamed from `key` (CONTRACT.md P6: `key` is a string, a derivation fn is `keyOf`). */
    keyOf?: (input: StitchInput) => string;
    /** @deprecated Renamed to {@link IdempotencyOptions.keyOf} (CONTRACT.md P6). Read until the 1.0 GA cut. */
    key?: (input: StitchInput) => string;
}

// ---- Cache (ADR 0003) -----------------------------------------------------
/**
 * Transport-level response cache + in-process request coalescing (ADR 0003). The key is
 * **derived** from the resolved request — no caller-authored keys — so it cannot drift from
 * what it names. Off by default: no `cache` block ⇒ no caching and no hot-path cost. The engine
 * ships behind its own `stitchapi/cache` subpath, so `import { stitch }` pulls none of it.
 *
 * Every field round-trips as JSON; `key` is **sugar** (a function override) that does not.
 */
export interface CacheOptions {
    /** Time-to-live for a cached entry — `30_000`, `'30s'`, `'5m'`. Bounds staleness/drift. */
    ttl: number | string;
    /**
     * Whose responses an entry may be served to. `'principal'` (default, **fail-closed**) folds
     * the bound principal into the key so user A can never be served user B's cached response;
     * `'app'` shares one entry across callers — correct only for public, unauthenticated data.
     */
    scope?: 'principal' | 'app';
    /**
     * Request headers whose values vary the response and so must be part of the key (e.g.
     * `['accept-language']`). An explicit allowlist **overrides** the default of honouring the
     * response's `Vary`. Volatile/secret headers (authorization, cookie, traceparent, …) are
     * never keyed.
     */
    vary?: string[];
    /**
     * Cacheable HTTP methods. Default `['GET','HEAD']`. A GraphQL **query** opts in by listing
     * its method (`['POST']`) — a POST's read-vs-mutate intent cannot be inferred, so it is
     * explicit. Coalescing applies to exactly this set; mutations are never cached.
     */
    methods?: string[];
    /** In-process LRU cap on live entries (the store stays dumb). Default 1000. */
    maxEntries?: number;
    /**
     * Request coalescing mode. `'process'` (v1 default) collapses concurrent identical in-flight
     * callers in one process onto a single shared run; `false` disables it. `'cluster'` is
     * reserved for the deferred cross-process protocol and behaves as `'process'` in v1.
     */
    coalesce?: 'process' | 'cluster' | false;
    /**
     * Opaque schema/version tag — the **authoritative** rung of the fingerprint ladder (ADR 0004):
     * setting it pins the contract and takes the **no-revalidate** fast path (you promise the
     * `output`/`transform`/`unwrap` are unchanged for this tag). Leaving it unset hands off to the
     * automatic fingerprint: a registered `@stitchapi/fingerprint-*` strategy makes `output`
     * changes self-invalidate on the fast path; an un-fingerprintable schema falls to
     * {@link CacheOptions.onUnfingerprintable} (default **refuse-to-cache**, fail-closed).
     */
    version?: string | number;
    /**
     * Version tag for an opaque `transform` (ADR 0004). A `transform` is a closure that cannot be
     * soundly hashed, so by default a stitch that has one **refuses to cache** (re-validation can't
     * detect a transform change). Set this to make the transform sound and re-enable caching; bump
     * it whenever the transform's behaviour changes. See also {@link CacheOptions.trustTransform}.
     */
    transformVersion?: string | number;
    /**
     * Opt in to caching despite an un-versioned `transform`, trusting that its output is stable for
     * the `ttl`. Weaker than {@link CacheOptions.transformVersion} (a transform change is invisible,
     * bounded only by TTL); prefer `transformVersion` when you can name a version.
     */
    trustTransform?: boolean;
    /**
     * Policy when an `output` schema is present but cannot be soundly fingerprinted (no
     * `@stitchapi/fingerprint-*` registered for its vendor, a non-Standard-Schema validator, or the
     * strategy abstained). `'refuse'` (default, **fail-closed**) does not cache — and nudges you to
     * register the vendor package or set `version`. `'revalidate'` caches but **re-validates the
     * stored value on every hit** against the current schema (saves the network, still safe; sound
     * only for pure validators with no coercion/transform inside the schema).
     */
    onUnfingerprintable?: 'refuse' | 'revalidate';
    /** Sugar: author the key seed from the input instead of deriving it from the request. Renamed from `key` (CONTRACT.md P6). */
    keyOf?: (input: StitchInput) => string;
    /** @deprecated Renamed to {@link CacheOptions.keyOf} (CONTRACT.md P6). Read until the 1.0 GA cut. */
    key?: (input: StitchInput) => string;
}

// ---- Auth -----------------------------------------------------------------
export interface AuthContext {
    store: StitchStore; // throttle/session state — in-memory by default, shareable when configured
    /**
     * Secret namespace for auth tokens/sessions: off `__config`, redacted from traces, read
     * only by auth strategies (ADR 0002 §4). Defaults to a reserved prefix over `store`; a
     * seam may back it with a hardened `secretStore`. Sessions are keyed by scope here.
     */
    vault: StitchStore;
    /**
     * The principal this call is bound to, threaded from `seam.as(principal)` — `undefined`
     * when no seam binds one. Set by trusted code; NEVER readable from `StitchInput`, so a
     * caller cannot name (and impersonate) another principal (ADR 0002 §2).
     */
    principal?: string;
    /**
     * The current run (ADR 0007), threaded per-call by the engine. A strategy that spawns a
     * sub-call — `cookieSession`'s login — runs it as a CHILD of this run so it appears in the
     * trace/span tree under the call that triggered it. `undefined` outside a traced run.
     */
    run?: RunContext;
    /**
     * Announce an `info` StitchEvent onto the run's event stream — a strategy reporting a
     * decision it made (e.g. which env var a `bearer` token resolved from via `optionalEnv`, or
     * that `oauth2` fetched a token). NEVER carries the secret itself. The engine buffers these
     * during `apply`/`refresh` and yields them; outside a run it is a no-op.
     */
    emit: (topic: string, detail?: string) => void;
    runLogin?: () => Promise<AdapterResponse>; // for cookieSession: invoke the login stitch
}
/**
 * A non-secret, declarative description of an auth strategy's wire shape — the OpenAPI 3.1
 * "Security Scheme Object", minus any credential material. A built-in strategy exposes one via
 * {@link AuthStrategy.scheme}; redaction then projects it onto the public `__config` as
 * `authScheme` (the live, secret-bearing `auth` is stripped), so a stitch's auth round-trips as
 * JSON (the contract gate) and `stitch export --openapi` can emit `components.securitySchemes`. It
 * NEVER carries a token, key value, or password — only the scheme's type and the parameter
 * names/URLs that are public in any OpenAPI document.
 */
export type SecurityScheme =
    | { type: 'http'; scheme: 'bearer' | 'basic'; bearerFormat?: string }
    | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
    | {
          type: 'oauth2';
          flows: {
              clientCredentials?: {
                  tokenUrl: string;
                  scopes: Record<string, string>;
                  refreshUrl?: string;
              };
          };
      };
export interface AuthStrategy {
    name?: string;
    /**
     * A non-secret {@link SecurityScheme} describing this strategy's wire shape. Redaction surfaces
     * it onto the public `__config.authScheme` (the live strategy itself is stripped) so the auth
     * round-trips as JSON and feeds `stitch export --openapi`. Built-ins set it; omit it in a
     * custom strategy whose scheme cannot be described, and the exporter simply leaves it
     * unannotated.
     */
    scheme?: SecurityScheme;
    apply: (req: AdapterRequest, ctx: AuthContext) => void | Promise<void>;
    shouldRefresh?: (res: AdapterResponse) => boolean;
    refresh?: (ctx: AuthContext) => void | Promise<void>;
}

// ---- Hooks ----------------------------------------------------------------
export interface HookContext {
    name: string;
    attempt: number;
    req?: AdapterRequest;
    res?: AdapterResponse;
    error?: unknown;
}
export interface Hooks {
    onRequest?: (ctx: HookContext) => void | Promise<void>;
    onResponse?: (ctx: HookContext) => void | Promise<void>;
    onError?: (ctx: HookContext) => void | Promise<void>;
    onRetry?: (ctx: HookContext) => void | Promise<void>;
}

// ---- Events (the streaming spine) -----------------------------------------
export type ProgressPhase =
    | 'auth'
    | 'request'
    | 'throttled'
    | 'retry'
    // A resumable-SSE reconnect (issue #71): emitted before the engine waits the backoff and
    // reopens a dropped `text/event-stream` body with the last `id:` replayed as `Last-Event-ID`.
    // Reuses the `progress` event (its `attempt` is the reconnect count, `waitedMs` the backoff)
    // rather than minting a new StitchEvent type — same shape as the `retry` phase.
    | 'reconnect'
    | 'paginate'
    | 'circuit'
    | 'cache';
export type StitchEvent<T = unknown> =
    | {
          type: 'start';
          name: string;
          method: string;
          url: string;
          input: StitchInput;
          at: number;
          // Run identity (ADR 0007) — also delivered on the {@link TraceContext} ctx. Stamped
          // here too so a non-sink `.stream()` consumer can read a run's identity off its first
          // event. Optional: a `start` event built by hand (tests) may omit them.
          runId?: string;
          traceId?: string;
          parentId?: string;
      }
    | {
          type: 'progress';
          phase: ProgressPhase;
          attempt: number;
          detail?: string;
          waitedMs?: number;
          at: number;
      }
    // A strategy-level announcement (auth decisions, inference). Non-progress; carries no secret.
    | { type: 'info'; topic: string; detail?: string; at: number }
    | { type: 'drift'; finding: DriftFinding; at: number }
    | { type: 'delta'; chunk: unknown; at: number }
    | { type: 'result'; value: T; status: number; attempts: number; at: number }
    | {
          type: 'error';
          name: string;
          message: string;
          status?: number;
          // Set only on a delegate-backoff rate-limit outcome (`rateLimit.delegate`): the ms parsed
          // from `Retry-After` (delta-seconds OR HTTP-date), so a `.stream()` consumer gets the same
          // structured backoff hint the awaited path gets off the thrown RateLimitError. Additive and
          // optional — every other `error` event omits it (issue #145).
          retryAfterMs?: number;
          attempts: number;
          at: number;
      }
    | { type: 'done'; ok: boolean; ms: number; attempts: number; at: number };

// ---- Clock (injectable time, ADR 0010) ------------------------------------
/** An opaque timer handle returned by {@link Clock.setTimer}. */
export type TimerHandle = unknown;
/**
 * The seam for time. The engine reads the clock for retry backoff, throttle pacing, the per-attempt
 * timeout, circuit cooldown, and `Retry-After` HTTP-dates — so a test can drive them deterministically
 * with no real waiting. Defaults to the system clock (wall-clock + global timers); inject a
 * `manualClock()` (from `stitchapi/testing`) to control time by hand. NOTE: `timeout.total` and the
 * `at`/`ms` fields on events stay on wall-clock and are not driven by the clock.
 */
export interface Clock {
    /** Current time in epoch ms. */
    now(): number;
    /** Resolve after `ms`; reject promptly if `signal` aborts. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    /** Run `fn` after `ms`; returns a handle for {@link Clock.clearTimer}. */
    setTimer(fn: () => void, ms: number): TimerHandle;
    /** Cancel a pending timer from {@link Clock.setTimer}. */
    clearTimer(handle: TimerHandle): void;
}

// ---- Config & the Stitch callable ----------------------------------------
// Each slot accepts any {@link SchemaLike} (raw Zod / Standard Schema / Validator / predicate) —
// no `toValidator()` cast required; `normalizeInput` coerces them at compose time.
export interface InputSchemas {
    params?: SchemaLike;
    query?: SchemaLike;
    body?: SchemaLike;
    headers?: SchemaLike;
    // GraphQL variables (the `graphql` surface's primary input). Declaring a schema here types the
    // call arg's `variables` (see `CallInput`) and validates them at runtime alongside the other
    // slots; left undeclared, `variables` stays the loose untyped passthrough it has always been.
    variables?: SchemaLike;
}
export interface StitchConfig {
    /** Label used in events and traces; defaults to `path` or `'stitch'`. */
    name?: string;
    /**
     * Request style — a {@link Surface} plugin (ADR 0005 Decisions 1-2). Omitted = the built-in
     * `http` surface. The public `__config` exposes only the surface's `id` string (so a stitch's
     * declaration round-trips as JSON — Decision 11); the live object stays on `__rawConfig`.
     */
    kind?: Surface;
    /** HTTP method; defaults to `GET`. */
    method?: string;
    /** Request body encoding. Default `'json'`. */
    bodyType?: 'json' | 'form' | 'multipart';
    /**
     * Multipart serialisation options (ADR 0005 Decision 6) — how nested objects/arrays become
     * field names. Only meaningful with `bodyType: 'multipart'`. Default nesting `'bracket'`.
     */
    multipart?: MultipartOptions;
    /**
     * Streaming options (ADR 0005 Decision 5) — how a `stream` surface decodes the live body
     * (`'bytes'` default / `'lines'` / `'ndjson'` / `'json'`). `'json'` is the structural,
     * unframed streaming-JSON decoder (issue #111): one `delta` per complete value / top-level
     * array element, tolerant of internal newlines and concatenated values. Only meaningful for
     * the `stream` surface.
     */
    stream?: StreamOptions;
    /**
     * Resumable-SSE options (issue #71) — sibling to {@link StitchConfig.stream}, but for the `sse`
     * surface. **Off by default**: with no `sse.reconnect` the engine opens the live body once
     * (today's behaviour). When enabled, a dropped stream reconnects, replaying the last `id:` as
     * `Last-Event-ID` and honouring a server `retry:` (else `reconnect.backoffMs` / the `retry`
     * policy), capped at `maxAttempts`. Plain JSON (the contract gate). Only the `sse` surface
     * reads it.
     */
    sse?: SseOptions;
    /** How to read the response body. Default: auto by content-type. */
    responseType?: ResponseType;
    /**
     * Full request endpoint as one string — the atomic spelling, when a stitch is exactly one
     * endpoint with no base to share. Templated (`{param}`, incl. the host) and `?query`-aware
     * like `path`; may be a thunk for lazy/env resolution.
     *
     * ⚠️ `url` is the COMPLETE endpoint and is **not** joined to `baseUrl` — setting `url` makes
     * `baseUrl` ignored. To address an endpoint *relative to* a shared `baseUrl` (e.g. a
     * seam/fragment origin), use `path`, not a relative `url`: `url: '/users'` resolves to the
     * un-fetchable `/users`, whereas `path: '/users'` resolves to `${baseUrl}/users`. Mutually
     * exclusive with `baseUrl`/`path`: when both are set `url` wins, and across composed
     * fragments the last fragment to write either spelling wins the whole slot.
     */
    url?: string | (() => string);
    /** Origin that `path` is appended to, as a string or a thunk resolved at call time. Ignored when `url` is set (which carries its own origin). */
    baseUrl?: string | (() => string);
    /** Path appended to `baseUrl` — use THIS (not a relative `url`) for an endpoint relative to a shared `baseUrl`; may include `{param}` slots and a `?query` string. Ignored when `url` is set. */
    path?: string;
    /** Static default headers merged into every request. */
    headers?: Record<string, string>;
    /** GraphQL query string (`kind: 'graphql'`). */
    query?: string;
    /**
     * GraphQL `operationName` sent alongside `query` + `variables` (`kind: 'graphql'`). Omit to
     * derive it from the first named operation in `query`; set it explicitly to override (e.g. a
     * multi-operation document) or pass `''` to suppress the field entirely.
     */
    operationName?: string;
    /** Schemas validating params, query, body, headers, and (GraphQL) variables before the request. */
    input?: InputSchemas;
    /**
     * Response schema, or a {@link DriftSpec} for leveled drift detection. Accepts any
     * {@link SchemaLike} (raw Zod / Standard Schema / Validator / predicate); the stitch infers
     * its result type from it (see `InferOutput`), so a hand-written generic is rarely needed.
     * No `toValidator()` cast is needed — raw Zod is the visible default, but any Standard Schema
     * validator or a `(value) => boolean` predicate works in the same slot.
     *
     * @example output: z.object({ id: z.number(), name: z.string() })
     */
    output?: SchemaLike | DriftSpec;
    /** Dot-path selecting the part of the response to return. */
    unwrap?: string;
    /** Reshape the raw body before unwrap and validation (e.g. scrape HTML to structured data). */
    transform?: (body: unknown) => unknown;
    /** Auto-loop pages, aggregating items, with auth/retry/throttle applied to every page. */
    paginate?: {
        /**
         * Given the previous page's raw body and how many pages were fetched, return the
         * input (merged over the original) for the next page, or `undefined` to stop.
         */
        next: (
            prevBody: unknown,
            pagesFetched: number,
        ) => StitchInput | undefined;
        /** Pull the array from each unwrapped page. Default: the value if it is an array. */
        items?: (value: unknown) => unknown[];
        /** Safety cap on pages. Default 50. */
        max?: number;
    };
    /** Auth strategy — the stitch holds the credential; the caller never sees it. */
    auth?: AuthStrategy;
    /**
     * Retry-and-backoff policy. A bare number is shorthand for the attempt count —
     * `retry: 3` ≡ `retry: { attempts: 3 }`.
     */
    retry?: number | RetryOptions;
    /**
     * Statuses that are a NORMAL result rather than an error — a number list or a predicate.
     * An accepted non-2xx flows through interpret → transform → unwrap → validate exactly like a
     * 2xx (the response body becomes the result), instead of throwing a {@link StitchError}. Use
     * this when an endpoint treats e.g. `404`/`400` as expected control flow (resource-gone → fall
     * back to a broader call) so the happy path no longer runs through a `catch`.
     *
     * `retry.on` still wins while attempts remain: a status listed in BOTH is retried until attempts
     * are exhausted, then accepted (returned) on the final attempt. Orthogonal to
     * `rateLimit.delegate`, which surfaces a {@link RateLimitError} on rate-limit statuses earlier.
     */
    acceptStatus?: number[] | ((status: number) => boolean);
    /** Rate and concurrency limits. */
    throttle?: ThrottleOptions;
    /**
     * Total and per-attempt timeouts. A bare number (ms) or duration string is shorthand for the
     * total — `timeout: '5s'` ≡ `timeout: { total: '5s' }`.
     */
    timeout?: number | string | TimeoutOptions;
    /** Circuit breaker that fast-fails a repeatedly failing dependency. */
    circuit?: CircuitOptions;
    /**
     * Delegate backoff to the host (issue #145). When `delegate: true`, a rate-limit response
     * (status in `on`, default `[429]`) is **not** retried internally and the built-in `throttle`
     * is **bypassed** for the call — instead the outcome surfaces as a {@link RateLimitError}
     * (carrying `status`, the `retryAfterMs` parsed from `Retry-After`, and the raw `response`) on
     * the awaited path, and as an `error` event with `retryAfterMs` on `.stream()`. Use this when an
     * OUTER gate/circuit owns the backoff (its own `Retry-After` hook, a DB-persisted budget) and
     * StitchAPI's internal retry+throttle would double-count against it.
     *
     * ⚠️ In delegate mode the `throttle` config becomes **inert** for this stitch (the host owns the
     * gate). A `circuit` block, if also set, still applies — the host may layer both. Non-rate-limit
     * failures (5xx, etc.) behave exactly as today unless their status is listed in `on`. Validation,
     * templating, transform/unwrap, and drift on the success path are unchanged.
     */
    rateLimit?: {
        /** Surface rate-limit outcomes instead of retrying/throttling them. Default `false`. */
        delegate?: boolean;
        /** Statuses treated as a rate-limit signal. Default `[429]`. */
        on?: number[];
    };
    /** Inject a stable Idempotency-Key header on writes so safe retries don't duplicate. */
    idempotency?: IdempotencyOptions;
    /**
     * Read-through response cache + in-process coalescing (ADR 0003). Off unless set; the engine
     * is loaded lazily from the `stitchapi/cache` subpath only when this block is present. A bare
     * number (ms) or duration string is shorthand for the TTL — `cache: '1m'` ≡
     * `cache: { ttl: '1m' }` (still subject to the fingerprint / `version` rules before an entry is
     * actually stored).
     */
    cache?: number | string | CacheOptions;
    /**
     * Opt this stitch out of the cache **and** coalescing entirely — never stored, always a live
     * call. The honest "do not persist this response" hatch for one-time tokens or compliance-
     * bound data; the opaque key + principal scope already cover leak-protection, so the default
     * `false` is not fail-open. Only meaningful alongside a `cache` block.
     */
    sensitive?: boolean;
    /**
     * How arrays are serialised in the query string.
     * - `'indices'` (default) — `ids%5B0%5D=1&ids%5B1%5D=2`
     * - `'brackets'`          — `ids%5B%5D=1&ids%5B%5D=2`
     * - `'repeat'`            — `ids=1&ids=2`
     */
    arrayFormat?: 'indices' | 'brackets' | 'repeat';
    /** Request/response/error/retry lifecycle hooks. */
    hooks?: Hooks;
    /** Fragments to deep-merge under this config — strings, partials, or other stitches. */
    extends?: (Partial<StitchConfig> | Stitch | string)[];
    /** Test seam / custom transport. */
    adapter?: Adapter;
    /**
     * Injectable time (ADR 0010). Defaults to the system clock; inject a `manualClock()` (from
     * `stitchapi/testing`) to drive retry backoff, throttle pacing, the per-attempt timeout, and
     * circuit cooldown deterministically in tests. Live object — stripped from `__config`.
     */
    clock?: Clock;
    /** Pluggable state store for throttle + session. Default in-memory. */
    store?: StitchStore;
    /**
     * Observability sink — **off by default**, because a stitch's only effect on
     * the world is its call. Opt in with `'console'` (the colored stderr stream),
     * a sink from `fileSink(path)` / `createTrace(...)` for JSONL on disk, or any
     * custom {@link TraceSink}. `false` forces it off even when the `STITCH_TRACE_*`
     * env vars are set. Unset falls back to the env-driven sink, which is itself
     * silent unless `STITCH_TRACE_CONSOLE` / `STITCH_TRACE_FILE` / `STITCH_EXPORT`
     * opt in.
     */
    trace?: TraceSink | 'console' | false;
}

/**
 * A {@link StitchConfig} after {@link compose} has run: every authoring shorthand is expanded, so
 * the resilience fields are always their object form (a scalar `retry` / `timeout` / `cache`
 * literal is normalised to `{ attempts }` / `{ total }` / `{ ttl }`). This is the shape the engine
 * and {@link redactConfig} read — never the loose authoring union.
 */
export type ResolvedStitchConfig = Omit<
    StitchConfig,
    'retry' | 'timeout' | 'cache'
> & {
    retry?: RetryOptions;
    timeout?: TimeoutOptions;
    cache?: CacheOptions;
};

/**
 * The PUBLIC, redacted projection of a {@link StitchConfig} that a stitch exposes as `__config`
 * (and a seam as its shared `__config`). {@link redactConfig} produces it: the live, secret-bearing
 * handles are stripped (`auth`, `store`, `adapter`), the surface is normalised to its `id` string
 * (`kind`), and the auth's non-secret {@link SecurityScheme} is projected onto `authScheme`. It
 * therefore round-trips as JSON (ADR 0005 Decision 11 — the contract gate) and is what `mcp` /
 * `diagram` / `stitch export --openapi` read.
 *
 * This is the HONEST runtime shape: `__config.auth` / `.store` / `.adapter` are always absent, and
 * `__config.kind` is the surface's `id` string — never a live {@link Surface}. (The full,
 * secret-bearing config lives on the non-enumerable `__rawConfig`, used only for fragment
 * composition.)
 */
export type RedactedStitchConfig = Omit<
    ResolvedStitchConfig,
    'auth' | 'store' | 'adapter' | 'clock' | 'kind'
> & {
    /** The surface's `id` string (never the live {@link Surface}); absent for the default `http`. */
    kind?: string;
    /** Non-secret auth scheme projected from the (stripped) live `auth`; feeds `export --openapi`. */
    authScheme?: SecurityScheme;
};

/**
 * The error a failed stitch raises: a non-2xx response (after retries), a contract/validation
 * breach, a timeout, or an open circuit. It is what `await stitch(...)` and {@link Stitch.unwrap}
 * throw, and what rides in `error` on the {@link SafeResult} from {@link Stitch.safe}.
 */
export class StitchError extends Error {
    /** HTTP status when the failure came from a response; `undefined` for transport/internal errors. */
    readonly status: number | undefined;
    /** Attempts made before giving up (1 = no retry). */
    readonly attempts: number;
    /**
     * The parsed response body of the failing response (an API's `{ error: "..." }` payload),
     * when the failure came from an HTTP response; `undefined` for transport/internal errors. Only
     * populated on the awaited / `.safe()` path — it is carried over the non-enumerable error
     * channel and so never serialises into a trace sink.
     */
    readonly body?: unknown;
    /** The final request URL (after redirects) of the failing response, when the transport exposes it. */
    readonly url?: string;
    constructor(
        message: string,
        opts: {
            status?: number | undefined;
            attempts?: number | undefined;
            body?: unknown;
            url?: string | undefined;
            cause?: unknown;
        } = {},
    ) {
        super(
            message,
            opts.cause !== undefined ? { cause: opts.cause } : undefined,
        );
        this.name = 'StitchError';
        this.status = opts.status;
        this.attempts = opts.attempts ?? 0;
        if (opts.body !== undefined) this.body = opts.body;
        if (opts.url !== undefined) this.url = opts.url;
    }
}

/**
 * The outcome of a never-throwing call ({@link Stitch.safe}). A discriminated union: check `error`
 * (or `ok`) — when `error` is `null` the call succeeded and `data` is the result; otherwise `error`
 * is the {@link StitchError} and `data` is `null`.
 */
export type SafeResult<T> =
    | { ok: true; data: T; error: null }
    | { ok: false; data: null; error: StitchError };

/** Options for {@link Stitch.inspect} (ADR 0016). */
export interface InspectOptions {
    /**
     * Honour the cache policy instead of bypassing it. Default `false` — `.inspect()` is a fresh
     * network probe (neither reads nor writes the cache), so `raw` is always live. With `cache: true`
     * a cache hit is allowed, but the cache stores only `{ value, status }` — so `raw` is `null` on
     * a hit (it is only populated on a miss, where a live request actually ran).
     */
    cache?: boolean;
}

/**
 * The result of {@link Stitch.inspect} (ADR 0016) — the validated value alongside the pre-validation
 * raw body and the drift {@link DriftFinding}s diffed between them, plus the response `status`. It
 * **never throws**: a hard contract violation comes back as `{ value: null, error }` with `raw`,
 * `findings`, and `status` still populated. `value` and `error` are **inverse** — `value` is `null`
 * iff `error` is set.
 *
 * ⚠️ `raw` is the UNREDACTED pre-validation body, exposed on a **non-enumerable** field: `JSON.stringify`,
 * object spread, and trace walkers all skip it, so it can't leak by accident — reach for `wrapper.raw`
 * deliberately, and never log the whole wrapper. `raw` is `null` on a streaming surface (no single
 * buffered body) and on a cache hit.
 */
export interface Inspection<T> {
    /** The validated value — coerced/defaulted/stripped per ADR 0015; `null` iff `error` is set. */
    value: T | null;
    /** The pre-validation body the findings are diffed against. Non-enumerable; `null` on streaming/cache-hit. */
    raw: unknown;
    /** Soft + hard drift findings (including those that ride the event stream), in emission order. */
    findings: DriftFinding[];
    /** HTTP status of the probed response — makes `raw` interpretable (a `422` body reads unlike a `200`). */
    status: number;
    /** The {@link StitchError} on a hard failure; `null` on success. */
    error: StitchError | null;
}

export interface StitchResult<T> extends PromiseLike<T> {
    stream(): AsyncGenerator<StitchEvent<T>, void>;
    /** Consume the call without throwing — resolves to `{ ok, data, error }` (see {@link SafeResult}); shares the one run with `then`/`catch`/`finally`. */
    safe(): Promise<SafeResult<T>>;
    /** Attach a rejection handler (like `Promise.catch`); the stitch runs once, shared with `then`/`finally`/`safe`. */
    catch<R = never>(
        onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R>;
    /** Run a callback when the call settles (like `Promise.finally`); shared with `then`/`catch`/`safe`. */
    finally(onfinally?: (() => void) | null): Promise<T>;
}
/**
 * The callable a stitch resolves to. `TOut` is the result type (inferred from `config.output`);
 * `TIn` is the call-argument type (inferred from `config.input` — see {@link InputOf}). `TIn`
 * defaults to the loose {@link StitchInput}, which has no required keys, so a stitch with no input
 * schemas keeps its fully-optional argument and every pre-Phase-2 `Stitch<T>` usage is unchanged.
 * No `extends StitchInput` bound on `TIn`: a `headers` schema can infer non-string values, which
 * `Record<string, string>` would reject.
 */
export interface Stitch<TOut = unknown, TIn = StitchInput> {
    (...args: Args<TIn>): StitchResult<TOut>;
    stream(...args: Args<TIn>): AsyncGenerator<StitchEvent<TOut>, void>;
    /**
     * Call without throwing: resolves to a `SafeResult` — `{ ok, data, error }`. The eager
     * shortcut for `stitch(...).safe()`, mirroring `.stream()`.
     */
    safe(...args: Args<TIn>): Promise<SafeResult<TOut>>;
    /**
     * Call and unwrap to the value, throwing a `StitchError` on failure. The named twin
     * of `.safe()` (and an explicit spelling of the throwing bare call).
     */
    unwrap(...args: Args<TIn>): Promise<TOut>;
    /**
     * Probe a fresh call and return an {@link Inspection} — `{ value, raw, findings, status, error }` —
     * **without throwing** (ADR 0016). Use it after the fact to ask "the schema coerced/stripped this;
     * what did the server actually send?": `raw` is the pre-validation body, `findings` the soft + hard
     * drift between it and `value`.
     *
     * `.inspect()` **always hits the network and bypasses the cache by default**, so it is a fresh probe
     * — *not* an observer of what your cached `await` call did. Pass `{ cache: true }` to honour the
     * cache policy (then `raw` is `null` on a hit). On a streaming surface `raw` is `null` too (no single
     * buffered body). ⚠️ `raw` is unredacted and non-enumerable — read `wrapper.raw` deliberately; never
     * log the whole wrapper.
     */
    inspect(
        ...args: [...Args<TIn>, opts?: InspectOptions]
    ): Promise<Inspection<TOut>>;
    with<const P extends Partial<TIn>>(
        partial: P,
    ): Stitch<TOut, RelaxKeys<TIn, keyof P>>;
    /**
     * Cache surface (ADR 0003). A no-op unless this stitch has a `cache` block.
     * - `invalidate(input)` — **exact** eviction of the one entry that `input` would hit.
     * - `cache.invalidate()` — **bulk** eviction of every entry this stitch produced (a
     *   per-stitch generation bump; prior entries become unreachable and TTL out).
     * - `cache.key(input)` — the derived opaque key, for introspection.
     */
    invalidate(input?: StitchInput): Promise<void>;
    readonly cache: {
        invalidate(): Promise<void>;
        key(input?: StitchInput): Promise<string | undefined>;
    };
    readonly __config: RedactedStitchConfig;
    readonly __stitch: true;
}

export function isStitch(x: unknown): x is Stitch {
    return (
        typeof x === 'function' &&
        (x as { __stitch?: boolean }).__stitch === true
    );
}

export function isSeam(x: unknown): x is Seam {
    return (
        typeof x === 'object' &&
        x !== null &&
        (x as { __seam?: boolean }).__seam === true
    );
}

// ---- Run identity (ADR 0007) ----------------------------------------------
/**
 * OTLP-aligned identity for one logical call ({@link Stitch} run) and its place in a run
 * tree. `runId` is the OTel **spanId**; `traceId` is shared across a whole tree; `parentId`
 * (the OTel **parentSpanId**) is set when one run spawns another — a `cookieSession` login,
 * a `linked` step. Minted by the engine (`newRunContext`), never supplied by a caller.
 */
export interface RunContext {
    /** 32-hex trace id, shared across every run in a tree. */
    traceId: string;
    /** 16-hex id for this run (the OTel spanId). */
    runId: string;
    /** The spawning run's `runId` (OTel parentSpanId); absent for a root run. */
    parentId?: string;
}

/**
 * The per-run metadata a {@link TraceSink} receives alongside every event: the stitch
 * `name` plus the run identity (ADR 0007). The id fields are present for every
 * engine-driven run, but **optional** so a sink fed events by hand (tests, custom
 * pipelines) can still pass just `{ name }`; a sink reading only `ctx.name` is unchanged.
 */
export interface TraceContext {
    name: string;
    runId?: string;
    traceId?: string;
    parentId?: string;
}

// A trace sink consumes every event a stitch emits.
export interface TraceSink {
    handle(event: StitchEvent, ctx: TraceContext): void;
    flush?(): void | Promise<void>;
}

// A pluggable state store for throttle counters + auth session/token state. Default is
// in-memory (single process). A Redis/Postgres adapter makes throttle distributed and
// sessions persistent/shared across workers — see DESIGN.md §13.
export interface StitchStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, ttlMs?: number): Promise<void>;
    incr(key: string, ttlMs: number): Promise<number>;
    /**
     * Release any resources (connections, timers) the store holds. Optional — the in-memory
     * default clears its map. A seam's `close()` calls this as the last lifecycle step.
     */
    close?(): Promise<void>;
}

// ---- Seam (a primitive stitches belong to) --------------------------------
/**
 * The config a seam shares with every member as a fragment — {@link StitchConfig} minus the keys
 * that are intrinsically **per-endpoint**: the address (`path` / `url` / `method` / `query`) and
 * the request/response shape (`name` / `input` / `output` / `kind`). Everything cross-cutting —
 * `baseUrl`, `headers`, `auth`, `retry`, `throttle`, `timeout`, `circuit`, `idempotency`,
 * `paginate`, `unwrap`, `transform`, `arrayFormat`, `hooks`, `trace`, `store`, `cache`, `adapter`
 * — belongs here, so the type itself answers "what belongs at the seam". Members set the endpoint
 * keys.
 */
export type SeamConfig = Omit<
    StitchConfig,
    'path' | 'url' | 'method' | 'query' | 'name' | 'input' | 'output' | 'kind'
>;

/**
 * Options for {@link Seam} — the shared {@link SeamConfig} plus an optional hardened `secretStore`
 * backing the vault.
 */
export type SeamOptions = SeamConfig & {
    /**
     * Backend for the vault (auth tokens/sessions). Defaults to a reserved, redacted namespace
     * over the seam's `store`; supply a KMS/Vault-backed store here for a hardened vault. Split
     * is by **visibility**, not backend — both store and vault may be distributed (ADR 0002 §4).
     */
    secretStore?: StitchStore;
};

/**
 * A principal-bound seam handle — what `seam.as(id)` returns, and the object trusted code hands to
 * the least-trusted caller (the agent). It creates member stitches and can re-bind the principal,
 * but deliberately **lacks the shared-runtime levers** (`flush` / `close` / `invalidate`): tearing
 * down, or invalidating the cache of, the runtime every other principal depends on is a *root-seam*
 * authority, never a per-principal one. The boundary that prevents impersonation must not also be a
 * teardown lever (ADR 0002 §2).
 */
export type PrincipalSeam = Omit<
    Seam,
    'as' | 'flush' | 'close' | 'invalidate'
> & {
    /** Re-bind to another principal — last binding wins. Still lifecycle-free. */
    as(principal: string): PrincipalSeam;
};

/**
 * A long-lived entity that owns a shared config fragment, shared runtime (`store` + `vault` +
 * trace sink), a registry of the stitches it created, and a lifecycle. Its decisive job is the
 * **trusted principal boundary**: `seam.as(req.user.id)` binds identity in the closure, so the
 * caller can never name another principal. Create shared surfaces with `seam`; standalone,
 * one-off endpoints stay on the low-level `stitch()` peer (ADR 0002).
 */
export interface Seam {
    /**
     * Create a stitch belonging to this seam — inherits the shared fragment and shares the
     * runtime. Like top-level `stitch`, the result type is inferred from `config.output`; pass an
     * explicit generic (`api.stitch<Foo>(...)`) only to override the inferred type.
     */
    stitch<
        TExplicit = never,
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /** Non-inferring fallback: a path string or a `string | Partial<StitchConfig>` value (see {@link StitchFn}). */
    stitch<T = unknown>(config: string | Partial<StitchConfig>): Stitch<T>;
    /** GraphQL-over-HTTP member stitch (POST `{ query, variables }`, unwrap `data`). */
    graphql<
        TExplicit = never,
        const C extends Partial<StitchConfig> & {
            query: string;
        } = Partial<StitchConfig> & {
            query: string;
        },
    >(
        config: C,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /**
     * Derive a principal-bound {@link PrincipalSeam} reusing the same shared runtime, but whose
     * stitches carry `principal` in their AuthContext: separate sessions per principal, one shared
     * throttle bucket. The principal lives in the returned closure, never in `StitchInput`
     * (ADR 0002 §2–3). The handle is **lifecycle-free** — only the root seam may `flush` / `close`
     * / `invalidate` the shared runtime.
     */
    as(principal: string): PrincipalSeam;
    /**
     * Bulk cache invalidation (ADR 0003) over the shared store this seam owns. With no argument
     * it bumps the **cache-wide** generation (every member stitch's entries become unreachable);
     * pass a member `stitch` to bump just that stitch's generation. A no-op for members without a
     * `cache` block. Exact, single-entry eviction stays on `stitch.invalidate(input)`.
     */
    invalidate(stitch?: Stitch): Promise<void>;
    /** Flush the shared trace sink (drain any buffered exporter). */
    flush(): Promise<void>;
    /** `flush()`, then close the shared store/vault and drop the registry. */
    close(): Promise<void>;
    /** The shared config fragment — redacted (no `store`/`vault`/`auth`/`adapter`). */
    readonly __config: RedactedStitchConfig;
    readonly __seam: true;
}

// CONTRACT.md P3 — deprecated alias, removed at the 1.0 GA cut.
/** @deprecated Renamed to {@link CacheOptions} (CONTRACT.md P3). Imported name kept until the 1.0 GA cut. */
export type CacheConfig = CacheOptions;
