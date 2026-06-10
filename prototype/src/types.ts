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
export type DriftChange = 'missing' | 'type-changed' | 'nullable' | 'new' | 'invalid';
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
export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form' | 'multipart';
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
export type ProgressPhase = 'auth' | 'request' | 'throttled' | 'retry' | 'paginate';
export type StitchEvent<T = unknown> =
    | { type: 'start'; name: string; method: string; url: string; input: StitchInput; at: number }
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
    | { type: 'error'; name: string; message: string; status?: number; attempts: number; at: number }
    | { type: 'done'; ok: boolean; ms: number; attempts: number; at: number };

// ---- Config & the Stitch callable ----------------------------------------
export interface InputSchemas {
    params?: Validator;
    query?: Validator;
    body?: Validator;
    headers?: Validator;
}
export interface StitchConfig {
    name?: string;
    kind?: 'http' | 'graphql';
    method?: string;
    bodyType?: 'json' | 'form' | 'multipart'; // request body encoding (default 'json')
    baseUrl?: string | (() => string);
    path?: string;
    headers?: Record<string, string>; // static default headers merged into every request
    query?: string; // GraphQL query string (kind: 'graphql')
    input?: InputSchemas;
    output?: Validator | DriftSpec;
    unwrap?: string;
    transform?: (body: unknown) => unknown | Promise<unknown>; // e.g. scrape HTML -> structured, before unwrap/validate
    auth?: AuthStrategy;
    retry?: RetryOptions;
    throttle?: ThrottleOptions;
    timeout?: TimeoutOptions;
    hooks?: Hooks;
    extends?: Array<Partial<StitchConfig> | Stitch>;
    adapter?: Adapter; // test seam / custom transport
    store?: StitchStore; // pluggable state store (throttle + session); default in-memory
}

export interface StitchResult<T> extends PromiseLike<T> {
    stream(): AsyncGenerator<StitchEvent<T>, void, unknown>;
}
export interface Stitch<T = unknown> {
    (input?: StitchInput): StitchResult<T>;
    stream(input?: StitchInput): AsyncGenerator<StitchEvent<T>, void, unknown>;
    with(partial: StitchInput): Stitch<T>;
    readonly __config: StitchConfig;
    readonly __stitch: true;
}

export function isStitch(x: unknown): x is Stitch {
    return typeof x === 'function' && (x as { __stitch?: boolean }).__stitch === true;
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
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown, ttlMs?: number): Promise<void>;
    incr(key: string, ttlMs: number): Promise<number>;
}
