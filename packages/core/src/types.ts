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
}

// ---- Drift ----------------------------------------------------------------
export type DriftLevel = 'error' | 'warn' | 'info';
export type DriftChange =
    | 'missing'
    | 'type-changed'
    | 'nullable'
    | 'new'
    | 'invalid';
export interface DriftFinding {
    level: DriftLevel;
    path: string;
    change: DriftChange;
    detail?: string;
}
export interface DriftOptions {
    critical?: string[]; // paths whose change is an error
    watch?: string[]; // paths whose change is a warning
    onNew?: DriftLevel; // level for brand-new fields (default 'info')
    snapshotFile?: string; // committed baseline (`<name>.contract.json`)
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
 */
export type StreamDecode = 'bytes' | 'lines' | 'ndjson';
export interface StreamOptions {
    /** Decoder for a `stream` surface body. Default `'bytes'` (total + lossless). */
    decode?: StreamDecode;
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
}
export type Adapter = (req: AdapterRequest) => Promise<AdapterResponse>;

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
    key?: (input: StitchInput) => string; // stable key per logical call (default: a random uuid)
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
export interface CacheConfig {
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
     * {@link CacheConfig.onUnfingerprintable} (default **refuse-to-cache**, fail-closed).
     */
    version?: string | number;
    /**
     * Version tag for an opaque `transform` (ADR 0004). A `transform` is a closure that cannot be
     * soundly hashed, so by default a stitch that has one **refuses to cache** (re-validation can't
     * detect a transform change). Set this to make the transform sound and re-enable caching; bump
     * it whenever the transform's behaviour changes. See also {@link CacheConfig.trustTransform}.
     */
    transformVersion?: string | number;
    /**
     * Opt in to caching despite an un-versioned `transform`, trusting that its output is stable for
     * the `ttl`. Weaker than {@link CacheConfig.transformVersion} (a transform change is invisible,
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
    /** Sugar: author the key seed from the input instead of deriving it from the request. */
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
    emit: (phase: ProgressPhase, detail?: string) => void;
    runLogin?: () => Promise<AdapterResponse>; // for cookieSession: invoke the login stitch
}
export interface AuthStrategy {
    name?: string;
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
      }
    | {
          type: 'progress';
          phase: ProgressPhase;
          attempt: number;
          detail?: string;
          waitedMs?: number;
          at: number;
      }
    | { type: 'drift'; finding: DriftFinding; at: number }
    | { type: 'delta'; chunk: unknown; at: number }
    | { type: 'result'; value: T; status: number; attempts: number; at: number }
    | {
          type: 'error';
          name: string;
          message: string;
          status?: number;
          attempts: number;
          at: number;
      }
    | { type: 'done'; ok: boolean; ms: number; attempts: number; at: number };

// ---- Config & the Stitch callable ----------------------------------------
// Each slot accepts any {@link SchemaLike} (raw Zod / Standard Schema / Validator / predicate) —
// no `toValidator()` cast required; `normalizeInput` coerces them at compose time.
export interface InputSchemas {
    params?: SchemaLike;
    query?: SchemaLike;
    body?: SchemaLike;
    headers?: SchemaLike;
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
     * (`'bytes'` default / `'lines'` / `'ndjson'`). Only meaningful for the `stream` surface.
     */
    stream?: StreamOptions;
    /** How to read the response body. Default: auto by content-type. */
    responseType?: ResponseType;
    /**
     * Full request endpoint as one string — the atomic spelling, when a stitch is exactly one
     * endpoint with no base to share. Templated (`{param}`, incl. the host) and `?query`-aware
     * like `path`; may be a thunk for lazy/env resolution. Mutually exclusive with
     * `baseUrl`/`path`: when both are set `url` wins, and across composed fragments the last
     * fragment to write either spelling wins the whole slot.
     */
    url?: string | (() => string);
    /** Origin for the request, as a string or a thunk resolved at call time. Ignored when `url` is set. */
    baseUrl?: string | (() => string);
    /** Path appended to `baseUrl`; may include `{param}` slots and a `?query` string. Ignored when `url` is set. */
    path?: string;
    /** Static default headers merged into every request. */
    headers?: Record<string, string>;
    /** GraphQL query string (`kind: 'graphql'`). */
    query?: string;
    /** Schemas validating params, query, body, and headers before the request. */
    input?: InputSchemas;
    /**
     * Response schema, or a {@link DriftSpec} for leveled drift detection. Accepts any
     * {@link SchemaLike} (raw Zod / Standard Schema / Validator / predicate); the stitch infers
     * its result type from it (see `InferOutput`), so a hand-written generic is rarely needed.
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
    /** Retry-and-backoff policy. */
    retry?: RetryOptions;
    /** Rate and concurrency limits. */
    throttle?: ThrottleOptions;
    /** Total and per-attempt timeouts. */
    timeout?: TimeoutOptions;
    /** Circuit breaker that fast-fails a repeatedly failing dependency. */
    circuit?: CircuitOptions;
    /** Inject a stable Idempotency-Key header on writes so safe retries don't duplicate. */
    idempotency?: IdempotencyOptions;
    /**
     * Read-through response cache + in-process coalescing (ADR 0003). Off unless set; the engine
     * is loaded lazily from the `stitchapi/cache` subpath only when this block is present.
     */
    cache?: CacheConfig;
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

export interface StitchResult<T> extends PromiseLike<T> {
    stream(): AsyncGenerator<StitchEvent<T>, void>;
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
    readonly __config: StitchConfig;
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

// A trace sink consumes every event a stitch emits.
export interface TraceSink {
    handle(event: StitchEvent, ctx: { name: string }): void;
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
        C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /** Non-inferring fallback: a path string or a `string | Partial<StitchConfig>` value (see {@link StitchFn}). */
    stitch<T = unknown>(config: string | Partial<StitchConfig>): Stitch<T>;
    /** GraphQL-over-HTTP member stitch (POST `{ query, variables }`, unwrap `data`). */
    graphql<
        TExplicit = never,
        C extends Partial<StitchConfig> & {
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
    readonly __config: StitchConfig;
    readonly __seam: true;
}
