/**
 * Fake-API simulator handler contract (frozen by C1, Wave 0).
 *
 * One handler definition, run by BOTH adapters — the browser `fetch`-shim
 * (S5) injected into the Web Worker scope, and the node `fetch`-shim used by
 * the deferred server isolate (SR1). Writing handlers once against this shape
 * is what guarantees the two runners are behaviour-equivalent (SANDBOX.md §4.1).
 *
 * Authored exactly per SANDBOX-IMPLEMENTATION-PLAN.md §3. Lower tiers (S2–S5)
 * implement `SimHandler`s against this; they do not edit it. See ./README.md.
 *
 * Pure TypeScript — no React, no runtime deps. `URL`, `Headers`, `Uint8Array`
 * and `AsyncIterable` are platform/lib globals shared by browser and node.
 */

/** A request, as the simulator sees it (after the fetch-shim normalises it). */
export interface SimRequest {
    method: string;
    url: URL;
    headers: Headers;
    /** Parsed/raw body when present; the handler decides how to read it. */
    body?: unknown;
}

/**
 * A simulated response. Exactly one of `body` / `stream` is meaningful per
 * response: `stream` is used for the chunked / SSE / LLM-token cases (S3),
 * `body` for ordinary JSON/text responses.
 */
export interface SimResponse {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    /**
     * Streaming payload for chunked / SSE / LLM responses. When present, the
     * adapter pipes these bytes to the snippet's `fetch` as a streamed body.
     */
    stream?: AsyncIterable<Uint8Array>;
}

/**
 * Reserved query knobs, parsed from the request URL's reserved `__`-prefixed
 * params (e.g. `?__status=500&__latencyMs=800&__stream=sse`). These select the
 * behaviour the playground wants to demonstrate (SANDBOX.md §4.2).
 */
export interface SimKnobs {
    /** `__status` — force this HTTP status. */
    status?: number;
    /** `__latencyMs` — delay the response by this many ms (deterministic). */
    latencyMs?: number;
    /** `__stream` — stream the body as raw chunks or as SSE token frames. */
    stream?: 'chunked' | 'sse';
    /** `__drift` — return a schema-drifted body so Zod validation fails visibly. */
    drift?: boolean;
    /** `__flaky` — fail the first N attempts, then succeed deterministically. */
    flaky?: number;
}

/**
 * A single simulator endpoint: decides whether it owns a request, then produces
 * the (possibly streamed) response for it. Handlers must be deterministic —
 * seeded PRNG only, no wall-clock / `Math.random` in output paths (SANDBOX.md §4.3).
 */
export interface SimHandler {
    match(req: SimRequest): boolean;
    handle(req: SimRequest, knobs: SimKnobs): SimResponse | Promise<SimResponse>;
}
