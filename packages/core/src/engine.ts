// The execution engine: turns a resolved config + input into a stream of typed events.
// `execute` is an async generator (start → progress → drift → result → done); the await
// path consumes it to the result. `executeRaw` runs the request once and returns the raw
// response (used by cookieSession to read Set-Cookie from a login stitch).
// Type-only: erased at compile time, so the cache engine is NOT statically bundled into core.
// The real module is reached via a lazy `import('./cache')` only when a stitch has a `cache`
// block (bundle-frugal gate — ADR 0003 decision 11).
import type { CacheController, CacheHit, RequestDescriptor } from './cache';
import { classifyDrift, loadSnapshot, saveSnapshot } from './drift';
import { fetchAdapter } from './http-adapter';
import {
    CircuitOpenError,
    TimeoutError,
    backoffDelay,
    createCircuit,
    parseRetryAfter,
    withTimeout,
} from './resilience';
import { vaultView } from './store';
import type { SurfaceOutcome } from './surface';
import type {
    AcquireOptions,
    Adapter,
    AdapterRequest,
    AdapterResponse,
    AuthContext,
    DriftFinding,
    DriftSpec,
    StitchConfig,
    StitchEvent,
    StitchInput,
    StitchStore,
    TraceSink,
} from './types';
import {
    appendQueryString,
    buildQuery,
    expandPath,
    getPath,
    matchAny,
    now,
    parseDuration,
    sleep,
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
    cfg: StitchConfig;
    adapter: Adapter;
    throttle: {
        acquire(
            key: string,
            opts?: AcquireOptions,
        ): Promise<{ waitedMs: number }>;
        release(key: string): void;
    };
    trace: TraceSink;
    store: StitchStore;
    authCtx: AuthContext;
    /** Lazily-initialised cache controller (ADR 0003). Memoised so all calls of one stitch share
     *  a single coalescer + LRU; the `import('./cache')` fires once, only for a cached stitch. */
    cacheInit?: Promise<CacheController>;
}

export function makeRuntime(
    cfg: StitchConfig,
    throttle: Runtime['throttle'],
    trace: TraceSink,
    store: StitchStore,
    opts?: { vault?: StitchStore; principal?: string },
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
        authCtx,
    };
}

// A per-call view of the shared `authCtx` whose `emit` collects `info` events into `sink`. The
// Runtime (and its `authCtx`) is shared across a stitch's concurrent calls, so the buffer must be
// per-call: spread a fresh ctx (sharing store/vault/principal) with a private emit, run the
// strategy, then yield whatever it announced. `apply`/`refresh` are plain async fns and can't yield.
function emitInto(authCtx: AuthContext, sink: StitchEvent[]): AuthContext {
    return {
        ...authCtx,
        emit: (topic, detail) =>
            sink.push({
                type: 'info',
                topic,
                ...(detail !== undefined ? { detail } : {}),
                at: now(),
            }),
    };
}

const nameOf = (cfg: StitchConfig) => cfg.name ?? cfg.path ?? 'stitch';

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
    cfg: StitchConfig,
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
    headers[header] = cfg.idempotency.key
        ? cfg.idempotency.key(input)
        : randomUUID();
}

const resolveStr = (v: string | (() => string) | undefined): string =>
    typeof v === 'function' ? v() : (v ?? '');

function buildRequest(cfg: StitchConfig, input: StitchInput): AdapterRequest {
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
        buildQuery(query, cfg.arrayFormat),
    );
    // A relative endpoint can't be fetched by the default transport — fail with a clear config
    // error here instead of a cryptic "Failed to parse URL" from fetch. A custom `adapter` may
    // legitimately resolve relative URLs, so this only guards the default transport.
    if (cfg.adapter === undefined && !/^https?:\/\//i.test(url)) {
        const e = new Error(
            `stitch ${JSON.stringify(nameOf(cfg))}: request URL ${JSON.stringify(url)} is not absolute. ` +
                'Set `url` to a full endpoint, or give a relative `path` a `baseUrl` (e.g. from a shared fragment).',
        );
        e.name = 'StitchConfigError';
        throw e;
    }
    const method = (cfg.method ?? 'GET').toUpperCase();
    const headers = { ...(cfg.headers ?? {}), ...(input.headers ?? {}) };
    let req: AdapterRequest = {
        url,
        method,
        headers,
        body: input.body,
        ...(cfg.bodyType !== undefined ? { bodyType: cfg.bodyType } : {}),
        ...(cfg.multipart !== undefined ? { multipart: cfg.multipart } : {}),
        ...(cfg.responseType !== undefined
            ? { responseType: cfg.responseType }
            : {}),
    };
    // Per-call execution controls (ADR 0005 Decisions 8-9): cancellation + byte progress, threaded
    // BEFORE the surface shapes the request so a surface that spreads `base` (e.g. `download`)
    // keeps them. Runtime-only — they never came from `__config`.
    if (input.signal) req.signal = input.signal;
    if (input.onProgress) req.onProgress = input.onProgress;
    // The surface shapes the request (graphql packs { query, variables } + forces POST, …);
    // absent, the http identity above stands.
    if (cfg.kind?.buildRequest) req = cfg.kind.buildRequest(cfg, input, req);
    // Idempotency runs AFTER surface shaping so a surface that forces a write still gets a key.
    applyIdempotency(cfg, input, req.method, req.headers);
    return req;
}

const cloneReq = (r: AdapterRequest): AdapterRequest => ({
    ...r,
    headers: { ...r.headers },
});
const hostKey = (req: AdapterRequest, cfg: StitchConfig): string => {
    if (cfg.throttle?.scope === 'host') {
        try {
            return new URL(req.url).host;
        } catch {
            /* fall through */
        }
    }
    return nameOf(cfg);
};

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
    return evt;
}
const doneEvt = (ok: boolean, t0: number, attempts: number): StitchEvent => ({
    type: 'done',
    ok,
    ms: now() - t0,
    attempts,
    at: now(),
});

async function validateInput(
    cfg: StitchConfig,
    input: StitchInput,
): Promise<void> {
    for (const part of [
        'params',
        'query',
        'body',
        'headers',
        'variables',
    ] as const) {
        // `input.*` is widened to SchemaLike for authoring ergonomics, but `compose` →
        // `normalizeInput` has already coerced every present slot to a Validator by now.
        // `variables` (the graphql surface's primary input) validates here too; the validated
        // value still flows untouched into the `{ query, variables }` body the surface packs.
        const v = cfg.input?.[part] as Validator | undefined;
        if (!v) continue;
        const r = await v.validate((input as Record<string, unknown>)[part]);
        if (!r.ok) {
            const e = new Error(
                `invalid ${part}: ${r.issues.map((i) => i.message).join(', ')}`,
            );
            e.name = 'ValidationError';
            throw e;
        }
    }
}

// Schema validation + drift leveling for ONE value, without the snapshot step. Shared by the
// buffered `output` check below and the per-`delta` streaming check (ADR 0005 Addendum): a schema
// failure on a `watch` (but not `critical`) path is a warning, otherwise an error. A bare validator
// `output` (no DriftSpec) has empty watch/critical, so every failure is an error.
async function validateSchema(
    cfg: StitchConfig,
    value: unknown,
): Promise<DriftFinding[]> {
    const out = cfg.output;
    if (!out) return [];
    // Probe cast keeps `__kind` `unknown`, so this is a real comparison — not an always-true
    // check against the `'drift'` literal (the idiom used by `outputSchemaSource`).
    const isDrift = (out as { __kind?: unknown }).__kind === 'drift';
    const validator: Validator = isDrift
        ? (out as DriftSpec).schema
        : (out as Validator);
    const opts = isDrift ? (out as DriftSpec).options : {};
    const r = await validator.validate(value);
    if (r.ok) return [];
    const findings: DriftFinding[] = [];
    for (const iss of r.issues) {
        const path = iss.path.join('.');
        const level =
            matchAny(opts.watch, path) && !matchAny(opts.critical, path)
                ? 'warn'
                : 'error';
        findings.push({ level, path, change: 'invalid', detail: iss.message });
    }
    return findings;
}

async function validateOutput(
    cfg: StitchConfig,
    body: unknown,
): Promise<DriftFinding[]> {
    const out = cfg.output;
    if (!out) return [];
    // Schema + leveling first, then the snapshot baseline (whole-body only — see validateSchema).
    const findings: DriftFinding[] = await validateSchema(cfg, body);
    if ((out as { __kind?: unknown }).__kind === 'drift') {
        const opts = (out as DriftSpec).options;
        if (opts.snapshotFile) {
            const snap = loadSnapshot(opts.snapshotFile);
            if (snap === undefined) saveSnapshot(opts.snapshotFile, body);
            else findings.push(...classifyDrift(body, snap, opts));
        }
    }
    return findings;
}

// `timeout.total` is a WALL-CLOCK budget for the whole logical call: every attempt,
// backoff sleep, and throttle wait counts against one shared deadline (GAP-AUDIT §1.1).
interface TotalBudget {
    deadline: number; // epoch ms after which the call must fail with a timeout
    totalMs: number; // configured total, kept for the error message
}

function totalBudget(cfg: StitchConfig, t0: number): TotalBudget | undefined {
    const totalMs = parseDuration(cfg.timeout?.total);
    return totalMs == null ? undefined : { deadline: t0 + totalMs, totalMs };
}

const budgetError = (b: TotalBudget): TimeoutError =>
    new TimeoutError(`timed out after ${b.totalMs}ms`);

// Sleep `ms`, but never past the budget's deadline — when the budget would run out
// mid-wait, wait only the remainder and fail with the timeout error.
async function sleepWithin(ms: number, budget?: TotalBudget): Promise<void> {
    if (budget == null) return sleep(ms);
    const remaining = budget.deadline - now();
    if (remaining <= ms) {
        if (remaining > 0) await sleep(remaining);
        throw budgetError(budget);
    }
    return sleep(ms);
}

// Acquire a throttle slot, but never wait past the budget's deadline. The underlying
// acquire has no abort path, so on timeout the still-pending grant is handed straight
// back via release() to keep the limiter's accounting intact.
async function acquireWithin(
    throttle: Runtime['throttle'],
    key: string,
    budget?: TotalBudget,
    opts?: AcquireOptions,
): Promise<{ waitedMs: number }> {
    if (budget == null) return throttle.acquire(key, opts);
    const remaining = budget.deadline - now();
    if (remaining <= 0) throw budgetError(budget);
    const pending = throttle.acquire(key, opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            // A rate-only acquire (streaming, Decision 12) holds no concurrency slot, so there is
            // nothing to hand back on timeout; only a slot-taking acquire is released here.
            if (!opts?.rateOnly)
                void pending.then(
                    () => {
                        throttle.release(key);
                    },
                    () => {
                        /* a rejected acquire holds no slot */
                    },
                );
            reject(budgetError(budget));
        }, remaining);
    });
    try {
        return await Promise.race([pending, expiry]);
    } finally {
        clearTimeout(timer);
    }
}

async function* attemptLoop(
    rt: Runtime,
    baseReq: AdapterRequest,
    state: { attempts: number },
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, AdapterResponse> {
    const { cfg } = rt;
    const max = cfg.retry?.attempts ?? 1;
    const retryOn = cfg.retry?.on ?? [429, 502, 503, 504];
    const perAttemptMs = parseDuration(cfg.timeout?.perAttempt);
    const key = hostKey(baseReq, cfg);
    let refreshed = false;

    for (let attempt = 1; attempt <= max; attempt++) {
        state.attempts = attempt;
        const { waitedMs } = await acquireWithin(rt.throttle, key, budget);
        if (waitedMs > 0)
            yield {
                type: 'progress',
                phase: 'throttled',
                attempt,
                waitedMs,
                at: now(),
            };
        try {
            const req = cloneReq(baseReq);
            if (cfg.auth) {
                const infos: StitchEvent[] = [];
                await cfg.auth.apply(req, emitInto(rt.authCtx, infos));
                yield* infos;
            }
            await cfg.hooks?.onRequest?.({ name: nameOf(cfg), attempt, req });
            yield { type: 'progress', phase: 'request', attempt, at: now() };

            // Clamp this attempt's abort to whatever is left of the total budget.
            const attemptMs =
                budget == null
                    ? perAttemptMs
                    : Math.min(
                          perAttemptMs ?? Infinity,
                          Math.max(0, budget.deadline - now()),
                      );
            let res: AdapterResponse;
            try {
                res = await withTimeout(
                    (signal) => rt.adapter({ ...req, signal }),
                    attemptMs,
                    req.signal, // link a caller's AbortSignal (e.g. a download's) to this attempt
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
                await cfg.auth.refresh(emitInto(rt.authCtx, infos));
                yield* infos;
                attempt--; // redo this attempt with fresh auth, don't count it
                continue;
            }

            if (retryOn.includes(res.status) && attempt < max) {
                const ra = cfg.retry?.respectRetryAfter
                    ? parseRetryAfter(res.headers['retry-after'])
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
                );
                continue;
            }

            if (res.status >= 400) {
                const e = new Error(`HTTP ${res.status}`) as Error & {
                    status: number;
                    response: AdapterResponse;
                };
                e.status = res.status;
                e.response = res;
                throw e;
            }
            return res;
        } finally {
            rt.throttle.release(key);
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
    state: { attempts: number },
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, AdapterResponse> {
    const { cfg } = rt;
    if (!cfg.circuit) {
        return yield* attemptLoop(rt, baseReq, state, budget);
    }
    const circuit = createCircuit(cfg.circuit, rt.store, hostKey(baseReq, cfg));
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
        const res = yield* attemptLoop(rt, baseReq, state, budget);
        await circuit.onSuccess();
        return res;
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

function mergeInput(a: StitchInput, b: StitchInput): StitchInput {
    return {
        params: { ...(a.params ?? {}), ...(b.params ?? {}) },
        query: { ...(a.query ?? {}), ...(b.query ?? {}) },
        headers: { ...(a.headers ?? {}), ...(b.headers ?? {}) },
        body: b.body !== undefined ? b.body : a.body,
    };
}

// Pagination: one logical call that follows pages until `paginate.next` returns undefined
// (or `max` is hit), aggregating items. Each page is a full request — auth/retry/throttle apply.
async function* paginated(
    rt: Runtime,
    input: StitchInput,
    state: { attempts: number },
    t0: number,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const name = nameOf(cfg);
    const pg = cfg.paginate!;
    const max = pg.max ?? 50;
    const acc: unknown[] = [];
    let pageInput = input;
    let page = 0;
    let lastStatus = 200;

    const first = buildRequest(cfg, pageInput);
    yield {
        type: 'start',
        name,
        method: first.method,
        url: first.url,
        input,
        at: now(),
    };

    for (;;) {
        const req = buildRequest(cfg, pageInput);
        let res: AdapterResponse;
        try {
            res = yield* attemptWithCircuit(rt, req, state, budget);
        } catch (e) {
            yield errEvt(e, name, state.attempts);
            yield doneEvt(false, t0, state.attempts);
            return;
        }
        lastStatus = res.status;

        // The surface interprets each page (graphql's "200-with-`errors`" failure) — same as the
        // non-paginated path.
        const outcome = interpretResponse(cfg, res);
        if (!outcome.ok) {
            yield surfaceErrEvt(outcome, name, state.attempts);
            yield doneEvt(false, t0, state.attempts);
            return;
        }

        let value: unknown = outcome.value;
        if (cfg.transform) value = await cfg.transform(value);
        if (cfg.unwrap) value = getPath(value, cfg.unwrap);
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

    const findings = await validateOutput(cfg, acc);
    let fatal = false;
    for (const finding of findings) {
        yield { type: 'drift', finding, at: now() };
        if (finding.level === 'error') fatal = true;
    }
    if (fatal) {
        yield {
            type: 'error',
            name,
            message: 'contract violation (drift)',
            status: lastStatus,
            attempts: state.attempts,
            at: now(),
        };
        yield doneEvt(false, t0, state.attempts);
        return;
    }

    yield {
        type: 'result',
        value: acc,
        status: lastStatus,
        attempts: state.attempts,
        at: now(),
    };
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
        m.createCache({
            config,
            store: rt.store,
            stitchId: m.cacheStitchId(cfg),
            // The RAW output schema (not the Validator wrapper) so the fingerprinter can read its
            // `~standard.vendor`; transform/unwrap are already raw on the config (ADR 0004 fold).
            output: outputSchemaSource(cfg),
            transform: cfg.transform,
            unwrap: cfg.unwrap,
            ...(rt.authCtx.principal !== undefined
                ? { principal: rt.authCtx.principal }
                : {}),
        }),
    );
    return rt.cacheInit;
}

// `normalizeOutput`/`drift()` wrap `output` through `toValidator`, which hides the original
// `~standard`. The wrapper keeps a non-enumerable `source` back-reference to the raw schema; unwrap
// it (and the `DriftSpec.schema` layer) so the fingerprinter sees the real Zod/Valibot/… instance.
// Falls back to the wrapper itself when no source was recorded — that is simply un-fingerprintable
// (a custom Validator/predicate), which the resolver handles by refusing or re-validating.
function outputSchemaSource(cfg: StitchConfig): unknown {
    const out = cfg.output;
    if (!out) return undefined;
    // Cast to a probe shape (not `DriftSpec`) so `__kind` stays `unknown` — a real comparison, not
    // an always-true one against the `'drift'` literal.
    const isDrift = (out as { __kind?: unknown }).__kind === 'drift';
    const validator = isDrift ? (out as DriftSpec).schema : out;
    return (validator as { source?: unknown }).source ?? validator;
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
    | { ok: true; value: unknown; status: number; vary?: string }
    | { ok: false };

const startEvt = (
    name: string,
    baseReq: AdapterRequest,
    input: StitchInput,
): StitchEvent => ({
    type: 'start',
    name,
    method: baseReq.method,
    url: baseReq.url,
    input,
    at: now(),
});

const cacheEvt = (detail: string): StitchEvent => ({
    type: 'progress',
    phase: 'cache',
    attempt: 0,
    detail,
    at: now(),
});

const resultEvt = (
    value: unknown,
    status: number,
    attempts: number,
): StitchEvent => ({ type: 'result', value, status, attempts, at: now() });

// Interpret a buffered response into a result value via the surface's `interpret` hook (graphql's
// "200-with-`errors`" failure lives there). No surface / no hook → the body is the value.
function interpretResponse(
    cfg: StitchConfig,
    res: AdapterResponse,
): SurfaceOutcome {
    return cfg.kind?.interpret
        ? cfg.kind.interpret(res, cfg)
        : { ok: true, value: res.body };
}

// Build the `error` event for a surface that interpreted the response as a failure.
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
    if (outcome.status !== undefined) evt.status = outcome.status;
    return evt;
}

// The resilience chain from the request onward (no `start` event — the caller emits it). Returns
// the validated outcome so the cache layer can store/share it; on any failure it yields the
// error/done events and returns `{ ok: false }`.
async function* runFrom(
    rt: Runtime,
    baseReq: AdapterRequest,
    name: string,
    state: { attempts: number },
    t0: number,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, RunOutcome> {
    const { cfg } = rt;
    let res: AdapterResponse;
    try {
        res = yield* attemptWithCircuit(rt, baseReq, state, budget);
    } catch (e) {
        yield errEvt(e, name, state.attempts);
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }

    // The surface interprets the response (graphql's "200-with-`errors`-is-a-failure" lives in
    // its interpret hook); with no hook the body is the value. Then transform → unwrap → validate.
    const outcome = interpretResponse(cfg, res);
    if (!outcome.ok) {
        yield surfaceErrEvt(outcome, name, state.attempts);
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }
    let value: unknown = outcome.value;
    if (cfg.transform) value = await cfg.transform(value);
    if (cfg.unwrap) value = getPath(value, cfg.unwrap);
    const findings = await validateOutput(cfg, value);
    let fatal = false;
    for (const finding of findings) {
        yield { type: 'drift', finding, at: now() };
        if (finding.level === 'error') fatal = true;
    }
    if (fatal) {
        yield {
            type: 'error',
            name,
            message: 'contract violation (drift)',
            status: res.status,
            attempts: state.attempts,
            at: now(),
        };
        yield doneEvt(false, t0, state.attempts);
        return { ok: false };
    }

    yield resultEvt(value, res.status, state.attempts);
    yield doneEvt(true, t0, state.attempts);
    const vary = res.headers['vary'];
    return vary !== undefined
        ? { ok: true, value, status: res.status, vary }
        : { ok: true, value, status: res.status };
}

// Streaming surfaces (sse/stream): open the LIVE body and decode it into `delta` chunks via the
// surface's `stream` hook (ADR 0005 Decisions 4-5). Deliberately lean — no retry/circuit/cache:
// Decision 12 puts broken-stream retry out of scope, and streaming bypasses the cache. It charges
// the rate gate ONCE at open but takes NO concurrency slot (a rate-only acquire, never released),
// so a long-lived connection can never pin a seam's concurrency budget (Decision 12). The await/
// `consume` path resolves to the COLLECTED array of every emitted chunk — the terminal `result`
// mirrors the delta spine (Stage 5 sub-decision); `.stream()` yields the chunks incrementally and
// buffers nothing. transform/unwrap reshape a whole buffered body and are NOT applied here; the
// `output` contract, by contrast, validates each chunk before its `delta` is emitted (per-`delta`,
// via the surface's `contractValue` hook — ADR 0005 Addendum), snapshot-drift omitted.
async function* runStreaming(
    rt: Runtime,
    input: StitchInput,
    name: string,
    state: { attempts: number },
    t0: number,
    budget?: TotalBudget,
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const streamHook = cfg.kind?.stream;
    if (!streamHook) return; // unreachable: only entered for a streaming surface

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
    yield startEvt(name, baseReq, input);
    state.attempts = 1;

    // Charge the rate limiter once at open, but take NO concurrency slot (Decision 12). A rate
    // wait still surfaces as a `throttled` event.
    let waitedMs: number;
    try {
        ({ waitedMs } = await acquireWithin(
            rt.throttle,
            hostKey(baseReq, cfg),
            budget,
            { rateOnly: true },
        ));
    } catch (e) {
        yield errEvt(e, name, 1);
        yield doneEvt(false, t0, 1);
        return;
    }
    if (waitedMs > 0)
        yield {
            type: 'progress',
            phase: 'throttled',
            attempt: 1,
            waitedMs,
            at: now(),
        };

    let res: AdapterResponse;
    try {
        const req = cloneReq(baseReq);
        if (cfg.auth) await cfg.auth.apply(req, rt.authCtx);
        await cfg.hooks?.onRequest?.({ name, attempt: 1, req });
        yield { type: 'progress', phase: 'request', attempt: 1, at: now() };
        res = await rt.adapter(req);
        await cfg.hooks?.onResponse?.({ name, attempt: 1, res });
    } catch (e) {
        await cfg.hooks?.onError?.({ name, attempt: 1, error: e });
        yield errEvt(e, name, 1);
        yield doneEvt(false, t0, 1);
        return;
    }

    if (res.status >= 400) {
        const e = new Error(`HTTP ${res.status}`) as Error & { status: number };
        e.status = res.status;
        yield errEvt(e, name, 1);
        yield doneEvt(false, t0, 1);
        return;
    }

    // Decode the live body into `delta` chunks; collect them so the await path resolves to the
    // whole sequence (Stage 5 sub-decision). With an `output` contract set, validate each chunk
    // BEFORE its `delta` is emitted (ADR 0005 Addendum): a `critical`/schema failure fails the
    // stream — the bad value is never delivered or collected — while a `watch` finding warns and
    // the delta still flows. `contractValue` picks the part to validate (sse → the event `data`),
    // defaulting to the whole chunk; matches the buffered path's drift→error handling in `runFrom`.
    const chunks: unknown[] = [];
    try {
        for await (const chunk of streamHook(res, cfg)) {
            if (cfg.output) {
                const target = cfg.kind?.contractValue
                    ? cfg.kind.contractValue(chunk)
                    : chunk;
                let fatal = false;
                for (const finding of await validateSchema(cfg, target)) {
                    yield { type: 'drift', finding, at: now() };
                    if (finding.level === 'error') fatal = true;
                }
                if (fatal) {
                    yield {
                        type: 'error',
                        name,
                        message: 'contract violation (drift)',
                        status: res.status,
                        attempts: 1,
                        at: now(),
                    };
                    yield doneEvt(false, t0, 1);
                    return;
                }
            }
            chunks.push(chunk);
            yield { type: 'delta', chunk, at: now() };
        }
    } catch (e) {
        yield errEvt(e, name, 1);
        yield doneEvt(false, t0, 1);
        return;
    }

    yield resultEvt(chunks, res.status, 1);
    yield doneEvt(true, t0, 1);
}

// A single uncached run: build the request, emit `start`, then run the chain.
async function* runOnce(
    rt: Runtime,
    input: StitchInput,
    name: string,
    state: { attempts: number },
    t0: number,
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
    yield startEvt(name, baseReq, input);
    return yield* runFrom(rt, baseReq, name, state, t0, budget);
}

// The cached path: lookup is OUTERMOST over the expensive chain; a hit short-circuits
// throttle/circuit/network/transform/output-validation; a miss runs the full chain (collapsed by
// in-process coalescing) and writes the validated result to the cache LAST (ADR 0003 §7).
async function* runCached(
    rt: Runtime,
    ctl: CacheController,
    input: StitchInput,
    name: string,
    state: { attempts: number },
    t0: number,
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
    yield startEvt(name, baseReq, input);

    // 'refuse' (ADR 0004): the output contract can't be soundly fingerprinted (no strategy for the
    // vendor / a non-Standard-Schema validator / an opaque un-versioned transform) and the caller
    // did not opt into re-validate-on-hit — fail closed, never store, and surface WHY for traces.
    if (ctl.policy === 'refuse') {
        yield cacheEvt(`bypass: ${ctl.reason}`);
        yield* runFrom(rt, baseReq, name, state, t0, budget);
        return;
    }

    // A non-cacheable method (a mutation sharing a fragment) runs normally, uncached.
    if (!ctl.cacheableMethod(baseReq.method)) {
        yield* runFrom(rt, baseReq, name, state, t0, budget);
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
        yield* runFrom(rt, baseReq, name, state, t0, budget);
        return;
    }

    const d = describe(baseReq);
    const key = ctl.key(d, input);
    if (key === undefined) {
        yield cacheEvt('bypass: unhashable request');
        yield* runFrom(rt, baseReq, name, state, t0, budget);
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
            for (const finding of await validateOutput(cfg, found.value)) {
                yield { type: 'drift', finding, at: now() };
                if (finding.level === 'error') stale = true;
            }
        }
        if (!stale) {
            yield cacheEvt(ctl.revalidateOnHit ? 'hit (revalidated)' : 'hit');
            yield resultEvt(found.value, found.status, 0);
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
        await store(yield* runFrom(rt, baseReq, name, state, t0, budget));
        return;
    }

    // In-process coalescing: the leader runs the chain; followers await its one shared result.
    const claim = ctl.join(key);
    if (claim.leader) {
        let out: RunOutcome;
        try {
            out = yield* runFrom(rt, baseReq, name, state, t0, budget);
        } catch (e) {
            claim.fail(e);
            throw e;
        }
        if (out.ok) {
            await store(out);
            claim.settle({ value: out.value, status: out.status });
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
        await store(yield* runFrom(rt, baseReq, name, state, t0, budget));
        return;
    }
    yield cacheEvt('coalesced');
    yield resultEvt(shared.value, shared.status, 0);
    yield doneEvt(true, t0, 0);
}

export async function* execute(
    rt: Runtime,
    input: StitchInput = {},
): AsyncGenerator<StitchEvent, void> {
    const { cfg } = rt;
    const name = nameOf(cfg);
    const t0 = now();
    const state = { attempts: 0 };
    const budget = totalBudget(cfg, t0);

    try {
        await validateInput(cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }

    // Streaming surfaces (sse/stream) take a dedicated path: open the live body and emit `delta`
    // chunks (Decisions 4-5). Streaming bypasses pagination and the cache, and is exempt from the
    // concurrency bucket (Decision 12). Checked before both so neither can wrap a live stream.
    if (cfg.kind?.stream) {
        yield* runStreaming(rt, input, name, state, t0, budget);
        return;
    }

    if (cfg.paginate) {
        yield* paginated(rt, input, state, t0, budget);
        return;
    }

    // Cache lookup is OUTERMOST over the expensive chain but AFTER input validation, so a hit can
    // never tunnel an invalid call past the boundary and the key mirrors the resolved request.
    const ctl = await ensureCache(rt);
    if (ctl) {
        yield* runCached(rt, ctl, input, name, state, t0, budget);
        return;
    }

    yield* runOnce(rt, input, name, state, t0, budget);
}

// ---- cache surfaces (lazy; no static cache import on the hot path) ---------
/** Exact, single-entry eviction for the call `input` would make. A no-op for an uncached or
 *  non-cacheable-method stitch. Backs `stitch.invalidate(input)` (ADR 0003 §8). */
export async function cacheInvalidateExact(
    rt: Runtime,
    input: StitchInput = {},
): Promise<void> {
    const ctl = await ensureCache(rt);
    if (!ctl) return;
    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(rt.cfg, input);
    } catch {
        return;
    }
    if (!ctl.cacheableMethod(baseReq.method)) return;
    const d = describe(baseReq);
    const key = ctl.key(d, input);
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

/** The derived opaque key for `input`, for introspection. Backs `stitch.cache.key(input)`. */
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
    return ctl.key(describe(baseReq), input);
}

export async function executeRaw(
    rt: Runtime,
    input: StitchInput = {},
): Promise<AdapterResponse> {
    const baseReq = buildRequest(rt.cfg, input);
    const state = { attempts: 0 };
    const gen = attemptLoop(rt, baseReq, state, totalBudget(rt.cfg, now()));
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    return step.value;
}
