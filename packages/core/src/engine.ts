// The execution engine: turns a resolved config + input into a stream of typed events.
// `execute` is an async generator (start → progress → drift → result → done); the await
// path consumes it to the result. `executeRaw` runs the request once and returns the raw
// response (used by cookieSession to read Set-Cookie from a login stitch).
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
import type {
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
        acquire(key: string): Promise<{ waitedMs: number }>;
        release(key: string): void;
    };
    trace: TraceSink;
    store: StitchStore;
    authCtx: AuthContext;
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

const nameOf = (cfg: StitchConfig) => cfg.name ?? cfg.path ?? 'stitch';

function joinUrl(base: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (!base) return path;
    return (
        base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path)
    );
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
    const isGql = cfg.kind === 'graphql';
    // Endpoint resolution: when `url` is set it IS the whole endpoint (no base), but still
    // templated + query-split like a path. Otherwise join `baseUrl` + `path`.
    const usingUrl = cfg.url !== undefined;
    const base = usingUrl ? '' : resolveStr(cfg.baseUrl);
    const raw = usingUrl
        ? resolveStr(cfg.url)
        : (cfg.path ?? (isGql ? '/graphql' : ''));
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
                'Set `url` to a full endpoint, or give a relative `path` a `baseUrl` (e.g. from a shared preset).',
        );
        e.name = 'StitchConfigError';
        throw e;
    }
    const method = (cfg.method ?? (isGql ? 'POST' : 'GET')).toUpperCase();
    const headers = { ...(cfg.headers ?? {}), ...(input.headers ?? {}) };
    applyIdempotency(cfg, input, method, headers);
    const bodyType = isGql ? 'json' : cfg.bodyType;
    return {
        url,
        method,
        headers,
        body: isGql
            ? {
                  query: cfg.query,
                  variables: input.variables ?? input.body ?? {},
              }
            : input.body,
        ...(bodyType !== undefined ? { bodyType } : {}),
        ...(cfg.responseType !== undefined
            ? { responseType: cfg.responseType }
            : {}),
    };
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
    for (const part of ['params', 'query', 'body', 'headers'] as const) {
        const v = cfg.input?.[part];
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

async function validateOutput(
    cfg: StitchConfig,
    body: unknown,
): Promise<DriftFinding[]> {
    const out = cfg.output;
    if (!out) return [];
    const findings: DriftFinding[] = [];
    const isDrift = (out as DriftSpec).__kind === 'drift';
    const validator: Validator | undefined = isDrift
        ? (out as DriftSpec).schema
        : (out as Validator);
    const opts = isDrift ? (out as DriftSpec).options : {};

    if (validator) {
        const r = await validator.validate(body);
        if (!r.ok) {
            for (const iss of r.issues) {
                const path = iss.path.join('.');
                const level =
                    matchAny(opts.watch, path) && !matchAny(opts.critical, path)
                        ? 'warn'
                        : 'error';
                findings.push({
                    level,
                    path,
                    change: 'invalid',
                    detail: iss.message,
                });
            }
        }
    }

    if (isDrift && opts.snapshotFile) {
        const snap = loadSnapshot(opts.snapshotFile);
        if (snap === undefined) saveSnapshot(opts.snapshotFile, body);
        else findings.push(...classifyDrift(body, snap, opts));
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
): Promise<{ waitedMs: number }> {
    if (budget == null) return throttle.acquire(key);
    const remaining = budget.deadline - now();
    if (remaining <= 0) throw budgetError(budget);
    const pending = throttle.acquire(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
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
            if (cfg.auth) await cfg.auth.apply(req, rt.authCtx);
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
                await cfg.auth.refresh(rt.authCtx);
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

        // GraphQL: a 200 response carrying `errors` is a failure — same as the non-paginated path.
        if (cfg.kind === 'graphql') {
            const body = res.body as
                | { errors?: { message?: string }[] }
                | null
                | undefined;
            const errs = body?.errors;
            if (errs?.length) {
                yield {
                    type: 'error',
                    name,
                    message: `GraphQL: ${errs.map((e) => e.message ?? 'error').join('; ')}`,
                    status: res.status,
                    attempts: state.attempts,
                    at: now(),
                };
                yield doneEvt(false, t0, state.attempts);
                return;
            }
        }

        let value: unknown = res.body;
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

    if (cfg.paginate) {
        yield* paginated(rt, input, state, t0, budget);
        return;
    }

    let baseReq: AdapterRequest;
    try {
        baseReq = buildRequest(cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }
    yield {
        type: 'start',
        name,
        method: baseReq.method,
        url: baseReq.url,
        input,
        at: now(),
    };

    let res: AdapterResponse;
    try {
        res = yield* attemptWithCircuit(rt, baseReq, state, budget);
    } catch (e) {
        yield errEvt(e, name, state.attempts);
        yield doneEvt(false, t0, state.attempts);
        return;
    }

    // GraphQL: a 200 response carrying `errors` is a failure.
    if (cfg.kind === 'graphql') {
        const errs = (res.body as { errors?: { message?: string }[] })?.errors;
        if (errs?.length) {
            yield {
                type: 'error',
                name,
                message: `GraphQL: ${errs.map((e) => e.message ?? 'error').join('; ')}`,
                status: res.status,
                attempts: state.attempts,
                at: now(),
            };
            yield doneEvt(false, t0, state.attempts);
            return;
        }
    }

    // transform (e.g. scrape HTML -> structured), then unwrap, then validate/drift the result.
    let value: unknown = res.body;
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
        return;
    }

    yield {
        type: 'result',
        value,
        status: res.status,
        attempts: state.attempts,
        at: now(),
    };
    yield doneEvt(true, t0, state.attempts);
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
