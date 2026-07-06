// The authoring surface: stitch() + the extends composition facade +
// `.with()` partial application, all resolving to one canonical config. For a shared surface —
// shared runtime + a trusted principal boundary — reach for `seam` (see seam.ts).
import { compact } from './compact';
import {
    ERROR_SOURCE,
    RAW_BODY,
    type RunFlags,
    type Runtime,
    cacheInvalidateBulk,
    cacheInvalidateExact,
    cacheKeyOf,
    execute,
    executeRaw,
    executeRawTraced,
    makeRuntime,
} from './engine';
import type { InferOutput, InputOf, ResolveOutput } from './infer';
import { otlpTrace } from './otlp';
import { RateLimitError, createThrottle } from './resilience';
import { createStoreThrottle, memoryStore } from './store';
import { graphqlSurface } from './surface';
import { consoleSink, createTrace, exportsFromEnv, multiplex } from './trace';
import {
    type CacheOutcome,
    type Clock,
    type DriftFinding,
    type DriftOptions,
    type DriftSpec,
    type HookContext,
    type Hooks,
    type IdempotencyOptions,
    type InputSchemas,
    type InspectOptions,
    type Inspection,
    type RedactedStitchConfig,
    type ResolvedStitchConfig,
    type RunContext,
    type RunReport,
    type SafeResult,
    type Stitch,
    type StitchConfig,
    StitchError,
    type StitchEvent,
    type StitchInput,
    type StitchResult,
    type StitchStore,
    type TraceSink,
    isStitch,
} from './types';
import {
    deepMerge,
    newRunContext,
    readEnv,
    redactSecretsDeep,
    systemClock,
} from './util';
import { type Validator, toValidator } from './validator';

export type Fragment = Partial<StitchConfig> | Stitch | string;

// ---- composition ----------------------------------------------------------
function asConfig(f: Fragment): Partial<StitchConfig> {
    if (typeof f === 'string') return { path: f };
    // Compose from the FULL config (`__rawConfig`), not the redacted public `__config`, so a
    // stitch used as a fragment still carries its store/auth/adapter into the merge.
    if (isStitch(f))
        return (
            (f as Stitch & { __rawConfig?: StitchConfig }).__rawConfig ??
            // Defensive: `attachMeta` always stamps `__rawConfig`, so this redacted-config fallback
            // never runs; cast through `unknown` because the redacted `kind` is a string id, not a
            // live `Surface`.
            (f.__config as unknown as Partial<StitchConfig>)
        );
    return f;
}

function flatten(layers: Fragment[]): Partial<StitchConfig>[] {
    const out: Partial<StitchConfig>[] = [];
    for (const layer of layers) {
        const cfg = asConfig(layer);
        if (cfg.extends) out.push(...flatten(cfg.extends));
        const rest = { ...cfg };
        delete (rest as { extends?: unknown }).extends;
        out.push(rest);
    }
    return out;
}

function chainHooks(layers: Hooks[]): Hooks | undefined {
    if (!layers.length) return undefined;
    const keys: (keyof Hooks)[] = [
        'onRequest',
        'onResponse',
        'onError',
        'onRetry',
    ];
    const merged: Hooks = {};
    for (const k of keys) {
        const fns = layers.map((h) => h[k]).filter(Boolean) as ((
            c: HookContext,
        ) => unknown)[];
        if (!fns.length) continue;
        // onResponse/onError/onRetry unwind child→base; onRequest runs base→child.
        const ordered = k === 'onRequest' ? fns : fns.slice().reverse();
        const chained = async (ctx: HookContext) => {
            for (const fn of ordered) await fn(ctx);
        };
        (merged as Record<string, unknown>)[k] = chained;
    }
    return merged;
}

function normalizeOutput(out: StitchConfig['output']): StitchConfig['output'] {
    if (!out) return undefined;
    if ((out as Partial<DriftSpec>).__kind === 'drift') return out;
    return toValidator(out);
}

function normalizeInput(
    input: InputSchemas | undefined,
): InputSchemas | undefined {
    if (!input) return undefined;
    const out: InputSchemas = {};
    for (const k of [
        'params',
        'query',
        'body',
        'headers',
        'variables',
    ] as const) {
        const schema = input[k];
        if (!schema) continue;
        const v = toValidator(schema);
        if (v) out[k] = v;
    }
    return out;
}

// Expand the scalar shorthands (`retry: 3`, `timeout: '5s'`, `cache: '1m'`) to their object form
// IN PLACE, before the deep-merge, so a literal in one layer folds cleanly into an object in
// another and the resolved config the engine reads is always the normalised shape.
function expandShorthand(cfg: Partial<StitchConfig>): void {
    if (typeof cfg.retry === 'number') cfg.retry = { attempts: cfg.retry };
    if (typeof cfg.timeout === 'number' || typeof cfg.timeout === 'string')
        cfg.timeout = { total: cfg.timeout };
    if (typeof cfg.cache === 'number' || typeof cfg.cache === 'string')
        cfg.cache = { ttl: cfg.cache };
    // P20: `idempotency: true` enables it with defaults; `false`/absent is off. Normalize the
    // boolean toggle to the object form the engine reads (the opaque `idempotency: {}` is a type
    // error at the slot, so the all-defaults case arrives here as `true`).
    if (cfg.idempotency === true)
        (cfg as { idempotency?: IdempotencyOptions }).idempotency = {};
    else if (cfg.idempotency === false) delete cfg.idempotency;
}

export function compose(config: Fragment): ResolvedStitchConfig {
    const layers = flatten([config]);
    let merged: Partial<StitchConfig> = {};
    const hookLayers: Hooks[] = [];
    let store: StitchStore | undefined;
    let kind: StitchConfig['kind'];
    for (const layer of layers) {
        if (layer.hooks) hookLayers.push(layer.hooks);
        if (layer.store) store = layer.store;
        // The surface is an atomic value (last-writer-wins), never deep-merged — merging two
        // Surface objects would corrupt their hooks/identity (ADR 0005 Decision 2).
        if (layer.kind) kind = layer.kind;
        // hooks/store/kind are accumulated above; strip them so deepMerge only folds the rest
        // (exactOptionalPropertyTypes forbids spreading them back in as `undefined`).
        const rest = { ...layer };
        delete rest.hooks;
        delete rest.store;
        delete rest.kind;
        // Capture the raw `idempotency` toggle BEFORE `expandShorthand` normalizes it away — a
        // child `idempotency: false` must clear an inherited object (see the reconcile below), but
        // `expandShorthand` deletes `false` from this layer, so `deepMerge` would never see it and
        // the inherited value would silently survive (P20 violation).
        const idempotencyToggle = layer.idempotency;
        expandShorthand(rest);
        merged = deepMerge(merged, rest);
        // Endpoint slot: `url` and `baseUrl`/`path` are two spellings of the same target, and
        // deepMerge keeps them as separate keys. Reconcile so the last fragment to write either
        // spelling wins the whole slot — a child `url` clears an inherited baseUrl/path, and a
        // child baseUrl/path clears an inherited `url`.
        if (rest.url !== undefined) {
            delete merged.baseUrl;
            delete merged.path;
        } else if (rest.baseUrl !== undefined || rest.path !== undefined) {
            delete merged.url;
        }
        // Idempotency slot (P20): last-writer-wins on the on/off toggle, like the endpoint slot
        // above. `expandShorthand` turns `true`→`{}` (folded by deepMerge) but drops `false`
        // entirely, so a child `idempotency: false` can't undo an inherited `idempotency: true`
        // through the merge alone — reconcile it here, clearing the slot when this layer is the
        // last to set it and set it off.
        if (idempotencyToggle === false) delete merged.idempotency;
    }
    const hooks = chainHooks(hookLayers);
    if (hooks) merged.hooks = hooks;
    if (store) merged.store = store;
    if (kind) merged.kind = kind;
    const output = normalizeOutput(merged.output);
    if (output !== undefined) merged.output = output;
    const input = normalizeInput(merged.input);
    if (input !== undefined) merged.input = input;
    // `expandShorthand` ran on every layer, so retry/timeout/cache are now their object form.
    return merged as ResolvedStitchConfig;
}

// Construction-time nudges for `idempotency` misuse — hints with an out, never errors. Two cases,
// both silenced by `idempotency.warn = false` and both scoped to the **default HTTP surface**: a
// surface (graphql → POST) can force the method after construction, so its writes aren't knowable
// here, and we don't guess.
//   1. On a read (GET/HEAD) the engine drops the key (writes only) — almost always a missing
//      `method`, so the write protection the author expects silently isn't there.
//   2. The *random* default key only dedupes a replay of the same request, and `retry` is what
//      replays it; with no `retry` it usually has nothing to collapse. (Not useless in every case —
//      a proxy/transport resending the request below the stitch carries the same key for a server
//      to dedupe — hence a hint, not an error. A *derived* `keyOf` dedupes resubmissions on its own.)
function warnIdempotency(cfg: ResolvedStitchConfig): void {
    const idem = cfg.idempotency;
    if (!idem || idem.warn === false || cfg.kind) return;
    const name = cfg.name ?? cfg.path ?? 'stitch';
    const method = (cfg.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
        console.warn(
            `stitchapi: \`${name}\` sets \`idempotency\` on a ${method}, but the key is sent on ` +
                `writes only — set \`method: 'POST'\`, or drop \`idempotency\`.`,
        );
        return;
    }
    // A derived key (either spelling — `keyOf`, or the @deprecated `key` alias) dedupes
    // resubmissions on its own, so only the random default with no retry is the inert case.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `key` is the back-compat alias of `keyOf` (CONTRACT.md P6)
    if (idem.keyOf || idem.key || cfg.retry) return;
    console.warn(
        `stitchapi: \`${name}\` has \`idempotency\` with a random key and no \`retry\`, so it ` +
            `only dedupes its own retries — add \`retry\`, or set \`idempotency.keyOf\`.`,
    );
}

// ---- the trace sink — off by default (a stitch's only effect is its call) ------
// Nothing is printed or written unless you opt in: STITCH_TRACE_CONSOLE=1 streams a
// colored line per event to stderr, STITCH_TRACE_FILE=<path> appends JSONL, and
// STITCH_EXPORT=otlp ALSO fans the same events to an OTLP collector. With none set this
// resolves to a sink that drops every event.
//
// `STITCH_TRACE_FILE` unset → off (no side effects by default); '', '0', and 'false'
// (trimmed, case-insensitive) also mean off — never a file literally named that; any
// other value is the JSONL destination.
function fileFromEnv(value: string | undefined): string | false {
    if (value === undefined) return false; // unset → off (no side effects by default)
    const trimmed = value.trim();
    if (trimmed === '' || ['0', 'false'].includes(trimmed.toLowerCase()))
        return false;
    return value;
}

// `STITCH_TRACE_MAX_BODY` tunes JSONL body/result truncation: unset → the built-in
// default cap; `full` → full capture (no truncation); a non-negative integer → that
// character cap (`0` keeps only the marker). Anything else falls back to the default.
function maxBodyFromEnv(value: string | undefined): number | false | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'full') return false;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function getTrace(): TraceSink {
    const file = fileFromEnv(readEnv('STITCH_TRACE_FILE'));
    const maxBodyBytes = maxBodyFromEnv(readEnv('STITCH_TRACE_MAX_BODY'));
    const base = createTrace(
        compact({
            console: readEnv('STITCH_TRACE_CONSOLE') === '1',
            file,
            maxBodyBytes,
        }),
    );
    if (!exportsFromEnv(readEnv('STITCH_EXPORT')).includes('otlp')) return base;
    return multiplex(base, otlpTrace());
}

// A sink that drops every event — `trace: false` forces tracing off even when the
// STITCH_TRACE_* env vars are set.
const noopTrace: TraceSink = {
    handle(): void {
        /* tracing disabled: drop every event */
    },
    flush(): void {
        /* nothing buffered */
    },
};

// Resolve the sink for one stitch. A stitch-local `trace` wins over the environment:
// `false` forces it off, `'console'` streams to stderr, a TraceSink is used as-is, and
// unset falls back to the env-derived sink (itself off unless STITCH_TRACE_* opts in).
export function resolveTrace(trace: StitchConfig['trace']): TraceSink {
    if (trace === false) return noopTrace;
    if (trace === 'console') return consoleSink();
    if (trace) return trace;
    return getTrace();
}

// ---- the streaming spine + await sugar ------------------------------------
// Drain the event stream to its terminal: the `result` value, or the `error` event rebuilt as a
// typed StitchError (status + attempts preserved). Shared by the throwing and safe consumers.
//
// The non-enumerable ERROR_SOURCE key (engine.ts) pins the live error behind the event without
// leaking its payload into a trace sink. Two kinds ride it:
//   • a delegate-backoff RateLimitError (issue #145): re-surface THAT instance unchanged, so the
//     caller keeps the real class identity plus `retryAfter`/`response`.
//   • a plain HTTP error carrying `.response` (issue #155): flatten into a StitchError, lifting the
//     response `body`/`url` onto the error so a result-shaped caller can read the API's error
//     payload (`{ error: "…" }`) it would otherwise never see.
async function drain<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<{ value: T } | { error: Error }> {
    let value: T | undefined;
    let error: Error | undefined;
    for await (const ev of gen) {
        if (ev.type === 'result') value = ev.data;
        else if (ev.type === 'error') error = rebuildError(ev);
    }
    return error ? { error } : { value: value as T };
}

// Rebuild the terminal error from an `error` event, honouring the non-enumerable ERROR_SOURCE channel
// (engine.ts). Three kinds ride it: a delegate-backoff RateLimitError is re-surfaced UNCHANGED (the
// caller keeps its class identity + `retryAfter`/`response`); a plain HTTP error (`.response`, but
// not a StitchError/RateLimitError) is flattened into a StitchError carrying the response `body`/`url`;
// a contract-violation StitchError (pinned by `.inspect()`'s retain path) passes through. Absent a
// source, build a StitchError from the event's `status`/`attempts`. Shared by `drain` and
// `consumeInspect`.
function rebuildError(ev: Extract<StitchEvent, { type: 'error' }>): Error {
    const source = (ev as { [ERROR_SOURCE]?: Error })[ERROR_SOURCE];
    const res =
        source === undefined
            ? undefined
            : (source as { response?: { body?: unknown; url?: string } })
                  .response;
    if (
        res !== undefined &&
        !(source instanceof StitchError) &&
        !(source instanceof RateLimitError)
    ) {
        return new StitchError(ev.message, {
            status: ev.status,
            attempts: ev.attempts,
            body: res.body,
            url: res.url,
            cause: source,
        });
    }
    // A pass-through terminal — a delegate-backoff RateLimitError or a contract-violation StitchError
    // (`.inspect()` retain path) — is re-surfaced UNCHANGED.
    if (source instanceof StitchError || source instanceof RateLimitError)
        return source;
    // Otherwise a StitchError from the event, carrying any bare transport/internal `source` the engine
    // pinned (an undici UND_ERR_SOCKET / ECONNRESET, a DNS failure, an AbortError, …) as `cause` — so
    // callers can read `err.cause` (and its `.code`) to tell a socket reset from a generic "fetch
    // failed". Absent a source, no cause (unchanged). `cause` is non-enumerable, so it never leaks into
    // a trace sink.
    return new StitchError(
        ev.message,
        compact({ status: ev.status, attempts: ev.attempts, cause: source }),
    );
}

// Build the `Inspection` wrapper (ADR 0016 / ADR 0019): every field enumerable EXCEPT `raw`, which is
// defined non-enumerable so `JSON.stringify(wrapper)`, `{ ...wrapper }`, and trace walkers all skip
// the unredacted body — you reach for `wrapper.raw` deliberately. Mirrors the `__rawConfig`
// discipline. `source` (ADR 0019) rides as a normal enumerable field — it is the interpretant of `raw`.
function makeInspection<T>(
    value: T | null,
    raw: unknown,
    findings: DriftFinding[],
    status: number,
    error: StitchError | null,
    source: Inspection<T>['source'],
): Inspection<T> {
    // `data` is canonical; `value` is co-set as the @deprecated alias (CONTRACT.md P5).
    // `source` (ADR 0019) rides as a normal enumerable field — the interpretant of `raw`.
    const wrapper = {
        data: value,
        value,
        findings,
        status,
        error,
        source,
    } as Inspection<T>;
    // `enumerable: false` is the whole point; the other descriptor flags default false (the wrapper
    // is transient — nobody reassigns or reconfigures `raw`).
    Object.defineProperty(wrapper, 'raw', { value: raw, enumerable: false });
    return wrapper;
}

// What one drained run yields the inspect/report assemblers (ADR 0016 / 0019). `source` and `cache`
// are derived from the spine here so both consumers read the same interpretation. `attempts`,
// `timing`, and `waited` are collected for `.report()`; `.inspect()` simply ignores them.
interface Drained<T> {
    findings: DriftFinding[];
    value: T | null;
    raw: unknown;
    status: number;
    error: StitchError | null;
    source: Inspection<T>['source'];
    attempts: number;
    ms: number;
    waited: number;
    /** The `phase:'cache'` event detail seen this run, if any (e.g. 'hit', 'miss', 'bypass: …'). */
    cacheDetail: string | undefined;
}

// Drain ONE run off the event spine and gather everything inspect/report need — never throws.
// `findings` collect from every `drift` event; `value`/`status`/`attempts` from the terminal
// `result`; on a hard failure `value` stays `null` and `error` is the rebuilt StitchError. `raw`
// rides the non-enumerable RAW_BODY channel — on the `result` event for a success, on the pinned
// StitchError (recovered via ERROR_SOURCE) for a contract violation; it stays `null` when not
// retained (streaming / cache hit). `source` (ADR 0019) is derived from the spine: a `delta` event
// (the only streaming producer) ⇒ 'stream'; a `phase:'cache'` 'hit…' event ⇒ 'cache'; otherwise
// 'live' (a real request ran — a miss or the default bypass). `ms`/`waited`/`cacheDetail` back the
// `.report()` diagnostics.
async function drainRun<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<Drained<T>> {
    const findings: DriftFinding[] = [];
    let value: T | null = null;
    let raw: unknown = null;
    let status = 0;
    let error: StitchError | null = null;
    let streamed = false;
    let cacheHit = false;
    let attempts = 0;
    let ms = 0;
    let waited = 0;
    let cacheDetail: string | undefined;
    const readRaw = (carrier: object): void => {
        const r = (carrier as { [RAW_BODY]?: unknown })[RAW_BODY];
        if (r !== undefined) raw = r;
    };
    try {
        for await (const ev of gen) {
            if (ev.type === 'drift') findings.push(ev.finding);
            else if (ev.type === 'delta') streamed = true;
            else if (ev.type === 'progress') {
                if (typeof ev.waited === 'number') waited += ev.waited;
                if (ev.phase === 'cache') {
                    cacheDetail = ev.detail;
                    if (ev.detail?.startsWith('hit')) cacheHit = true;
                }
            } else if (ev.type === 'result') {
                value = ev.data;
                status = ev.status;
                attempts = ev.attempts;
                readRaw(ev);
            } else if (ev.type === 'error') {
                if (ev.status !== undefined) status = ev.status;
                attempts = ev.attempts;
                const rebuilt = rebuildError(ev);
                error = asStitchError(rebuilt);
                readRaw(rebuilt);
            } else if (ev.type === 'done') {
                ms = ev.elapsed;
                if (ev.attempts) attempts = ev.attempts;
            }
        }
    } catch (e) {
        // A stream that throws mid-drain (not an `error` event) still yields a never-throwing
        // result — surface the throw as `error`, leaving `value` null.
        error = asStitchError(e);
    }
    // `source` precedence (ADR 0019): a streaming surface wins (it can never buffer a body), then a
    // cache hit (the cache stores only `{ value, status }`), else a live request ran.
    const source: Inspection<T>['source'] = streamed
        ? 'stream'
        : cacheHit
          ? 'cache'
          : 'live';
    if (error !== null && attempts === 0) attempts = error.attempts;
    return {
        findings,
        value,
        raw,
        status,
        error,
        source,
        attempts,
        ms,
        waited,
        cacheDetail,
    };
}

// ADR 0018: opt-in redaction of `raw` — applied AFTER findings are computed so the diff runs on the
// unredacted body. `raw` is only non-null when a live request ran (streaming / cache hits stay
// null, so redaction is a no-op on null).
function redactRaw(raw: unknown, opts: InspectOptions | undefined): unknown {
    const { redact } = opts ?? {};
    return redact && raw !== null
        ? redactSecretsDeep(raw, Array.isArray(redact) ? redact : undefined)
        : raw;
}

// `.inspect()` consumer (ADR 0016 / ADR 0018 / ADR 0019): drain ONE run and assemble the
// `Inspection`, including the derived `source` — never throws.
async function consumeInspect<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
    opts?: InspectOptions,
): Promise<Inspection<T>> {
    const d = await drainRun<T>(gen);
    return makeInspection<T>(
        d.value,
        redactRaw(d.raw, opts),
        d.findings,
        d.status,
        d.error,
        d.source,
    );
}

// Map the drained `cacheDetail` to a `CacheOutcome` (ADR 0019). A real `phase:'cache'` event maps
// directly (`hit`/`hit (revalidated)`/`miss`); any runtime-`bypass: …` event also reads as `'bypass'`.
// With no cache event at all the outcome is decided by whether the stitch has a `cache` block:
// `'bypass'` when it does (the default `.report()` probe skipped it), else `'disabled'`.
function cacheOutcome(
    detail: string | undefined,
    hasCacheConfig: boolean,
): CacheOutcome {
    if (detail === 'hit') return 'hit';
    if (detail === 'hit (revalidated)') return 'hit (revalidated)';
    if (detail === 'miss') return 'miss';
    if (detail?.startsWith('bypass')) return 'bypass';
    // No cache event this run (default bypass, or a streaming/uncached path).
    return hasCacheConfig ? 'bypass' : 'disabled';
}

// `.report()` consumer (ADR 0019): the same drained run as `.inspect()`, assembled into a
// `RunReport` — the `Inspection` fields plus `attempts`, `timing` (`{ ms, waited? }`), the resolved
// redacted `config`, and the fine-grained `cache` outcome. `config` is the stitch's ALREADY-redacted
// `__config` (never `__rawConfig`). Never throws. `waited` is omitted entirely when nothing waited
// (exactOptionalPropertyTypes), so its absence reads as "no backoff/throttle wait".
async function consumeReport<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
    config: RedactedStitchConfig,
    opts?: InspectOptions,
): Promise<RunReport<T>> {
    const d = await drainRun<T>(gen);
    const base = makeInspection<T>(
        d.value,
        redactRaw(d.raw, opts),
        d.findings,
        d.status,
        d.error,
        d.source,
    );
    const timing: RunReport<T>['timing'] =
        d.waited > 0 ? { ms: d.ms, waited: d.waited } : { ms: d.ms };
    const report = base as RunReport<T>;
    report.attempts = d.attempts;
    report.timing = timing;
    report.config = config;
    report.cache = cacheOutcome(d.cacheDetail, config.cache !== undefined);
    return report;
}

// Throwing consumer: `await stitch(...)` / `stitch.unwrap(...)`. Rejects with the StitchError.
async function consume<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<T> {
    const out = await drain(gen);
    if ('error' in out) throw out.error;
    return out.value;
}

// Coerce any thrown value to a StitchError — a real StitchError passes through unchanged; anything
// else is wrapped with its message and original `cause`. A numeric `status` on the source (e.g. a
// delegate-backoff RateLimitError) is carried onto the wrapper so `.safe()` callers still see it.
// Shared by the safe consumers.
function asStitchError(e: unknown): StitchError {
    if (e instanceof StitchError) return e;
    const status = (e as { status?: unknown }).status;
    return new StitchError(e instanceof Error ? e.message : String(e), {
        ...(typeof status === 'number' ? { status } : {}),
        cause: e,
    });
}

// Safe consumer: `stitch.safe(...)` / `stitch(...).safe()`. Never throws — an `error` event or an
// unexpected throw both come back as `{ ok: false, data: null, error }`. `SafeResult.error` is
// always a StitchError by contract, so a non-StitchError terminal (e.g. a delegate-backoff
// RateLimitError, which the throwing path re-throws verbatim) is coerced via `asStitchError`,
// preserving the original as `.cause` and its `status`.
async function consumeSafe<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<SafeResult<T>> {
    try {
        const out = await drain(gen);
        return 'error' in out
            ? { ok: false, data: null, error: asStitchError(out.error) }
            : { ok: true, data: out.value, error: null };
    } catch (e) {
        return { ok: false, data: null, error: asStitchError(e) };
    }
}

function tee<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
    trace: TraceSink,
    name: string,
    run: RunContext,
): AsyncGenerator<StitchEvent<T>, void> {
    // Run identity (ADR 0007) is per-run-constant, so build the ctx once and hand it to the
    // sink with every event — the OTLP sink and the playground DAG collector read it to build
    // the span tree; a sink that reads only `ctx.name` is unaffected.
    const ctx = compact({
        name,
        spanId: run.spanId,
        traceId: run.traceId,
        parentSpanId: run.parentSpanId,
    });
    async function* wrapped() {
        for await (const ev of gen) {
            trace.handle(ev, ctx);
            yield ev;
        }
    }
    return wrapped();
}

function mergeInput(a: StitchInput = {}, b: StitchInput = {}): StitchInput {
    const merged: StitchInput = {
        params: { ...(a.params ?? {}), ...(b.params ?? {}) },
        query: { ...(a.query ?? {}), ...(b.query ?? {}) },
        headers: { ...(a.headers ?? {}), ...(b.headers ?? {}) },
        body: b.body !== undefined ? b.body : a.body,
    };
    // `variables` is a first-class StitchInput field (GraphQL's primary input). It was dropped
    // here, so `.with({ variables })` silently lost them; merge it like the rest. Omit the key
    // entirely when neither side sets it (exactOptionalPropertyTypes forbids `variables:
    // undefined`).
    if (a.variables ?? b.variables)
        merged.variables = { ...(a.variables ?? {}), ...(b.variables ?? {}) };
    // Per-call execution controls (signal/onProgress, ADR 0005): the call argument wins over a
    // bound value, so a `.with(...)`-bound download still honours a signal passed at call time.
    // Omit the key when neither side sets it (exactOptionalPropertyTypes).
    const signal = b.signal ?? a.signal;
    if (signal) merged.signal = signal;
    const onProgress = b.onProgress ?? a.onProgress;
    if (onProgress) merged.onProgress = onProgress;
    return merged;
}

/**
 * Shared runtime a {@link seam} injects into its member stitches: one `store`, one `vault`, one
 * trace sink, and one throttle bucket (a {@link chainThrottle} when a member tightens), plus the
 * bound `principal` and a `register` callback for the seam's registry. Omitted entirely for a
 * standalone `stitch()`, which builds its own runtime as before.
 */
export interface SharedRuntime {
    store: StitchStore;
    vault: StitchStore;
    trace: TraceSink;
    throttle: Runtime['throttle'];
    clock?: Clock;
    principal?: string;
    register?: (s: Stitch) => void;
}

// `__config` is the PUBLIC view; strip the live secret-bearing handles so the running store,
// credential, and transport cannot be read back off a stitch (ADR 0002 §4/§6, exfil-at-rest).
// The full config lives on `__rawConfig` for fragment composition (see `asConfig`).
export function redactConfig(cfg: ResolvedStitchConfig): RedactedStitchConfig {
    // Split off the live `Surface` so the spread carries no `kind: Surface`; the rest still holds
    // the live store/auth/adapter handles, stripped next.
    const { kind, ...spread } = cfg;
    const redacted = spread as RedactedStitchConfig & {
        store?: unknown;
        auth?: unknown;
        adapter?: unknown;
        clock?: unknown;
    };
    // Strip the live, secret-bearing handles so the running store, credential, and transport cannot
    // be read back off a stitch (ADR 0002 §4/§6, exfil-at-rest). The full config lives on the
    // non-enumerable `__rawConfig` for fragment composition (see `asConfig`).
    delete redacted.store;
    delete redacted.auth;
    delete redacted.adapter;
    delete redacted.clock;
    // Project the auth's NON-SECRET scheme onto the public config — always re-derived from the live
    // `auth`, never trusted from an externally-set `authScheme`. This is the public identity of a
    // redacted capability: the auth round-trips as JSON (the contract gate) and feeds
    // `export --openapi`'s `securitySchemes`, while the credential itself stays unreachable.
    delete redacted.authScheme;
    if (cfg.auth?.scheme) redacted.authScheme = cfg.auth.scheme;
    // Normalise the surface to its id string so __config round-trips as JSON (ADR 0005 Decision 11):
    // never expose the live Surface (its hooks don't serialise), only its identity.
    if (kind) redacted.kind = kind.id;
    return redacted;
}

// Stamp the stitch identity: redacted public `__config`, full `__rawConfig`, and the `__stitch` brand.
function attachMeta(target: object, cfg: ResolvedStitchConfig): void {
    Object.defineProperty(target, '__config', { value: redactConfig(cfg) });
    Object.defineProperty(target, '__rawConfig', { value: cfg });
    Object.defineProperty(target, '__stitch', { value: true });
}

// Attach the cache surface (ADR 0003 §8). All three lazily reach the cache engine via the
// runtime, so a cache-free stitch pays nothing and `import { stitch }` stays cache-free.
// `resolve` folds in any `.with(...)` partial so a bound stitch invalidates the right entry.
function attachCacheSurface(
    target: object,
    rt: Runtime,
    resolve: (input?: StitchInput) => StitchInput,
): void {
    Object.defineProperty(target, 'invalidate', {
        value: (input?: StitchInput) =>
            cacheInvalidateExact(rt, resolve(input)),
    });
    Object.defineProperty(target, 'cache', {
        value: {
            invalidate: () => cacheInvalidateBulk(rt),
            key: (input?: StitchInput) => cacheKeyOf(rt, resolve(input)),
        },
    });
}

export function makeStitch<T = unknown>(
    config: Fragment,
    shared?: SharedRuntime,
): Stitch<T> {
    const cfg = compose(config);
    warnIdempotency(cfg);
    // A seam injects shared instances; a standalone stitch builds its own (unchanged behaviour:
    // a store-backed throttle only when a `store` is configured, else the in-process limiter).
    const store = shared?.store ?? cfg.store ?? memoryStore();
    const clock = shared?.clock ?? cfg.clock ?? systemClock;
    const throttle =
        shared?.throttle ??
        (cfg.store
            ? createStoreThrottle(cfg.throttle, store, clock)
            : createThrottle(cfg.throttle, clock));
    const trace = shared?.trace ?? resolveTrace(cfg.trace);
    const rtOpts: { vault?: StitchStore; principal?: string; clock?: Clock } = {
        clock,
    };
    if (shared?.vault) rtOpts.vault = shared.vault;
    if (shared?.principal !== undefined) rtOpts.principal = shared.principal;
    const rt: Runtime = makeRuntime(cfg, throttle, trace, store, rtOpts);
    const name = cfg.name ?? cfg.path ?? 'stitch';

    // One traced run for `input` under a given run identity (ADR 0007). `streamFn` mints a fresh
    // ROOT run per consumption; composition (`linked`/`all`, stitchapi/pipe) supplies a CHILD run via
    // `__runWith`, so a step joins the scope's chain (its events tee with parentSpanId set).
    const streamWith = (
        input: StitchInput,
        run: RunContext,
        flags?: RunFlags,
    ) => tee<T>(execute(rt, input, run, flags) as never, rt.trace, name, run);
    const streamFn = (input?: StitchInput) =>
        streamWith(input ?? {}, newRunContext());
    // `.inspect()` (ADR 0016 / ADR 0018): one fresh root run with the raw body retained and the
    // cache bypassed by default (`{ cache: true }` opts caching back in). Consumed by the
    // never-throwing `consumeInspect`, which also applies opt-in redaction (ADR 0018).
    const inspectFn = (input: StitchInput, opts?: InspectOptions) =>
        consumeInspect<T>(
            streamWith(input, newRunContext(), {
                retainRaw: true,
                bypassCache: !opts?.cache,
            }),
            opts,
        );
    // `.report()` (ADR 0019): the same fresh, raw-retaining, cache-bypassing-by-default probe as
    // `.inspect()`, drained by `consumeReport` into a `RunReport` (the Inspection plus run
    // diagnostics). The config echo is the stitch's ALREADY-redacted `__config` — never `__rawConfig`.
    const reportConfig = redactConfig(cfg);
    const reportFn = (input: StitchInput, opts?: InspectOptions) =>
        consumeReport<T>(
            streamWith(input, newRunContext(), {
                retainRaw: true,
                bypassCache: !opts?.cache,
            }),
            reportConfig,
            opts,
        );

    const result = (input?: StitchInput): StitchResult<T> => {
        const make = () => streamFn(input);
        // Consume the stream at most ONCE and share that promise across then/catch/finally —
        // attaching more than one terminal handler must not re-run the call (the old code called
        // make() independently per handler, so then+catch ran the stitch twice). `stream()` stays a
        // separate, un-memoised consumption path (its own generator each time).
        let consumed: Promise<T> | undefined;
        const run = () => (consumed ??= consume<T>(make()));
        return {
            then: (onF, onR) => run().then(onF, onR),
            catch: (onR: (e: unknown) => unknown) => run().catch(onR),
            finally: (onF: (() => void) | null) => run().finally(onF),
            // `safe()` shares that same single run — converting its resolve/reject into the
            // SafeResult shape — so it never re-executes the call and never throws.
            safe: (): Promise<SafeResult<T>> =>
                run().then(
                    (data): SafeResult<T> => ({
                        ok: true,
                        data,
                        error: null,
                    }),
                    (e: unknown): SafeResult<T> => ({
                        ok: false,
                        data: null,
                        error: asStitchError(e),
                    }),
                ),
            stream: () => make(),
        } as StitchResult<T>;
    };

    const stitchFn = result as unknown as Stitch<T> & {
        __raw: (input?: StitchInput) => Promise<unknown>;
        __rawTraced: (
            input: StitchInput | undefined,
            parent: RunContext,
        ) => Promise<unknown>;
        __runWith: (
            input: StitchInput | undefined,
            run: RunContext,
        ) => Promise<unknown>;
    };
    stitchFn.stream = streamFn;
    stitchFn.safe = (input?: StitchInput) => consumeSafe<T>(streamFn(input));
    stitchFn.unwrap = (input?: StitchInput) => consume<T>(streamFn(input));
    stitchFn.inspect = (input?: StitchInput, opts?: InspectOptions) =>
        inspectFn(input ?? {}, opts);
    stitchFn.report = (input?: StitchInput, opts?: InspectOptions) =>
        reportFn(input ?? {}, opts);
    stitchFn.with = (partial: StitchInput) => {
        // bind partial input; the bound stitch reuses the same runtime (cookies/throttle persist)
        const bound = ((input?: StitchInput) =>
            result(mergeInput(partial, input))) as unknown as Stitch<T> & {
            __raw: (input?: StitchInput) => Promise<unknown>;
            __rawTraced: (
                input: StitchInput | undefined,
                parent: RunContext,
            ) => Promise<unknown>;
            __runWith: (
                input: StitchInput | undefined,
                run: RunContext,
            ) => Promise<unknown>;
        };
        bound.stream = (input?: StitchInput) =>
            streamFn(mergeInput(partial, input));
        bound.safe = (input?: StitchInput) =>
            consumeSafe<T>(streamFn(mergeInput(partial, input)));
        bound.unwrap = (input?: StitchInput) =>
            consume<T>(streamFn(mergeInput(partial, input)));
        bound.inspect = (input?: StitchInput, opts?: InspectOptions) =>
            inspectFn(mergeInput(partial, input), opts);
        bound.report = (input?: StitchInput, opts?: InspectOptions) =>
            reportFn(mergeInput(partial, input), opts);
        bound.with = (more: StitchInput) =>
            stitchFn.with(mergeInput(partial, more));
        bound.__raw = (input?: StitchInput) =>
            executeRaw(rt, mergeInput(partial, input));
        bound.__rawTraced = (input, parent) =>
            executeRawTraced(
                rt,
                mergeInput(partial, input),
                rt.trace,
                newRunContext(parent),
            );
        bound.__runWith = (input, run) =>
            consume<T>(streamWith(mergeInput(partial, input), run));
        attachMeta(bound, cfg);
        attachCacheSurface(bound, rt, (input) => mergeInput(partial, input));
        return bound;
    };
    stitchFn.__raw = (input?: StitchInput) => executeRaw(rt, input ?? {});
    // Traced login child-run (ADR 0007): cookieSession reaches this to run its login under the
    // caller's run. `newRunContext(parent)` inherits the parent's traceId + sets parentSpanId.
    stitchFn.__rawTraced = (input, parent) =>
        executeRawTraced(rt, input ?? {}, rt.trace, newRunContext(parent));
    // Run this stitch under a supplied run identity (ADR 0007) and resolve to its value — `linked`
    // mints a chain of run contexts and threads each step's here, so a step is a child of the prior.
    stitchFn.__runWith = (input, run) =>
        consume<T>(streamWith(input ?? {}, run));
    attachMeta(stitchFn, cfg);
    attachCacheSurface(stitchFn, rt, (input) => input ?? {});
    // A seam records the stitches it created (registry/lifecycle); standalone stitches don't register.
    shared?.register?.(stitchFn);
    return stitchFn;
}

// ---- public API -----------------------------------------------------------
export interface StitchFn {
    /**
     * Build a stitch from a config object. The result type is inferred from `config.output`'s
     * schema (Zod / Standard Schema / Validator / `drift()`) and the CALL-ARGUMENT type from the
     * `config.input` schemas (see {@link InputOf}), so no hand-written generic is needed. Supply one
     * explicitly — `stitch<Foo>(config)` — only to override the inferred result type; the explicit
     * generic always wins. Note: passing the explicit generic stops TypeScript from inferring the
     * config type, so the call argument falls back to the loose `StitchInput` in that form (a
     * limitation of partial type-argument inference — never worse than pre-inference).
     *
     * `const C` captures string-literal `path` / `url` (and other literals) instead of widening them to
     * `string`, so {@link InputOf} can read the RFC 6570 path-template vars off the literal and require
     * the matching `params` (Phase 2c). Schema *values* (Zod/Standard Schema) are reference types and so
     * are unaffected by the `const` modifier.
     */
    <
        TExplicit = never,
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /**
     * Non-inferring fallback: a bare path string, or any argument whose static type is the union
     * `string | Partial<StitchConfig>` (e.g. a wrapper that forwards either spelling). Neither can
     * match the inferring overload above, so the result is `Stitch<unknown>` — override with `<T>`.
     */
    <T = unknown>(config: string | Partial<StitchConfig>): Stitch<T>;
}

// The impl is the loose `<T>(config) => Stitch<T>`; the rich `InputOf<C>` lives only in the
// `StitchFn` overloads it is checked against. TypeScript's overload-assignability is lenient enough
// that no cast is needed here (the same reason `seam.ts`'s handle needs none).
export const stitch: StitchFn = <T = unknown>(
    config: string | Partial<StitchConfig>,
) => makeStitch<T>(config);

/**
 * drift(): wrap an output schema with leveled drift options. The wrapped contract type is
 * inferred from the schema, so `stitch({ output: drift(userSchema) })` still resolves to
 * `Stitch<User>`.
 */
export function drift<S>(
    schema: S,
    options: DriftOptions = {},
): DriftSpec<InferOutput<S>> {
    return {
        __kind: 'drift',
        schema: toValidator(schema) as Validator<InferOutput<S>>,
        options,
    };
}

/** graphql(): a stitch preset for GraphQL-over-HTTP — POST { query, variables }, unwrap `data`. */
export function graphql<
    TExplicit = never,
    const C extends Partial<StitchConfig> & {
        query: string;
    } = Partial<StitchConfig> & {
        query: string;
    },
>(config: C): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>> {
    // Default the endpoint to `/graphql` only when neither `url` nor `path` is given (preserves the
    // convenience without clobbering an explicit endpoint). Method/body shaping is the surface's.
    const endpointless = config.url === undefined && config.path === undefined;
    // The `as` retypes the loose `makeStitch` result (`Stitch<…, StitchInput>`) to the declared
    // `InputOf<C>` call-arg type. Now that `InputOf` reads `extends`-fragment schemas (#76) it is no
    // longer a clean supertype of `StitchInput` under an unresolved `C`, so this body needs the same
    // retype the inferring `stitch`/`seam` overloads get for free. Sound: the runtime stitch is
    // byte-identical; only the static call-arg richness is restored.
    return makeStitch<ResolveOutput<TExplicit, C>>({
        ...config,
        ...(endpointless ? { path: '/graphql' } : {}),
        kind: graphqlSurface,
        unwrap: config.unwrap ?? 'data',
    }) as unknown as Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
}
