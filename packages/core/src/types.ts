// Shared vocabulary for the prototype. Leaf modules (resilience, trace, http-adapter,
// auth, mock-server) and the engine all code against these types.
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
export interface DriftSpec {
    __kind: 'drift';
    schema: Validator;
    options: DriftOptions;
}

// ---- Adapter (HTTP kind) --------------------------------------------------
/** How to read the response body. Default (unset) = auto: JSON when the content-type is json-ish, else text. */
export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';
export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form' | 'multipart';
    responseType?: ResponseType;
    signal?: AbortSignal;
}
export interface AdapterResponse {
    status: number;
    headers: Record<string, string>;
    body: unknown; // parsed JSON when possible, else text
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

// ---- Auth -----------------------------------------------------------------
export interface AuthContext {
    store: StitchStore; // throttle/session state — in-memory by default, shareable when configured
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
    | 'circuit';
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
export interface InputSchemas {
    params?: Validator;
    query?: Validator;
    body?: Validator;
    headers?: Validator;
}
export interface StitchConfig {
    /** Label used in events and traces; defaults to `path` or `'stitch'`. */
    name?: string;
    /** Request kind. `'http'` (default) or `'graphql'` for a POST `{ query, variables }`. */
    kind?: 'http' | 'graphql';
    /** HTTP method; defaults to `GET`. */
    method?: string;
    /** Request body encoding. Default `'json'`. */
    bodyType?: 'json' | 'form' | 'multipart';
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
    /** Response schema, or a {@link DriftSpec} for leveled drift detection. */
    output?: Validator | DriftSpec;
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
    /** Request/response/error/retry lifecycle hooks. */
    hooks?: Hooks;
    /** Fragments to deep-merge under this config — strings, partials, or other stitches. */
    extends?: (Partial<StitchConfig> | Stitch | string)[];
    /** Test seam / custom transport. */
    adapter?: Adapter;
    /** Pluggable state store for throttle + session. Default in-memory. */
    store?: StitchStore;
}

export interface StitchResult<T> extends PromiseLike<T> {
    stream(): AsyncGenerator<StitchEvent<T>, void>;
}
export interface Stitch<T = unknown> {
    (input?: StitchInput): StitchResult<T>;
    stream(input?: StitchInput): AsyncGenerator<StitchEvent<T>, void>;
    with(partial: StitchInput): Stitch<T>;
    readonly __config: StitchConfig;
    readonly __stitch: true;
}

export function isStitch(x: unknown): x is Stitch {
    return (
        typeof x === 'function' &&
        (x as { __stitch?: boolean }).__stitch === true
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
}
