// The execution engine: turns a resolved config + input into a stream of typed events.
// `execute` is an async generator (start → progress → drift → result → done); the await
// path consumes it to the result. `executeRaw` runs the request once and returns the raw
// response (used by cookieSession to read Set-Cookie from a login stitch).
// Type-only: erased at compile time, so the cache engine is NOT statically bundled into core.
// The real module is reached via a lazy `import('./cache')` only when a stitch has a `cache`
// block (bundle-frugal gate — ADR 0003 decision 11).
import type { CacheController, CacheHit, RequestDescriptor } from './cache';
import { compact } from './compact';
import { classifyDiff, validationErrors } from './drift';
import { fetchAdapter } from './http-adapter';
import {
    CircuitOpenError,
    RateLimitError,
    TimeoutError,
    acceptsStatus,
    backoffDelay,
    createCircuit,
    parseRetryAfter,
    withTimeout,
} from './resilience';
import { vaultView } from './store';
import { classifyStatus, flagFinding, interpretOf } from './surface';
import type { Surface, SurfaceOutcome } from './surface';
import type {
    AcquireOptions,
    Adapter,
    AdapterRequest,
    AdapterResponse,
    AuthContext,
    Clock,
    DriftFinding,
    DriftSpec,
    ResolvedStitchConfig,
    RunContext,
    StitchEvent,
    StitchInput,
    StitchStore,
    TraceSink,
} from './types';
import { StitchError } from './types';
import {
    appendQueryString,
    buildQuery,
    expandPath,
    getPath,
    newRunContext,
    now,
    parseDuration,
    systemClock,
    topLevelQueryIndex,
} from './util';
import type { Validator } from './validator';

// Browser-safe UUID for Idempotency-Key: crypto.randomUUID where available (Node ≥ 19,
// secure browser contexts), else a Math.random v4 — uniqueness, not secrecy, is the need.
function randomUUID(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = Math.floor(Math.random() * 16);
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export interface Runtime {
    cfg: ResolvedStitchConfig;
    adapter: Adapter;
    throttle: {
        acquire(
            key: string,
            opts?: AcquireOptions,
        ): Promise<{ waited: number }>;
        release(key: string): void;
    };
    trace: TraceSink;
    store: StitchStore;
    clock: Clock;
    authCtx: AuthContext;
    /** Lazily-initialised cache controller (ADR 0003). Memoised so all calls of one stitch share
     *  a single coalescer + LRU; the `import('./cache')` fires once, only for a cached stitch. */
    cacheInit?: Promise<CacheController>;
}

export function makeRuntime(
    cfg: ResolvedStitchConfig,
    throttle: Runtime['throttle'],
    trace: TraceSink,
    store: StitchStore,
    opts?: { vault?: StitchStore; principal?: string; clock?: Clock },
): Runtime {
    const authCtx: AuthContext = {
        store,
        // Secrets live in the vault, off `__config` and redacted from traces. Standalone stitches
        // get a reserved namespace over their own store; a seam injects its shared vault.
        vault: opts?.vault ?? vaultView(store),
        emit: () => {
            /* progress surfaces via yielded events, not authCtx */
        },
    };
    // The principal is set only when a seam binds one — it is never sourced from StitchInput.
    if (opts?.principal !== undefined) authCtx.principal = opts.principal;
    return {
        cfg,
        adapter: cfg.adapter ?? fetchAdapter(),
        throttle,
        trace,
        store,
        clock: opts?.clock ?? systemClock,
        authCtx,
    };
}

// A per-call view of the shared `authCtx` whose `emit` collects `info` events into `sink`. The
// Runtime (and its `authCtx`) is shared across a stitch's concurrent calls, so the buffer must be
// per-call: spread a fresh ctx (sharing store/vault/principal) with a private emit, run the
// strategy, then yield whatever it announced. `apply`/`refresh` are plain async fns and can't yield.
function emitInto(
    authCtx: AuthContext,
    sink: StitchEvent[],
    run: RunContext,
): AuthContext {
    return {
        ...authCtx,
        // The current run (ADR 0007) so a strategy that spawns a sub-call — `cookieSession`'s
        // login — can run it as a CHILD of this run (parentSpanId = run.spanId).
        run,
        emit: (topic, detail) =>
            sink.push(
                compact({
                    type: 'info',
                    topic,
                    detail,
                    at: now(),
                }),
            ),
    };
}

const nameOf = (cfg: ResolvedStitchConfig) => cfg.name ?? cfg.path ?? 'stitch';

function joinUrl(base: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (!base) return path;
    // Strip trailing slashes from base with a linear scan rather than a regex.
    // `/\/+$/` backtracks polynomially on an all-slashes string (js/polynomial-redos);
    // this loop is O(n) and behaviourally identical (drops the whole trailing run).
    let end = base.length;
    while (end > 0 && base[end - 1] === '/') end--;
    return base.slice(0, end) + (path.startsWith('/') ? path : '/' + path);
}

// Inject a stable Idempotency-Key on writes. The key is computed once per logical call (here,
// in buildRequest) and the attempt loop reuses the same request, so it stays constant across
// retries. GET/HEAD are skipped, and a caller-provided header (case-insensitive) wins.
function applyIdempotency(
    cfg: ResolvedStitchConfig,
    input: StitchInput,
    method: string,
    headers: Record<string, string>,
): void {
    if (!cfg.idempotency) return;
    if (method === 'GET' || method === 'HEAD') return; // writes only
    const header = cfg.idempotency.header ?? 'Idempotency-Key';
    if (
        Object.keys(headers).some(
            (h) => h.toLowerCase() === header.toLowerCase(),
        )
    )
        return;
    const keyOf = cfg.idempotency.keyOf;
    headers[header] = keyOf ? keyOf(input) : randomUUID();
}

const resolveStr = (v: string | (() => string) | undefined): string =>
    typeof v === 'function' ? v() : (v ?? '');

function buildRequest(
    cfg: ResolvedStitchConfig,
    input: StitchInput,
): AdapterRequest {
    // Endpoint resolution: when `url` is set it IS the whole endpoint (no base), but still
    // templated + query-split like a path. Otherwise join `baseUrl` + `path`. (Surface-specific
    // shaping — graphql's body/method/`/graphql` default — is applied below / by its helper.)
    const usingUrl = cfg.url !== undefined;
    const base = usingUrl ? '' : resolveStr(cfg.baseUrl);
    const raw = usingUrl ? resolveStr(cfg.url) : (cfg.path ?? '');
    // Split off a literal `?predefined=query` (brace-aware, so a `{?x}` template operator
    // isn't mistaken for it); the template part is expanded, the rest are query defaults.
    const qIdx = topLevelQueryIndex(raw);
    let tpl = raw;
    let predefined: Record<string, unknown> = {};
    if (qIdx >= 0) {
        tpl = raw.slice(0, qIdx);
        predefined = Object.fromEntries(
            new URLSearchParams(raw.slice(qIdx + 1)) as unknown as Iterable<
                [string, string]
            >,
        );
    }
    const path = expandPath(tpl, input.params ?? {});
    const query = { ...predefined, ...(input.query ?? {}) };
    const url = appendQueryString(
        joinUrl(base, path),
        buildQuery(query, cfg.wire?.array),
    );
    // A relative endpoint can't be fetched by the default transport — fail with a clear config
    // error here instead of a cryptic "Failed to parse URL" from fetch. A custom `adapter` OR a
    // surface that replaces the transport (`cfg.kind.execute`, ADR 0008 — e.g. `shell`, whose
    // "url" is a `shell:` pseudo-endpoint) may legitimately use a non-http URL, so this only
    // guards the default HTTP transport.
    if (
        cfg.adapter === undefined &&
        cfg.kind.execute === undefined &&
        !/^https?:\/\//i.test(url)
    ) {
        // A relative `url` set alongside a `baseUrl` is the common footgun: `url` is the whole
        // endpoint and ignores `baseUrl`, so the base is never joined — they almost certainly
        // meant `path`. Point straight at that instead of the generic guidance.
        const hint =
            cfg.url !== undefined && cfg.baseUrl !== undefined
                ? 'A relative `url` does NOT join `baseUrl` — `url` is the whole endpoint, so `baseUrl` is ignored. Pass the relative endpoint as `path` instead.'
                : 'Set `url` to a full endpoint, or give a relative `path` a `baseUrl` (e.g. from a shared fragment).';
        const e = new Error(
            `stitch ${JSON.stringify(nameOf(cfg))}: request URL ${JSON.stringify(url)} is not absolute. ` +
                hint,
        );
        e.name = 'StitchConfigError';
        throw e;
    }
    const method = (cfg.method ?? 'GET').toUpperCase();
    const headers = { ...(cfg.headers ?? {}), ...(input.headers ?? {}) };
    let req: AdapterRequest = compact({
        url,
        method,
        headers,
        body: input.body,
        // The `wire` envelope is the AUTHORING shape; `AdapterRequest` stays flat, and
        // `responseType` keeps the XHR/fetch spelling at that boundary (CONTRACT.md P22 — follow
        // the standard that governs each layer, and convert at the edge). This IS that edge.
        bodyType: cfg.wire?.body,
        multipart: cfg.wire?.multipart,
        // Read by the transport only for a `'form'` body; the query string was already serialised
        // into `url` above, by the same walker and the same `wire.array`.
        arrayFormat: cfg.wire?.array,
        responseType: cfg.wire?.response,
    });
    // Per-call execution controls (ADR 0005 Decisions 8-9): cancellation + byte progress, threaded
    // BEFORE the surface shapes the request so a surface that spreads `base` (e.g. `download`)
    // keeps them. Runtime-only — they never came from `__config`.
    if (input.signal) req.signal = input.signal;
    if (input.onProgress) req.onProgress = input.onProgress;
    // The surface shapes the request (graphql packs { query, variables } + forces POST, …);
    // absent, the http identity above stands.
    if (cfg.kind.buildRequest) req = cfg.kind.buildRequest(cfg, input, req);
    // Idempotency runs AFTER surface shaping so a surface that forces a write still gets a key.
    applyIdempotency(cfg, input, req.method, req.headers);
    return req;
}

const cloneReq = (r: AdapterRequest): AdapterRequest => ({
    ...r,
    headers: { ...r.headers },
});
const hostKey = (req: AdapterRequest, cfg: ResolvedStitchConfig): string => {
    if (cfg.throttle?.pool === 'host') {
        try {
            return new URL(req.url).host;
        } catch {
            /* fall through */
        }
    }
    return nameOf(cfg);
};

// A non-enumerable back-reference from an `error` event to the live error instance it was built
// from. Used ONLY for a RateLimitError so the awaited path can re-throw the REAL instance — keeping
// its `response` and class identity — rather than a flattened StitchError. Non-enumerable means it
// never reaches a trace sink (which serialises via Object.entries / JSON.stringify, both of which
// skip it), so the full `response` can't leak into a JSONL/console log. See `drain` in stitch.ts.
export const ERROR_SOURCE = Symbol('stitch.errorSource');

// A non-enumerable channel for the retained pre-validation body (`.inspect()`, ADR 0016). Like
// ERROR_SOURCE, non-enumerable means a trace sink (Object.entries / JSON.stringify) never sees it, so
// the unredacted body can't leak into a JSONL/console log. Rides the `result` event on the success
// path and the pinned StitchError (via ERROR_SOURCE) on the hard-fail path; read by `.inspect()` only.
export const RAW_BODY = Symbol('stitch.rawBody');

// Per-call run flags (ADR 0016), threaded into `execute` by `.inspect()`. `retainRaw` retains the
// pre-validation body and surfaces it on the terminal event; `bypassCache` skips the cache entirely
// (neither read nor write). Both default off, so the await/safe/stream paths are byte-identical.
export interface RunFlags {
    retainRaw?: boolean;
    bypassCache?: boolean;
}

// Mutable per-run state threaded through the run functions. `attempts` is the live attempt counter
// the events stamp; `retainRaw` (ADR 0016) is the per-call request to surface the raw body.
interface RunState {
    attempts: number;
    retainRaw?: boolean;
}

// Attach the retained raw body to a terminal `result` event on the non-enumerable RAW_BODY channel —
// only when `.inspect()` asked for it (`state.retainRaw`). A no-op otherwise, so the await/safe path
// yields a byte-identical event. The body never serialises into a trace sink (non-enumerable).
function withRaw(ev: StitchEvent, state: RunState, raw: unknown): StitchEvent {
    if (state.retainRaw)
        Object.defineProperty(ev, RAW_BODY, { value: raw, enumerable: false });
    return ev;
}

// The contract-violation (hard drift) error event. When `.inspect()` asked to retain the raw body,
// pin a StitchError carrying it (on RAW_BODY) via the ERROR_SOURCE channel, so `.inspect()` recovers
// the body the failure path would otherwise drop (ADR 0016, required engine change). Without
// `retainRaw` the event is identical to before — no source pinned — so the await/safe path rebuilds
// its own StitchError exactly as it did pre-0016.
function contractViolationEvt(
    name: string,
    status: number,
    state: RunState,
    raw: unknown,
): StitchEvent {
    const evt: Extract<StitchEvent, { type: 'error' }> = {
        type: 'error',
        name,
        message: 'contract violation (drift)',
        status,
        attempts: state.attempts,
        at: now(),
    };
    if (state.retainRaw) {
        const err = new StitchError('contract violation (drift)', {
            status,
            attempts: state.attempts,
        });
        Object.defineProperty(err, RAW_BODY, { value: raw, enumerable: false });
        Object.defineProperty(evt, ERROR_SOURCE, {
            value: err,
            enumerable: false,
        });
    }
    return evt;
}

function errEvt(err: unknown, name: string, attempts: number): StitchEvent {
    const e = err as { message?: string; status?: number };
    const evt: Extract<StitchEvent, { type: 'error' }> = {
        type: 'error',
        name,
        message: e.message ?? String(err),
        attempts,
        at: now(),
    };
    if (e.status !== undefined) evt.status = e.status;
    // Delegate-backoff signal: stamp the structured `retryAfter` onto the event (so `.stream()`
    // consumers get it) and pin the live RateLimitError so the awaited path re-throws it intact.
    // ORDER IS LOAD-BEARING: a RateLimitError also carries `.response`, so the generic arm below
    // would swallow it (and drop `retryAfter`) if this subclass test did not come first.
    if (err instanceof RateLimitError) {
        if (err.retryAfter !== undefined) evt.retryAfter = err.retryAfter;
        Object.defineProperty(evt, ERROR_SOURCE, {
            value: err,
            enumerable: false,
        });
    } else if ((err as { response?: AdapterResponse }).response !== undefined) {
        // HTTP failure (issue #155): the thrown error carries the full `.response` (body + url).
        // Pin it on the SAME non-enumerable channel so `drain`/`asStitchError` can populate
        // `StitchError.body`/`.url`. Non-enumerable ⇒ the body never serialises into a trace sink
        // (privacy preserved); the enumerable `status`/`message` are all a sink sees.
        Object.defineProperty(evt, ERROR_SOURCE, {
            value: err,
            enumerable: false,
        });
    }
    return evt;
}
const doneEvt = (ok: boolean, t0: number, attempts: number): StitchEvent => ({
    type: 'done',
    ok,
    elapsed: now() - t0,
    attempts,
    at: now(),
});

// Validate the call input against the declared per-slot schemas and RETURN the input the request is
// built from. On success a declared slot's PARSED value replaces the one the caller passed —
// coerced, defaulted, stripped — so the request matches the declared contract, which is the same
// rule `validateValue` states for `output` (ADR 0015). Before issue #648 this returned `void` and
// dropped `r.value`, so a schema gated the call without shaping it: the unparsed input went on the
// wire, and an unknown `?tenant=` a caller tacked on still overwrote one pinned in the endpoint.
//
// It filters; it does not lock down. A slot with NO schema is untouched — an undeclared slot stays
// the full passthrough it has always been (a schema constrains one slot, not the call). The parsed
// values land in a COPY: the caller still holds the object it passed, so filtering the request can
// never rewrite a bound partial or a literal reused across a loop.
async function validateInput(
    cfg: ResolvedStitchConfig,
    input: StitchInput,
): Promise<StitchInput> {
    if (!cfg.input) return input;
    const out = { ...input } as Record<string, unknown>;
    for (const part of [
        'params',
        'query',
        'body',
        'headers',
        'variables',
    ] as const) {
        // `input.*` is widened to SchemaLike for authoring ergonomics, but `compose` →
        // `normalizeInput` has already coerced every present slot to a Validator by now.
        // `variables` (the graphql surface's primary input) validates here too, and its parsed
        // value reaches the `{ query, variables }` body because the surface's `buildRequest` is
        // handed THIS object. An absent optional slot parses to `undefined`, which leaves the
        // surface's `input.variables ?? input.body` fallback intact.
        const v = cfg.input[part] as Validator | undefined;
        if (!v) continue;
        const r = await v.validate(out[part]);
        if (!r.ok) {
            const e = new Error(
                `invalid ${part}: ${r.issues.map((i) => i.message).join(', ')}`,
            );
            e.name = 'ValidationError';
            throw e;
        }
        out[part] = r.value;
    }
    return out;
}

// Validate ONE value against the output schema (ADR 0015). On success returns the PARSED value —
// coerced, defaulted, stripped — so the result matches the declared contract; on failure returns the
// hard `error`/`invalid` findings that fail the call. Natural variance an honest schema permits
// (optional absent, nullable null, empty/heterogeneous arrays) validates clean and yields nothing.
async function validateValue(
    cfg: ResolvedStitchConfig,
    value: unknown,
): Promise<{ value: unknown; errors: DriftFinding[] }> {
    const out = cfg.output;
    if (!out) return { value, errors: [] };
    // Probe cast keeps `__kind` `unknown`, so this is a real comparison — not an always-true
    // check against the `'drift'` literal (the idiom used by `outputSchemaSource`).
    const isDrift = (out as { __kind?: unknown }).__kind === 'drift';
    const validator: Validator = isDrift
        ? (out as DriftSpec).schema
        : (out as Validator);
    const r = await validator.validate(value);
    if (r.ok) return { value: r.value, errors: [] };
    return { value, errors: validationErrors(r.issues) };
}

// Buffered output check: validate `raw` (→ the parsed value), then — when wrapped in `drift()` — diff
// the raw body against the validated value for soft drift (undeclared / coerced / defaulted). Returns
// the VALIDATED value as the result (sound; matches the contract) plus all findings. A validation
// failure short-circuits with the hard `error` findings and the raw value (the call will fail).
async function validateOutput(
    cfg: ResolvedStitchConfig,
    raw: unknown,
): Promise<{ value: unknown; findings: DriftFinding[] }> {
    const out = cfg.output;
    if (!out) return { value: raw, findings: [] };
    const { value: validated, errors } = await validateValue(cfg, raw);
    if (errors.length) return { value: raw, findings: errors };
    if ((out as { __kind?: unknown }).__kind === 'drift')
        return {
            value: validated,
            findings: classifyDiff(raw, validated, (out as DriftSpec).options),
        };
    return { value: validated, findings: [] };
}

// `timeout.total` is a WALL-CLOCK budget for the whole logical call: every attempt,
// backoff sleep, and throttle wait counts against one shared deadline (GAP-AUDIT §1.1).
interface TotalBudget {
    deadline: number; // epoch ms after which the call must fail with a timeout
    total: number; // configured total (ms), kept for the error message
}

function totalBudget(
    cfg: ResolvedStitchConfig,
    t0: number,
): TotalBudget | undefined {
    const total = parseDuration(cfg.timeout?.total);
    return total == null ? undefined : { deadline: t0 + total, total };
}

const budgetError = (b: TotalBudget): TimeoutError =>
    new TimeoutError(`timed out after ${b.total}ms`);

// Sleep `ms`, but never past the budget's deadline — when the budget would run out
// mid-wait, wait only the remainder and fail with the timeout error. The caller's
// `signal` (if any) is threaded into `sleep` so an abort interrupts a retry/reconnect
// backoff PROMPTLY (clearing the timer) instead of sleeping out the full delay.
async function sleepWithin(
    ms: number,
    budget?: TotalBudget,
    signal?: AbortSignal,
    clock: Clock = systemClock,
): Promise<void> {
    if (budget == null) return clock.sleep(ms, signal);
    // `timeout.total` stays on wall-clock — its deadline is not driven by the injected clock.
    const remaining = budget.deadline - now();
    if (remaining <= ms) {
        if (remaining > 0) await clock.sleep(remaining, signal);
        throw budgetError(budget);
    }
    return clock.sleep(ms, signal);
}

// Acquire a throttle slot, but never wait past the budget's deadline — and bail PROMPTLY if the
// caller's `signal` aborts mid-wait (a throttle acquire can sleep for the rate spacing). The
// underlying acquire has no abort path, so on either interrupt the still-pending grant is handed
// straight back via release() to keep the limiter's accounting intact.
async function acquireWithin(
    throttle: Runtime['throttle'],
    key: string,
    budget?: TotalBudget,
    opts?: AcquireOptions,
    signal?: AbortSignal,
): Promise<{ waited: number }> {
    if (signal?.aborted) throw abortReason(signal);
    if (budget == null && signal === undefined)
        return throttle.acquire(key, opts);
    if (budget && budget.deadline - now() <= 0) throw budgetError(budget);
    const pending = throttle.acquire(key, opts);
    // Hand a still-pending grant back to the limiter when we abandon the wait. A rate-only acquire
    // (streaming, Decision 12) holds no concurrency slot, so there is nothing to return.
    const handBack = (): void => {
        if (!opts?.rateOnly)
            void pending.then(
                () => {
                    throttle.release(key);
                },
                () => {
                    /* a rejected acquire holds no slot */
                },
            );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupt = new Promise<never>((_, reject) => {
        if (budget) {
            timer = setTimeout(() => {
                handBack();
                reject(budgetError(budget));
            }, budget.deadline - now());
        }
        if (signal) {
            onAbort = () => {
                handBack();
                reject(abortReason(signal));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    try {
        return await Promise.race([pending, interrupt]);
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
}

// The Error to reject with when a caller's signal is already/just aborted — its own `reason` when
// that is an Error (the default AbortError, or a caller-supplied one), else a generic abort Error.
function abortReason(signal: AbortSignal): Error {
    const reason: unknown = signal.reason;
    return reason instanceof Error
        ? reason
        : new Error('the operation was aborted');
}

// Materialize a streaming-path error body for StitchError.body. A streaming adapter hands back the
// live `ReadableStream` unparsed (so it can be decoded into deltas); on the error branch the stream
// is never decoded, so read it to text and best-effort JSON-parse it — the same shape the buffered
// path produces. A non-stream body (an adapter that already buffered) passes through unchanged; a
// read failure degrades to `undefined` rather than throwing over the original HTTP error.
async function drainErrorBody(body: unknown): Promise<unknown> {
    if (
        body == null ||
        typeof (body as ReadableStream<Uint8Array>).getReader !== 'function'
    ) {
        return body; // already buffered/parsed (or empty) — nothing to drain.
    }
    try {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        let text = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // After `done` is false, `value` is a Uint8Array (never undefined).
            text += dec.decode(value, { stream: true });
        }
        text += dec.decode();
        if (text === '') return undefined;
        try {
            return JSON.parse(text);
        } catch {
            return text; // not JSON — keep the raw text payload.
        }
    } catch {
        return undefined; // body already consumed / errored — don't mask the HTTP error.
    }
}

/**
 * What an attempt settles on: the raw response (still needed for its status/headers/url — the
 * result event, the cache entry's `vary`, the paginator's `lastStatus`) together with the surface's
 * verdict on it. Since ADR 0022 Decision 1 the verdict is rendered INSIDE the loop, so a surface
 * can see a non-2xx and — from step 4 — ask for another attempt.
 *
 * A `!ok` outcome here is always an APPLICATION-level rejection of a well-formed response: a
 * transport-level failure threw instead, back at the terminal-verdict site.
 */
interface AttemptResult {
    res: AdapterResponse;
    outcome: SurfaceOutcome;
}

async function* attemptLoop(
    rt: Runtime,
    baseReq: AdapterRequest,
    state: RunState,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, AttemptResult> {
    const { cfg } = rt;
    const max = cfg.retry?.attempts ?? 1;
    // P7: `retry.on` accepts a status list OR a predicate — normalize to one matcher.
    const retryMatch = acceptsStatus(cfg.retry?.on ?? [429, 502, 503, 504]);
    const eachMs = parseDuration(cfg.timeout?.each);
    const key = hostKey(baseReq, cfg);
    let refreshed = false;
    // Delegate-backoff mode (issue #145, folded into `throttle` — P14): the host owns the gate. We
    // bypass the internal throttle for the call (no acquire/release, so `throttle` is inert and no
    // `throttled` event fires) and, on a response whose status matches `rlMatch` (default [429]),
    // surface a RateLimitError instead of retrying. Everything else — auth, the success path,
    // non-rate-limit failures — is unchanged.
    const delegate = cfg.throttle?.delegate === true;
    const rlMatch = acceptsStatus(cfg.throttle?.on ?? [429]);

    for (let attempt = 1; attempt <= max; attempt++) {
        state.attempts = attempt;
        // Skip the throttle entirely in delegate mode — the outer gate paces the call, so acquiring
        // here would double-count against it (the bug this mode fixes).
        if (!delegate) {
            const { waited } = await acquireWithin(
                rt.throttle,
                key,
                budget,
                undefined,
                baseReq.signal,
            );
            if (waited > 0)
                yield {
                    type: 'progress',
                    phase: 'throttled',
                    attempt,
                    waited,
                    at: now(),
                };
        }
        try {
            const req = cloneReq(baseReq);
            if (cfg.auth) {
                const infos: StitchEvent[] = [];
                await cfg.auth.apply(req, emitInto(rt.authCtx, infos, run));
                yield* infos;
            }
            await cfg.hooks?.onRequest?.({ name: nameOf(cfg), attempt, req });
            yield { type: 'progress', phase: 'request', attempt, at: now() };

            // Clamp this attempt's abort to whatever is left of the total budget.
            const attemptMs =
                budget == null
                    ? eachMs
                    : Math.min(
                          eachMs ?? Infinity,
                          Math.max(0, budget.deadline - now()),
                      );
            // A surface may REPLACE the transport (ADR 0008): `cfg.kind.execute` runs here instead
            // of the HTTP adapter, still inside the resilience chain (retry/throttle/circuit/
            // timeout/trace/auth all wrap it). Absent, the ordinary HTTP adapter runs.
            const transport = cfg.kind.execute ?? rt.adapter;
            let res: AdapterResponse;
            try {
                res = await withTimeout(
                    (signal) => transport({ ...req, signal }),
                    attemptMs,
                    req.signal, // link a caller's AbortSignal (e.g. a download's) to this attempt
                    rt.clock,
                );
            } catch (err) {
                await cfg.hooks?.onError?.({
                    name: nameOf(cfg),
                    attempt,
                    error: err,
                });
                if (attempt < max) {
                    yield {
                        type: 'progress',
                        phase: 'retry',
                        attempt,
                        detail: String((err as Error)?.message ?? err),
                        at: now(),
                    };
                    await cfg.hooks?.onRetry?.({
                        name: nameOf(cfg),
                        attempt,
                        error: err,
                    });
                    await sleepWithin(
                        backoffDelay(attempt + 1, cfg.retry),
                        budget,
                        baseReq.signal,
                        rt.clock,
                    );
                    continue;
                }
                throw err;
            }

            await cfg.hooks?.onResponse?.({ name: nameOf(cfg), attempt, res });

            if (
                cfg.auth?.shouldRefresh?.(res) &&
                !refreshed &&
                cfg.auth.refresh
            ) {
                refreshed = true;
                yield {
                    type: 'progress',
                    phase: 'auth',
                    attempt,
                    detail: 'refresh',
                    at: now(),
                };
                const infos: StitchEvent[] = [];
                await cfg.auth.refresh(emitInto(rt.authCtx, infos, run));
                yield* infos;
                attempt--; // redo this attempt with fresh auth, don't count it
                continue;
            }

            // Delegate-backoff: a rate-limit status is NOT retried — surface it so the host's outer
            // gate owns the backoff. Checked BEFORE the internal retry-on-status path so it wins even
            // when the same status is also in `retry.on` (the common `429` overlap). `Retry-After` is
            // parsed with the same helper the internal retry uses, so the host gets an identical hint.
            if (delegate && rlMatch(res.status)) {
                throw new RateLimitError({
                    status: res.status,
                    retryAfter: parseRetryAfter(
                        res.headers['retry-after'],
                        rt.clock,
                    ),
                    response: res,
                    attempts: attempt,
                });
            }

            if (retryMatch(res.status) && attempt < max) {
                // `!== false`, not a truthy check: `retry.respect` defaults ON. The server's stated
                // wait beats a curve we guessed, and the default `on` set is exactly the statuses
                // the header exists for. Only an explicit `false` forces the computed backoff.
                // Unbounded by design — `sleepWithin` already caps every wait at `timeout.total`.
                const ra =
                    cfg.retry?.respect !== false
                        ? parseRetryAfter(res.headers['retry-after'], rt.clock)
                        : undefined;
                yield {
                    type: 'progress',
                    phase: 'retry',
                    attempt,
                    detail: `status ${res.status}`,
                    at: now(),
                };
                await cfg.hooks?.onRetry?.({ name: nameOf(cfg), attempt, res });
                await sleepWithin(
                    ra ?? backoffDelay(attempt + 1, cfg.retry),
                    budget,
                    baseReq.signal,
                    rt.clock,
                );
                continue;
            }

            // ── THE TERMINAL VERDICT (ADR 0022 Decision 1) ────────────────────────────────────
            // The surface interprets EVERY response here, including the non-2xx the engine used to
            // throw on before any hook could see it. It sits after the retry-on-status path, so
            // `retry.on` still wins while attempts remain (retried, then accepted on the final
            // attempt — case D of accept-status.spec.ts), and it runs once per attempt rather than
            // once per run only because steps 2–4 above `continue` before reaching it.
            const outcome = interpretOf(cfg.kind)(res, cfg);

            // The BODY-AWARE RETRY (ADR 0022 Decision 5, issue #529). A surface that read the body
            // can ask for another attempt — a `200` carrying `{ status: 'PENDING' }`, an in-payload
            // rate limit. It shares `retry.attempts` (one budget is easier to reason about than
            // two), so `attempt < max` is the same condition the status-driven path above uses, and
            // exhausting it falls through to the ordinary failure handling below.
            //
            // The `retry` detail is distinguishable from the status path's `status NNN` so a trace
            // consumer can tell a body-driven re-attempt from a status-driven one.
            if (!outcome.ok && 'retry' in outcome && attempt < max) {
                yield {
                    type: 'progress',
                    phase: 'retry',
                    attempt,
                    detail: `interpret: ${outcome.message}`,
                    at: now(),
                };
                await cfg.hooks?.onRetry?.({ name: nameOf(cfg), attempt, res });
                await sleepWithin(
                    // `parseDuration`, not the raw value: `after` is authored by a surface, so it
                    // takes the house duration form (`500`, `'5s'`) like every other authored
                    // duration. An unparseable value falls through to the computed backoff.
                    parseDuration(outcome.after) ??
                        backoffDelay(attempt + 1, cfg.retry),
                    budget,
                    baseReq.signal,
                    rt.clock,
                );
                continue;
            }

            // A failed verdict routes on WHAT failed, which is what keeps `circuit` behaviour
            // unchanged (this ADR promises it does not move). The circuit tracks TRANSPORT health:
            //
            //   • the status itself failed → throw, exactly as before. The throw carries `.response`
            //     so `StitchError` keeps its `body`/`url`, and it propagates through
            //     `attemptWithCircuit`, which records a circuit failure.
            //   • a well-formed response the SURFACE rejected (graphql's 200-with-`errors`) → return
            //     the outcome. An application-level rejection is not a host-health signal, and one
            //     bad query must not open the circuit for every other call to that host. This is the
            //     behaviour today's ordering produced by accident; routing here makes it deliberate.
            //
            // `classifyStatus` — the STATUS, not the full verdict — because the question here is
            // "did the transport report a failure?", and only the status answers that. Asking the
            // body-aware `verdictOf` would route a falsy `verdict.flag` on a healthy `200` as a
            // transport failure and open the circuit on it, which is the same mistake as tripping
            // the breaker on graphql's `errors`. It honours `verdict.accept`, so a declared 404 the
            // surface later rejects on body grounds stays off the circuit too.
            if (!outcome.ok && classifyStatus(res.status, cfg)) {
                const e = new Error(outcome.message) as Error & {
                    status: number;
                    response: AdapterResponse;
                };
                e.status = res.status;
                e.response = res;
                throw e;
            }
            return { res, outcome };
        } finally {
            // No release in delegate mode — we never acquired a slot (the host owns the gate).
            if (!delegate) rt.throttle.release(key);
        }
    }
    throw new Error('retry attempts exhausted');
}

// Wraps attemptLoop with a circuit breaker (when configured). When the breaker is OPEN it
// fast-fails BEFORE any network call (emitting a `circuit` progress event), so a failing
// dependency stops being hammered; a success closes it, a failure (re)opens it. With no
// `circuit` config this is a transparent pass-through.
async function* attemptWithCircuit(
    rt: Runtime,
    baseReq: AdapterRequest,
    state: RunState,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, AttemptResult> {
    const { cfg } = rt;
    if (!cfg.circuit) {
        return yield* attemptLoop(rt, baseReq, state, run, budget);
    }
    const circuit = createCircuit(
        cfg.circuit,
        rt.store,
        hostKey(baseReq, cfg),
        rt.clock,
    );
    if ((await circuit.phase()) === 'open') {
        yield {
            type: 'progress',
            phase: 'circuit',
            attempt: state.attempts,
            detail: 'open',
            at: now(),
        };
        throw new CircuitOpenError(); // fast-fail: do NOT touch the network
    }
    try {
        // A surface's application-level rejection reaches here as a returned `!ok` outcome, not a
        // throw, so it records a circuit SUCCESS — the transport is healthy, the payload is not.
        const settled = yield* attemptLoop(rt, baseReq, state, run, budget);
        await circuit.onSuccess();
        return settled;
    } catch (e) {
        if (!(e instanceof CircuitOpenError)) {
            const opened = await circuit.onFailure();
            if (opened)
                yield {
                    type: 'progress',
                    phase: 'circuit',
                    attempt: state.attempts,
                    detail: 'open',
                    at: now(),
                };
        }
        throw e;
    }
}

// Fold the paginator's next-page partial onto the base input. Kept in lock-step with the `.with()`
// merge in stitch.ts: `variables` is a first-class StitchInput field (GraphQL's primary input, the
// slot a cursor rides in `next: () => ({ variables: { after } })`), so it must merge like the rest —
// dropping it stranded paginated GraphQL on page 1. `signal`/`onProgress` carry too so an aborted
// paginated call still cancels mid-pagination. Omit a key entirely when neither side sets it
// (exactOptionalPropertyTypes forbids `variables: undefined`).
function mergeInput(a: StitchInput, b: StitchInput): StitchInput {
    const merged: StitchInput = {
        params: { ...(a.params ?? {}), ...(b.params ?? {}) },
        query: { ...(a.query ?? {}), ...(b.query ?? {}) },
        headers: { ...(a.headers ?? {}), ...(b.headers ?? {}) },
        body: b.body !== undefined ? b.body : a.body,
    };
    if (a.variables ?? b.variables)
        merged.variables = { ...(a.variables ?? {}), ...(b.variables ?? {}) };
    const signal = b.signal ?? a.signal;
    if (signal) merged.signal = signal;
    const onProgress = b.onProgress ?? a.onProgress;
    if (onProgress) merged.onProgress = onProgress;
    return merged;
}

// Pagination: one logical call that follows pages until `paginate.next` returns undefined
// (or `max` is hit), aggregating items. Each page is a full request — auth/retry/throttle apply.
async function* paginated(
    rt: Runtime,
    input: StitchInput,
    state: RunState,
    t0: number,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const name = nameOf(cfg);
    const pg = cfg.paginate!;
    const max = pg.pages ?? 50;
    const acc: unknown[] = [];
    let pageInput = input;
    let page = 0;
    let lastStatus = 200;

    const first = buildRequest(cfg, pageInput);
    yield startEvt(name, first, input, run);

    for (;;) {
        const req = buildRequest(cfg, pageInput);
        let res: AdapterResponse;
        let outcome: SurfaceOutcome;
        try {
            // Each page is interpreted inside its own attempt loop now (ADR 0022 Decision 1) rather
            // than here — same as the non-paginated path.
            ({ res, outcome } = yield* attemptWithCircuit(
                rt,
                req,
                state,
                run,
                budget,
            ));
        } catch (e) {
            yield errEvt(e, name, state.attempts);
            yield doneEvt(false, t0, state.attempts);
            return;
        }
        lastStatus = res.status;

        if (!outcome.ok) {
            yield surfaceErrEvt(outcome, name, state.attempts);
            yield doneEvt(false, t0, state.attempts);
            return;
        }

        let value: unknown = outcome.data;
        if (cfg.transform) value = await cfg.transform(value);
        if (cfg.pick) value = getPath(value, cfg.pick);
        const items = pg.items
            ? pg.items(value)
            : Array.isArray(value)
              ? value
              : [value];
        acc.push(...items);
        page += 1;
        yield {
            type: 'progress',
            phase: 'paginate',
            attempt: state.attempts,
            detail: `page ${page} (+${items.length}, total ${acc.length})`,
            at: now(),
        };

        if (items.length === 0 || page >= max) break;
        const nextPartial = pg.next(res.body, page);
        if (!nextPartial) break;
        pageInput = mergeInput(input, nextPartial);
    }

    // The aggregated pages ARE the raw body the contract validates and drift diffs against (ADR
    // 0015); `.inspect()` (ADR 0016) surfaces this array as `raw`.
    const rawBody = acc;
    const { value: validated, findings } = await validateOutput(cfg, acc);
    let fatal = false;
    for (const finding of findings) {
        yield { type: 'drift', finding, at: now() };
        if (finding.level === 'error') fatal = true;
    }
    if (fatal) {
        yield contractViolationEvt(name, lastStatus, state, rawBody);
        yield doneEvt(false, t0, state.attempts);
        return;
    }

    yield withRaw(
        resultEvt(validated, lastStatus, state.attempts),
        state,
        rawBody,
    );
    yield doneEvt(true, t0, state.attempts);
}

// ---- cache integration (ADR 0003) -----------------------------------------
// The cache engine lives in its own subpath module; the engine reaches it only through a lazy
// `import('./cache')`, memoised on the runtime, and only when a stitch carries a `cache` block
// and is not `sensitive`. A cache-free stitch never loads a byte of it.
async function ensureCache(rt: Runtime): Promise<CacheController | null> {
    const { cfg } = rt;
    const config = cfg.cache;
    if (!config || cfg.sensitive) return null;
    rt.cacheInit ??= import('./cache').then((m) =>
        m.createCache(
            compact({
                config,
                store: rt.store,
                stitchId: m.cacheStitchId(cfg),
                // The RAW output schema (not the Validator wrapper) so the fingerprinter can read its
                // `~standard.vendor`; transform/pick are already raw on the config (ADR 0004 fold).
                output: outputSchemaSource(cfg),
                transform: cfg.transform,
                pick: cfg.pick,
                principal: rt.authCtx.principal,
            }),
        ),
    );
    return rt.cacheInit;
}

// `normalizeOutput`/`drift()` wrap `output` through `toValidator`, which hides the original
// `~standard`. The wrapper keeps a non-enumerable `source` back-reference to the raw schema; unwrap
// it (and the `DriftSpec.schema` layer) so the fingerprinter sees the real Zod/Valibot/… instance.
// Falls back to the wrapper itself when no source was recorded — that is simply un-fingerprintable
// (a custom Validator/predicate), which the resolver handles by refusing or re-validating.
function outputSchemaSource(cfg: ResolvedStitchConfig): unknown {
    const out = cfg.output;
    if (!out) return undefined;
    // Cast to a probe shape (not `DriftSpec`) so `__kind` stays `unknown` — a real comparison, not
    // an always-true one against the `'drift'` literal.
    const isDrift = (out as { __kind?: unknown }).__kind === 'drift';
    const validator = isDrift ? (out as DriftSpec).schema : out;
    return (validator as { schema?: unknown }).schema ?? validator;
}

// The resolved request the cache key is derived from. The principal it scopes by is sourced from
// the trusted AuthContext at controller creation, never from StitchInput (ADR 0002 §2), so the
// descriptor itself stays principal-free; folding + scope are the controller's job.
function describe(baseReq: AdapterRequest): RequestDescriptor {
    const d: RequestDescriptor = {
        method: baseReq.method,
        url: baseReq.url,
        headers: baseReq.headers,
    };
    // The surface has already shaped the body (graphql's { query, variables } IS baseReq.body),
    // so the cache keys on the resolved request uniformly — no surface-specific branch.
    if (baseReq.body !== undefined) d.body = baseReq.body;
    return d;
}

type RunOutcome =
    { ok: true; value: unknown; status: number; vary?: string } | { ok: false };

const startEvt = (
    name: string,
    baseReq: AdapterRequest,
    input: StitchInput,
    run: RunContext,
): StitchEvent =>
    compact({
        type: 'start',
        name,
        method: baseReq.method,
        url: baseReq.url,
        input,
        at: now(),
        spanId: run.spanId,
        traceId: run.traceId,
        parentSpanId: run.parentSpanId,
    });

const cacheEvt = (detail: string): StitchEvent => ({
    type: 'progress',
    phase: 'cache',
    attempt: 0,
    detail,
    at: now(),
});

// A buffered upload bar that never moves is the quiet trap behind the adapter seam: a call passes
// `onProgress` with a body expecting bytes-sent, but the default `fetch` reports only
// `direction: 'download'` — the upload phase stays dark, no error, no events. When the active adapter
// declares its capabilities and `'uploadProgress'` is NOT among them (ADR 0005 Decision 9), say so
// once — an `info` event pointing at xhrAdapter — instead of no-op'ing. Deliberately a teaching
// note, not a throw: a body with `onProgress` can also legitimately want DOWNLOAD progress on a
// POST, which `fetch` does serve, so erroring would break a working call. Adapters that declare
// nothing (custom transports) and ADR 0008 surfaces that replace the transport are left alone — the
// open contract stands.
function uploadProgressWarning(
    rt: Runtime,
    input: StitchInput,
): StitchEvent | undefined {
    if (!input.onProgress || input.body === undefined) return undefined;
    if (rt.cfg.kind.execute) return undefined; // surface replaces the transport (shell/llm/pipe)
    const cap = rt.adapter.capabilities;
    if (!cap || cap.supports.includes('uploadProgress')) return undefined;
    return {
        type: 'info',
        topic: 'adapter.upload-progress-unsupported',
        detail:
            `onProgress is set with a request body, but ${cap.name ?? 'the active adapter'} cannot ` +
            `report upload progress — only 'direction: download' events fire. Use xhrAdapter() to draw ` +
            `an upload progress bar.`,
        at: now(),
    };
}

const resultEvt = (
    data: unknown,
    status: number,
    attempts: number,
): StitchEvent => ({
    type: 'result',
    data,
    status,
    attempts,
    at: now(),
});

// Ask the SELECTED surface what the response means (graphql's "200-with-`errors`" failure lives in
// its hook; a plain stitch resolves `kind` to `httpSurface`, whose hook is `httpInterpret`). The
// Build the `error` event for a surface that interpreted the response as a failure. Reached by the
// retry arm too, once its attempts are spent — it carries no `status` (it is a body verdict, not a
// transport one), so the event simply omits the field.
function surfaceErrEvt(
    outcome: Extract<SurfaceOutcome, { ok: false }>,
    name: string,
    attempts: number,
): StitchEvent {
    const evt: Extract<StitchEvent, { type: 'error' }> = {
        type: 'error',
        name,
        message: outcome.message,
        attempts,
        at: now(),
    };
    const status = 'status' in outcome ? outcome.status : undefined;
    if (status !== undefined) evt.status = status;
    return evt;
}

// The resilience chain from the request onward (no `start` event — the caller emits it). Returns
// the validated outcome so the cache layer can store/share it; on any failure it yields the
// error/done events and returns `{ ok: false }`.
async function* runFrom(
    rt: Runtime,
    baseReq: AdapterRequest,
    name: string,
    state: RunState,
    t0: number,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, RunOutcome> {
    const { cfg } = rt;
    let res: AdapterResponse;
    let outcome: SurfaceOutcome;
    try {
        // The surface's verdict is rendered inside the attempt loop now (ADR 0022 Decision 1), so
        // it arrives already settled. A `!ok` here is an application-level rejection of a
        // well-formed response (graphql's "200-with-`errors`"); a transport failure threw instead.
        ({ res, outcome } = yield* attemptWithCircuit(
            rt,
            baseReq,
            state,
            run,
            budget,
        ));
    } catch (e) {
        yield errEvt(e, name, state.attempts);
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }

    if (!outcome.ok) {
        yield surfaceErrEvt(outcome, name, state.attempts);
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }
    let value: unknown = outcome.data;
    if (cfg.transform) value = await cfg.transform(value);
    if (cfg.pick) value = getPath(value, cfg.pick);
    // The pre-validation body — the left side of 0015's `diff(raw, validated)`, the coordinate space a
    // finding's `path` is anchored to. `.inspect()` (ADR 0016) surfaces it; otherwise it's discarded.
    const rawBody = value;
    const { value: validated, findings: outputFindings } = await validateOutput(
        cfg,
        value,
    );
    // A `verdict.flag` that resolved to nothing is diagnosed, never enforced (ADR 0022 Decision 3).
    // It reads the RAW response body, not `value` — the flag indexes what the server sent, before
    // transform/pick reshaped it.
    const flagged = flagFinding(res, cfg);
    const findings = flagged ? [flagged, ...outputFindings] : outputFindings;
    let fatal = false;
    for (const finding of findings) {
        yield { type: 'drift', finding, at: now() };
        if (finding.level === 'error') fatal = true;
    }
    if (fatal) {
        yield contractViolationEvt(name, res.status, state, rawBody);
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }

    value = validated; // serve the validated value — sound, matches the declared contract (ADR 0015)
    yield withRaw(resultEvt(value, res.status, state.attempts), state, rawBody);
    yield doneEvt(true, t0, state.attempts);
    const vary = res.headers['vary'];
    return vary !== undefined
        ? { ok: true, value, status: res.status, vary }
        : { ok: true, value, status: res.status };
}

// Streaming surfaces (sse/stream): open the LIVE body and decode it into `delta` chunks via the
// surface's `stream` hook (ADR 0005 Decisions 4-5). Still lean — no circuit/cache (streaming bypasses
// the cache), but resumable when the surface opts in: a surface that exposes the resume hooks
// (`resumeToken`/`applyResume`) AND a stitch that set `sse.reconnect` (off by default — issue #71)
// reconnect a DROPPED body, replaying the last resume token (sse → `Last-Event-ID`) and honouring a
// server-sent backoff (sse → the `retry:` field), capped at `reconnect.attempts`. Only a drop — a
// body that ran out has finished, and a stream with no resume token to replay is not reopened at
// all, since the reopened request could only ask for the whole body again (issue #640). The engine stays
// surface-agnostic: it never branches on `kind.id === 'sse'`; it reads the resume token / server
// backoff through the surface's generic hooks and the reconnect policy through one config accessor.
// It charges the rate gate at every open (each reconnect is a fresh request) but takes NO concurrency
// slot (a rate-only acquire, never released), so a long-lived connection can never pin a seam's
// concurrency budget (Decision 12). The await/`consume` path resolves to the COLLECTED array of
// every emitted chunk ACROSS reconnects — the terminal `result` mirrors the whole delta spine (Stage
// 5 sub-decision); `.stream()` yields the chunks incrementally and buffers nothing. transform/pick
// reshape a whole buffered body and are NOT applied here; the `output` contract, by contrast,
// validates each chunk before its `delta` is emitted (per-`delta`, via the surface's `contractValue`
// hook — ADR 0005 Addendum) and keeps firing across reconnects, snapshot-drift omitted.
async function* runStreaming(
    rt: Runtime,
    input: StitchInput,
    name: string,
    state: RunState,
    t0: number,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const surface = cfg.kind;
    if (!surface.stream) return; // unreachable: only entered for a streaming surface
    // Bind the surface's hooks as non-optional locals up front: TS reverts the `surface` narrowing
    // inside the open closure below (a nested async generator), so capturing the hooks here — past
    // the guard, where `surface.stream` is present — keeps the closure free of re-narrowing noise.
    // The resume hooks (issue #71) stay optional; the surface is resumable only when both are set.
    const streamHook: NonNullable<Surface['stream']> = surface.stream;
    const resumeToken = surface.resumeToken;
    const resumeRetry = surface.resumeRetry;
    const applyResume = surface.applyResume;

    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }
    // Ask the transport for the live body — un-buffered, un-parsed (ADR 0005 Q1).
    baseReq = { ...baseReq, stream: true };
    yield startEvt(name, baseReq, input, run);
    state.attempts = 1;

    // Resumability is a GENERIC decision the engine makes from surface capability + config — never
    // by sniffing `kind.id === 'sse'`. A surface CAN resume when it can both read a resume token
    // off a delta and inject it into the next request; the stitch enables it with `sse.reconnect`
    // (off by default — issue #71). `resolveReconnect` is the lone touch point for the `sse` config
    // slot, so no SSE-ism leaks into the loop below.
    //
    // Capability is necessary but NOT sufficient (issue #640). A surface exposes these hooks
    // unconditionally — `sseSurface` does — so this flag says "an id-carrying body could be
    // resumed here", not "this body carries ids". Whether THIS stream has a resume point is only
    // known once a token has actually been read off a delta, which is why the reconnect decision
    // below tests `lastToken` and not this flag alone.
    const policy = resolveReconnect(cfg);
    const canResume = policy.enabled && !!resumeToken && !!applyResume;

    // State carried ACROSS reconnects: the await/`.stream()` result is the whole delta spine, and a
    // reconnect inherits the prior connection's last resume token (sse → the `Last-Event-ID` to
    // replay). `lastRetryMs` holds the latest server-suggested backoff (sse → the `retry:` field);
    // it persists too, so a server `retry:` seen on an earlier connection still paces a later
    // reconnect until the server sends a new one.
    const chunks: unknown[] = [];
    let lastToken: string | undefined;
    let lastRetryMs: number | undefined;
    let lastStatus = 200; // status of the most recent successful open (for the terminal `result`)
    let lastError: unknown; // the live error from the most recent drop, surfaced if reconnects run out
    let attempt = 0; // open count: 1 = first connection, 2+ = a reconnect

    // Open the live body and decode it into `delta` chunks. Returns how the connection ENDED so the
    // reconnect loop can decide what to do: `'closed'` (the body ran out — the stream finished, and
    // is never reopened), `'error'` (the body threw mid-stream, or never opened — a reconnectable
    // drop), or `'fail'` (a terminal failure that already emitted its `error`+`done`, stop). It
    // emits the per-open spine (throttle/request progress, deltas, drift) inline via `yield*`.
    async function* openAndDecode(): AsyncGenerator<
        StitchEvent,
        'closed' | 'error' | 'fail'
    > {
        attempt++;
        state.attempts = attempt;

        // Charge the rate limiter at EVERY open — a reconnect is a fresh request, so it counts
        // against the rate budget like any other (Decision 12) — but still take NO concurrency slot.
        let waited: number;
        try {
            ({ waited } = await acquireWithin(
                rt.throttle,
                hostKey(baseReq, cfg),
                budget,
                { rateOnly: true },
                baseReq.signal,
            ));
        } catch (e) {
            yield errEvt(e, name, attempt);
            yield doneEvt(false, t0, attempt);
            return 'fail';
        }
        if (waited > 0)
            yield {
                type: 'progress',
                phase: 'throttled',
                attempt,
                waited,
                at: now(),
            };

        let res: AdapterResponse;
        try {
            // Rebuild the per-open request from `baseReq` each time; on a reconnect, inject the
            // resume token (sse → set `Last-Event-ID`) BEFORE auth so it rides the reopened request.
            const req = cloneReq(baseReq);
            if (attempt > 1 && lastToken !== undefined)
                applyResume?.(req, lastToken);
            if (cfg.auth) await cfg.auth.apply(req, rt.authCtx);
            await cfg.hooks?.onRequest?.({ name, attempt, req });
            yield { type: 'progress', phase: 'request', attempt, at: now() };
            // A surface that replaces the transport (ADR 0008) runs here too, so a future non-HTTP
            // streaming surface gets the same treatment as the buffered path.
            res = await (cfg.kind.execute ?? rt.adapter)(req);
            await cfg.hooks?.onResponse?.({ name, attempt, res });
        } catch (e) {
            await cfg.hooks?.onError?.({ name, attempt, error: e });
            // A failure to even OPEN is a reconnectable drop too (the connection broke): record the
            // live error and hand it back as `'error'` so the loop applies the backoff/cap rather
            // than treating it as terminal (and surfaces THIS error if reconnects run out).
            lastError = e;
            return 'error';
        }

        // verdict.accept (issue #155): an accepted non-2xx streams its live body like a 2xx instead of
        // failing — same per-stitch policy the buffered/paginated `attemptLoop` honours, through the
        // same function since ADR 0022 Decision 2. A rejected status is TERMINAL (not reconnected):
        // the server actively refused, replaying it would loop.
        //
        // `classifyStatus`, not the surface's `interpret` and not the body-aware `verdictOf`: at
        // open time there is no buffered body to rule on — only the status is known — so the retry
        // arm and `verdict.flag` cannot apply here. The signature says so, rather than leaving it to
        // a comment. That is a documented limit of the streaming path, not an oversight.
        if (classifyStatus(res.status, cfg)) {
            // The error response carries the parsed payload, not a live stream — drain the unread
            // body (a small `{ error: "…" }`, not a real stream the caller wants) so
            // StitchError.body is the PARSED payload, matching the buffered path. Pin it (with
            // `.url`) via ERROR_SOURCE.
            const errored: AdapterResponse = {
                status: res.status,
                headers: res.headers,
                body: await drainErrorBody(res.body),
                // eslint-disable-next-line no-restricted-syntax -- `compact` would optionalize the required `body: unknown`; keep the explicit spread here
                ...(res.url !== undefined ? { url: res.url } : {}),
            };
            const e = new Error(`HTTP ${res.status}`) as Error & {
                status: number;
                response: AdapterResponse;
            };
            e.status = res.status;
            e.response = errored; // body + url for StitchError.body/.url (pinned via ERROR_SOURCE)
            yield errEvt(e, name, attempt);
            yield doneEvt(false, t0, attempt);
            return 'fail';
        }
        lastStatus = res.status;

        // Decode the live body into `delta` chunks; collect them so the await path resolves to the
        // whole sequence ACROSS reconnects (Stage 5 sub-decision). With an `output` contract set,
        // validate each chunk BEFORE its `delta` is emitted (ADR 0005 Addendum) — and on every
        // reconnect too: a `critical`/schema failure fails the stream (the bad value is never
        // delivered or collected) while a `watch` finding warns and the delta still flows.
        // `contractValue` picks the part to validate (sse → the event `data`), default the whole
        // chunk; matches the buffered path's drift→error handling in `runFrom`.
        try {
            for await (const chunk of streamHook(res, cfg)) {
                // Track the resume token / server backoff off each delta (sse → `id` / `retry`) so a
                // later drop resumes from here. Unchanged when the surface isn't resumable (no hook).
                const tok = resumeToken?.(chunk);
                if (tok !== undefined) lastToken = tok;
                // Parsed, not read raw: the hook takes the canonical duration form (P17), so a
                // surface may return `'1.5s'`. An unparseable token parses to `undefined` and
                // leaves the previous value standing — the same fall-through `after` gets (#609).
                const ret = parseDuration(resumeRetry?.(chunk));
                if (ret !== undefined) lastRetryMs = ret;

                if (cfg.output) {
                    const target = cfg.kind.contractValue
                        ? cfg.kind.contractValue(chunk)
                        : chunk;
                    let fatal = false;
                    const { errors } = await validateValue(cfg, target);
                    for (const finding of errors) {
                        yield { type: 'drift', finding, at: now() };
                        if (finding.level === 'error') fatal = true;
                    }
                    if (fatal) {
                        yield {
                            type: 'error',
                            name,
                            message: 'contract violation (drift)',
                            status: res.status,
                            attempts: attempt,
                            at: now(),
                        };
                        yield doneEvt(false, t0, attempt);
                        return 'fail';
                    }
                }
                // MEMORY NOTE: every chunk is accumulated so the awaited/`.stream()` result can
                // mirror the whole delta spine across reconnects (Stage 5 sub-decision). This means
                // `chunks` grows for the life of the connection — an UNBOUNDED/infinite stream grows
                // memory without limit. A consumer of an unbounded stream should read the `delta`
                // events incrementally (via `.stream()`) and MUST NOT rely on the accumulated final
                // result; awaiting such a stitch to completion is intentionally not memory-bounded.
                chunks.push(chunk);
                yield { type: 'delta', chunk, at: now() };
            }
        } catch (e) {
            lastError = e; // the body threw mid-stream — a reconnectable drop; keep the live error
            return 'error';
        }
        // The body ran out. A clean close is the stream saying it is DONE, not a failure to paper
        // over: the loop finalizes with what we collected rather than asking for it again (#640).
        return 'closed';
    }

    // The reconnect loop. The first open is mandatory; each subsequent open is gated on a genuine
    // DROP (`'error'`) that this stream can pick up from, AND remaining attempts. On such a drop we
    // emit a `reconnect` progress event (reusing the `progress` spine — Decision: no new
    // StitchEvent type), wait the backoff (the server `retry:` seen this run, else
    // `reconnect.backoff`, else the `retry` policy), then loop — `openAndDecode` reapplies auth +
    // injects the resume token on the reopened request.
    for (;;) {
        const ended = yield* openAndDecode();
        if (ended === 'fail') return; // terminal failure already emitted error + done
        // Reopening is only ever safe when the reopened body cannot re-deliver what the consumer
        // already holds: either this stream carried a resume point (replayed as sse's
        // `Last-Event-ID`, so the server continues from there), or nothing has been delivered yet
        // — a connect-phase or first-frame failure, where there is nothing to duplicate. Without
        // this an id-less body replayed itself in full on every reopen (issue #640).
        const recoverable = lastToken !== undefined || chunks.length === 0;
        // Reconnect only a recoverable drop, while attempts remain. `'closed'` is NOT a drop: the
        // body ran out, which is the stream FINISHING — reopening it re-requests a body that
        // already arrived in full (issue #640). Otherwise behave exactly as the reconnect-off path
        // does — a clean close finalizes with what we collected, a mid-stream error surfaces as
        // error + done.
        if (
            !canResume ||
            ended === 'closed' ||
            !recoverable ||
            attempt > policy.maxAttempts
        ) {
            if (ended === 'error') {
                // Surface the REAL drop error (its message/status/`.response`), matching today's
                // mid-stream-error behaviour, rather than a synthetic placeholder.
                yield errEvt(lastError, name, attempt);
                yield doneEvt(false, t0, attempt);
                return;
            }
            break; // exhausted reconnects after a clean close → finalize with what we collected
        }

        // Backoff: a server-sent `retry:` (seen on any connection this run) wins; else the explicit
        // `reconnect.delay`; else the stitch's `retry` backoff math. `attempt` is now the count
        // of opens DONE, so `attempt + 1` is the upcoming reconnect for the expo curve.
        const backoff =
            lastRetryMs ?? policy.delay ?? backoffDelay(attempt + 1, cfg.retry);
        yield {
            type: 'progress',
            phase: 'reconnect',
            attempt,
            waited: backoff,
            at: now(),
        };
        await sleepWithin(backoff, budget, baseReq.signal, rt.clock);
    }

    yield resultEvt(chunks, lastStatus, attempt);
    yield doneEvt(true, t0, attempt);
}

// Resolve the resumable-SSE reconnect policy from config (issue #71) — the ONE place the engine
// reads the `sse` config slot, keeping `runStreaming` free of SSE-isms. `sse.reconnect` is off by
// default; `true` enables it with sane defaults; the object form tunes the cap / fallback delay.
// `delay` stays `undefined` when unset so the caller can fall back to the `retry` policy.
function resolveReconnect(cfg: ResolvedStitchConfig): {
    enabled: boolean;
    maxAttempts: number;
    delay: number | undefined;
} {
    const r = cfg.sse?.reconnect;
    if (!r) return { enabled: false, maxAttempts: 0, delay: undefined };
    if (r === true) return { enabled: true, maxAttempts: 3, delay: undefined };
    return {
        enabled: true,
        maxAttempts: r.attempts ?? 3,
        delay: parseDuration(r.delay),
    };
}

// A single uncached run: build the request, emit `start`, then run the chain.
async function* runOnce(
    rt: Runtime,
    input: StitchInput,
    name: string,
    state: RunState,
    t0: number,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, RunOutcome> {
    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(rt.cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return { ok: false };
    }
    yield startEvt(name, baseReq, input, run);
    return yield* runFrom(rt, baseReq, name, state, t0, run, budget);
}

// The cached path: lookup is OUTERMOST over the expensive chain; a hit short-circuits
// throttle/circuit/network/transform/output-validation; a miss runs the full chain (collapsed by
// in-process coalescing) and writes the validated result to the cache LAST (ADR 0003 §7).
async function* runCached(
    rt: Runtime,
    ctl: CacheController,
    input: StitchInput,
    name: string,
    state: RunState,
    t0: number,
    run: RunContext,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }
    yield startEvt(name, baseReq, input, run);

    // 'refuse' (ADR 0004): the output contract can't be soundly fingerprinted (no strategy for the
    // vendor / a non-Standard-Schema validator / an opaque un-versioned transform) and the caller
    // did not opt into re-validate-on-hit — fail closed, never store, and surface WHY for traces.
    if (ctl.policy === 'refuse') {
        yield cacheEvt(`bypass: ${ctl.reason}`);
        yield* runFrom(rt, baseReq, name, state, t0, run, budget);
        return;
    }

    // A non-cacheable method (a mutation sharing a fragment) runs normally, uncached.
    if (!ctl.cacheableMethod(baseReq.method)) {
        yield* runFrom(rt, baseReq, name, state, t0, run, budget);
        return;
    }
    // A non-storable response (binary read straight into the store) warns and passes through —
    // configuring `cache` here is a no-op-with-warning, never a crash (ADR 0003 §3). Read the
    // RESOLVED request's responseType so a surface that forces blob (`download`) is caught too.
    if (
        baseReq.responseType === 'blob' ||
        baseReq.responseType === 'arrayBuffer'
    ) {
        yield cacheEvt('bypass: non-storable responseType');
        yield* runFrom(rt, baseReq, name, state, t0, run, budget);
        return;
    }

    const d = describe(baseReq);
    const key = ctl.keyOf(d, input);
    if (key === undefined) {
        yield cacheEvt('bypass: unhashable request');
        yield* runFrom(rt, baseReq, name, state, t0, run, budget);
        return;
    }

    const op = await ctl.open(key, d);
    const found = await op.get();
    if (found) {
        // policy 'revalidate' (ADR 0004): the schema couldn't be fingerprinted but the caller opted
        // in, so re-validate the stored value against the current output before serving — a fatal
        // mismatch means it is stale-shaped → evict and fall through to a miss. policy 'fast' skips
        // this (the value is bound to a known fingerprint, or there is no output schema). Either way
        // a hit still short-circuits network/throttle/transform.
        let stale = false;
        if (ctl.revalidateOnHit && cfg.output) {
            // Only the hard validation result matters on a cache hit: a stored value that no longer
            // satisfies the schema is stale-shaped. Soft drift (raw-vs-validated) is meaningless here.
            const { errors } = await validateValue(cfg, found.data);
            for (const finding of errors) {
                yield { type: 'drift', finding, at: now() };
                if (finding.level === 'error') stale = true;
            }
        }
        if (!stale) {
            yield cacheEvt(ctl.revalidateOnHit ? 'hit (revalidated)' : 'hit');
            yield resultEvt(found.data, found.status, 0);
            yield doneEvt(true, t0, 0);
            return;
        }
        await op.delete();
    }

    yield cacheEvt('miss');
    const store = async (out: RunOutcome): Promise<void> => {
        if (out.ok) await op.set(out.value, out.status, out.vary);
    };

    // Coalescing disabled: run the chain, write the cache last.
    if (ctl.coalesce === false) {
        await store(yield* runFrom(rt, baseReq, name, state, t0, run, budget));
        return;
    }

    // In-process coalescing: the leader runs the chain; followers await its one shared result.
    const claim = ctl.join(key);
    if (claim.leader) {
        let out: RunOutcome;
        try {
            out = yield* runFrom(rt, baseReq, name, state, t0, run, budget);
        } catch (e) {
            claim.fail(e);
            throw e;
        }
        if (out.ok) {
            await store(out);
            claim.settle({ data: out.value, status: out.status });
        } else {
            // Failure is not shared — waiters re-run on their own.
            claim.fail(new Error('cache: leader run failed'));
        }
        return;
    }

    let shared: CacheHit;
    try {
        shared = await claim.promise;
    } catch {
        // The leader failed (or did not cache): proceed independently, uncoalesced.
        await store(yield* runFrom(rt, baseReq, name, state, t0, run, budget));
        return;
    }
    yield cacheEvt('coalesced');
    yield resultEvt(shared.data, shared.status, 0);
    yield doneEvt(true, t0, 0);
}

export async function* execute(
    rt: Runtime,
    callInput: StitchInput = {},
    // Run identity (ADR 0007). Defaults to a fresh root run; the caller supplies one to make
    // this a CHILD run — `newRunContext(parent)` inherits the parent's `traceId` and sets
    // `parentSpanId` (a `cookieSession` login, a `linked` step). Stamped on the `start` event and
    // carried onto the trace-sink ctx by `tee` (stitch.ts).
    run: RunContext = newRunContext(),
    // Per-call run flags (ADR 0016), set by `.inspect()`: `retainRaw` surfaces the pre-validation
    // body on the terminal event; `bypassCache` skips the cache entirely (neither read nor write).
    // Both default off, so every other consumer (await/safe/stream) is byte-identical.
    flags?: RunFlags,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const name = nameOf(cfg);
    const t0 = now();
    const state: RunState = { attempts: 0 };
    if (flags?.retainRaw) state.retainRaw = true;
    const budget = totalBudget(cfg, t0);

    // Everything below runs on the VALIDATED input — the parsed value of every declared slot
    // (issue #648) — so the request, the cache key it derives, and the events that echo it all
    // describe the same call.
    let input: StitchInput;
    try {
        input = await validateInput(cfg, callInput);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }

    // Teach, don't no-op: an upload progress bar the transport can't draw gets one `info` event,
    // not silence (and not a throw — see `uploadProgressWarning`). Emitted once per call, before
    // any surface dispatch, so the same note surfaces for buffered/paginated/cached paths alike.
    const progressWarning = uploadProgressWarning(rt, input);
    if (progressWarning) yield progressWarning;

    // Streaming surfaces (sse/stream) take a dedicated path: open the live body and emit `delta`
    // chunks (Decisions 4-5). Streaming bypasses pagination and the cache, and is exempt from the
    // concurrency bucket (Decision 12). Checked before both so neither can wrap a live stream.
    if (cfg.kind.stream) {
        yield* runStreaming(rt, input, name, state, t0, run, budget);
        return;
    }

    if (cfg.paginate) {
        yield* paginated(rt, input, state, t0, run, budget);
        return;
    }

    // Cache lookup is OUTERMOST over the expensive chain but AFTER input validation, so a hit can
    // never tunnel an invalid call past the boundary and the key mirrors the resolved request.
    // `.inspect()` bypasses it by default (ADR 0016): a hit stores only `{ value, status }` — no
    // `raw` — so serving one defeats the probe; bypass runs the uncached path, which neither reads
    // nor writes the cache and stays out of single-flight coalescing (it runs its own request).
    const ctl = flags?.bypassCache ? null : await ensureCache(rt);
    if (ctl) {
        yield* runCached(rt, ctl, input, name, state, t0, run, budget);
        return;
    }

    yield* runOnce(rt, input, name, state, t0, run, budget);
}

// ---- cache surfaces (lazy; no static cache import on the hot path) ---------
/** Exact, single-entry eviction for the call `input` would make. A no-op for an uncached or
 *  non-cacheable-method stitch. Backs `stitch.invalidate(input)` (ADR 0003 §8). */
export async function cacheInvalidateExact(
    rt: Runtime,
    callInput: StitchInput = {},
): Promise<void> {
    const ctl = await ensureCache(rt);
    if (!ctl) return;
    let baseReq: AdapterRequest;
    let input: StitchInput;
    try {
        // The stored key mirrors the RESOLVED request, so eviction must derive it from the same
        // VALIDATED input the run stored under (issue #648) — otherwise this computes the key of a
        // request that was never made and evicts nothing. Input the schema rejects was never cached
        // either, so it exits as the same no-op a failed `buildRequest` already is.
        input = await validateInput(rt.cfg, callInput);
        baseReq = buildRequest(rt.cfg, input);
    } catch {
        return;
    }
    if (!ctl.cacheableMethod(baseReq.method)) return;
    const d = describe(baseReq);
    const key = ctl.keyOf(d, input);
    if (key === undefined) return;
    await (await ctl.open(key, d)).delete();
}

/** Bulk eviction of every entry this stitch produced (per-stitch generation bump). Backs
 *  `stitch.cache.invalidate()` and `seam.invalidate(stitch)` (ADR 0003 §8). */
export async function cacheInvalidateBulk(rt: Runtime): Promise<void> {
    const ctl = await ensureCache(rt);
    if (!ctl) return;
    await ctl.invalidate();
}

/** The derived opaque key for `input`, for introspection. Backs `stitch.cache.keyOf(input)`. */
export async function cacheKeyOf(
    rt: Runtime,
    input: StitchInput = {},
): Promise<string | undefined> {
    const ctl = await ensureCache(rt);
    if (!ctl) return undefined;
    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(rt.cfg, input);
    } catch {
        return undefined;
    }
    return ctl.keyOf(describe(baseReq), input);
}

export async function executeRaw(
    rt: Runtime,
    input: StitchInput = {},
): Promise<AdapterResponse> {
    const baseReq = buildRequest(rt.cfg, input);
    const state = { attempts: 0 };
    const gen = attemptLoop(
        rt,
        baseReq,
        state,
        newRunContext(),
        totalBudget(rt.cfg, now()),
    );
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    // The RAW response is the point here (a login's Set-Cookie headers), so the surface's verdict
    // is discarded — a failing status still threw inside the loop, exactly as before.
    return step.value.res;
}

/**
 * Like {@link executeRaw}, but TEES the run's events to `sink` as a CHILD run (ADR 0007) and
 * returns the raw response. `cookieSession` uses it to run its login as a traced child of the call
 * that triggered it (`run.parentSpanId` = the caller's spanId), so the login is no longer an invisible
 * side-call. The login's `result` carries only its **status** — never the (sensitive) login body —
 * and any `throttled`/`retry`/`info` events from the login's own attempts are teed through.
 */
export async function executeRawTraced(
    rt: Runtime,
    input: StitchInput,
    sink: TraceSink,
    run: RunContext,
): Promise<AdapterResponse> {
    const { cfg } = rt;
    const name = nameOf(cfg);
    const t0 = now();
    const state = { attempts: 0 };
    const ctx = compact({
        name,
        spanId: run.spanId,
        traceId: run.traceId,
        parentSpanId: run.parentSpanId,
    });
    const baseReq = buildRequest(cfg, input);
    sink.handle(startEvt(name, baseReq, input, run), ctx);
    try {
        const gen = attemptLoop(rt, baseReq, state, run, totalBudget(cfg, t0));
        let step = await gen.next();
        while (!step.done) {
            sink.handle(step.value, ctx);
            step = await gen.next();
        }
        const { res } = step.value;
        // Status only — a login response body is sensitive; the span needs only its outcome.
        sink.handle(resultEvt(undefined, res.status, state.attempts), ctx);
        sink.handle(doneEvt(true, t0, state.attempts), ctx);
        return res;
    } catch (e) {
        sink.handle(errEvt(e, name, state.attempts), ctx);
        sink.handle(doneEvt(false, t0, state.attempts), ctx);
        throw e;
    }
}
