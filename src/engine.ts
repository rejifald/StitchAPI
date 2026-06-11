// The execution engine: turns a resolved config + input into a stream of typed events.
// `execute` is an async generator (start → progress → drift → result → done); the await
// path consumes it to the result. `executeRaw` runs the request once and returns the raw
// response (used by cookieSession to read Set-Cookie from a login stitch).
import { classifyDrift, loadSnapshot, saveSnapshot } from './drift';
import { fetchAdapter } from './http-adapter';
import {
    CircuitOpenError,
    backoffDelay,
    createCircuit,
    parseRetryAfter,
    withTimeout,
} from './resilience';
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
    buildQuery,
    expandPath,
    getPath,
    matchAny,
    now,
    parseDuration,
    sleep,
} from './util';
import type { Validator } from './validator';

import { randomUUID } from 'node:crypto';

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
): Runtime {
    const authCtx: AuthContext = { store, emit: () => {} };
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

function buildRequest(cfg: StitchConfig, input: StitchInput): AdapterRequest {
    const isGql = cfg.kind === 'graphql';
    const base =
        typeof cfg.baseUrl === 'function' ? cfg.baseUrl() : (cfg.baseUrl ?? '');
    const raw = cfg.path ?? (isGql ? '/graphql' : '');
    const qIdx = raw.indexOf('?');
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
    const { path } = expandPath(tpl, input.params ?? {});
    const query = { ...predefined, ...(input.query ?? {}) };
    const url = joinUrl(base, path) + buildQuery(query);
    const method = (cfg.method ?? (isGql ? 'POST' : 'GET')).toUpperCase();
    const headers = { ...(cfg.headers ?? {}), ...(input.headers ?? {}) };
    applyIdempotency(cfg, input, method, headers);
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
        bodyType: isGql ? 'json' : cfg.bodyType,
        responseType: cfg.responseType,
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
    return {
        type: 'error',
        name,
        message: e?.message ?? String(err),
        status: e?.status,
        attempts,
        at: now(),
    };
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

async function* attemptLoop(
    rt: Runtime,
    baseReq: AdapterRequest,
    state: { attempts: number },
): AsyncGenerator<StitchEvent, AdapterResponse> {
    const { cfg } = rt;
    const max = cfg.retry?.attempts ?? 1;
    const retryOn = cfg.retry?.on ?? [429, 502, 503, 504];
    const perAttemptMs =
        parseDuration(cfg.timeout?.perAttempt) ??
        parseDuration(cfg.timeout?.total);
    const key = hostKey(baseReq, cfg);
    let refreshed = false;

    for (let attempt = 1; attempt <= max; attempt++) {
        state.attempts = attempt;
        const { waitedMs } = await rt.throttle.acquire(key);
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

            let res: AdapterResponse;
            try {
                res = await withTimeout(
                    (signal) => rt.adapter({ ...req, signal }),
                    perAttemptMs,
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
                    await sleep(backoffDelay(attempt + 1, cfg.retry));
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
                await sleep(ra ?? backoffDelay(attempt + 1, cfg.retry));
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
): AsyncGenerator<StitchEvent, AdapterResponse> {
    const { cfg } = rt;
    if (!cfg.circuit) {
        return yield* attemptLoop(rt, baseReq, state);
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
        const res = yield* attemptLoop(rt, baseReq, state);
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
            res = yield* attemptWithCircuit(rt, req, state);
        } catch (e) {
            yield errEvt(e, name, state.attempts);
            yield doneEvt(false, t0, state.attempts);
            return;
        }
        lastStatus = res.status;

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

    try {
        await validateInput(cfg, input);
    } catch (e) {
        yield errEvt(e, name, 0);
        yield doneEvt(false, t0, 0);
        return;
    }

    if (cfg.paginate) {
        yield* paginated(rt, input, state, t0);
        return;
    }

    const baseReq = buildRequest(cfg, input);
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
        res = yield* attemptWithCircuit(rt, baseReq, state);
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
    const gen = attemptLoop(rt, baseReq, state);
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    return step.value;
}
