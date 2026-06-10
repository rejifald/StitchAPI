# Prototype module contracts

Exact signatures for the independently-built modules. Implement **only** your assigned
file. Import shared types from `./types` and helpers from `./util`. Do not edit other files.
Target: Node 24 (global `fetch`, `node:http`, `AbortController`), TypeScript transpiled by
babel (types erased — no `enum`, no parameter properties, no `const enum`).

---

## `src/resilience.ts`

```ts
import type { RetryOptions, ThrottleOptions } from './types';

export class TimeoutError extends Error {}

// Compute the backoff delay (ms) BEFORE the given attempt number (1-based:
// attempt=2 is the first retry). 'expo' = baseMs * 2^(attempt-2); 'expo-jitter'
// adds random jitter in [0, computed]; 'fixed' = baseMs. Clamp to maxMs.
// Defaults: backoff 'expo-jitter', baseMs 100, maxMs 10_000.
export function backoffDelay(attempt: number, opts?: RetryOptions): number;

// Parse a `Retry-After` header value (delta-seconds OR HTTP-date) into ms, or undefined.
export function parseRetryAfter(headerValue?: string): number | undefined;

// A proactive limiter. `rate` like "2/s" => min spacing between acquires;
// `concurrency` => max simultaneous in-flight. `acquire` resolves when a slot is free,
// reporting how long it waited; ALWAYS pair with `release`. Key allows per-host scoping.
export function createThrottle(opts?: ThrottleOptions): {
    acquire(key: string): Promise<{ waitedMs: number }>;
    release(key: string): void;
};

// Run `fn` with an AbortSignal that aborts after `ms`. On timeout, reject with
// TimeoutError and ensure the signal is aborted. If ms is undefined, just run fn().
export function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms?: number): Promise<T>;
```

Notes: use `parseRate`/`parseDuration`/`sleep` from `./util`. Jitter may use `Math.random()`.
For `concurrency`, queue waiters and resolve them FIFO as `release` is called. For `rate`,
track last-grant timestamp per key and delay to maintain spacing.

---

## `src/http-adapter.ts`

```ts
import type { Adapter, AdapterResponse } from './types';

// Returns an Adapter backed by global fetch. It must:
//  - send method, headers, and JSON-stringify a non-string body (setting
//    'content-type: application/json' when a body is present and no content-type given);
//  - pass through req.signal to fetch (for timeout/cancel);
//  - read the response, parse JSON when content-type is json (else keep text),
//    and return { status, headers (lowercased keys; multiple set-cookie joined with ', '),
//    body }. NEVER throw on non-2xx — return the AdapterResponse so the engine decides.
//    Only throw on network/abort errors.
export function fetchAdapter(): Adapter;
```

---

## `src/trace.ts`

```ts
import type { StitchEvent, TraceSink } from './types';

export interface TraceOptions {
    console?: boolean;      // pretty one-line-per-event to stderr (default true)
    file?: string | false;  // JSONL path; default `${process.env.HOME}/.stitch/runs/proto.jsonl`; false disables
}

// A sink that consumes every StitchEvent. `handle` appends a JSONL record
// `{ name, ...event }` to the file (create dir if needed) and, if console enabled,
// prints a compact colored line (e.g. "stitch listWebsites · request#1 · 200 · 42ms").
// Keep a file handle or append synchronously; expose flush().
export function createTrace(opts?: TraceOptions): TraceSink & { path: string | null };
```

Notes: import `appendFileSync`/`mkdirSync` from `node:fs`. Color via raw ANSI codes is fine;
no external deps. The drift event should render its level (error=red, warn=yellow, info=blue).

---

## `test/support/mock-server.ts`

Dependency-free (`node:http` only). **Do not import from `../src`.** A controllable HTTP
server so scenarios exercise real `fetch`.

```ts
export interface ReqInfo {
    method: string;
    path: string;                       // pathname only
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: unknown;                      // parsed JSON if possible
}

export interface RouteBehavior {
    // Status returned on successive calls; the LAST value repeats. e.g. [503,503,200].
    statuses?: number[];
    // Delay (ms) before responding; a single number or a per-call sequence.
    delayMs?: number | number[];
    // Response body. Object/array => JSON. A sequence returns body[callIndex] (last repeats)
    // — used to simulate drift. A function (callIndex, req) => body is also allowed.
    body?: unknown | unknown[] | ((callIndex: number, req: ReqInfo) => unknown);
    // If set, requests lacking this cookie get 401 (used for the auth-wall scenario).
    requireCookie?: { name: string; value?: string };
    // If set, requests lacking this header get 401.
    requireHeader?: { name: string; value?: string };
    // Set-Cookie on the response (used by the login route).
    setCookie?: { name: string; value: string };
    // Include a Retry-After header (seconds) — pairs with 429/503.
    retryAfter?: number;
    // Extra response headers.
    headers?: Record<string, string>;
}

export interface MockServer {
    url: string;                                 // e.g. http://127.0.0.1:54123
    route(method: string, path: string, behavior: RouteBehavior): void;
    calls(path?: string): ReqInfo[];             // recorded requests, for assertions
    callCount(path?: string): number;
    reset(): void;                               // clear routes + recorded calls
    close(): Promise<void>;
}

// Start on an ephemeral port (listen on 127.0.0.1:0) and resolve once listening.
export function startMockServer(): Promise<MockServer>;
```

Behavior details: track a per-route call counter (for `statuses`/`delayMs`/`body` sequences).
Default status 200, default body `{}`. Parse `?a=b` into `query`, `Cookie:` header into
`cookies`. Respond JSON with `content-type: application/json`. `requireCookie`/`requireHeader`
checks happen first (→ 401 `{ error: 'unauthorized' }`).
