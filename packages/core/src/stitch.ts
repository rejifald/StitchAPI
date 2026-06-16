// The authoring surface: stitch() + the extends composition facade +
// `.with()` partial application, all resolving to one canonical config. For a shared surface —
// shared runtime + a trusted principal boundary — reach for `seam` (see seam.ts).
import {
    ERROR_SOURCE,
    type Runtime,
    cacheInvalidateBulk,
    cacheInvalidateExact,
    cacheKeyOf,
    execute,
    executeRaw,
    makeRuntime,
} from './engine';
import type { InferOutput, InputOf, ResolveOutput } from './infer';
import { otlpTrace } from './otlp';
import { RateLimitError, createThrottle } from './resilience';
import { createStoreThrottle, memoryStore } from './store';
import { graphqlSurface } from './surface';
import { consoleSink, createTrace, exportsFromEnv, multiplex } from './trace';
import {
    type DriftOptions,
    type DriftSpec,
    type HookContext,
    type Hooks,
    type InputSchemas,
    type RunContext,
    type SafeResult,
    type SecurityScheme,
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
import { deepMerge, newRunContext, readEnv } from './util';
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
            f.__config
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
    if ((out as DriftSpec).__kind === 'drift') return out;
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

export function compose(config: Fragment): StitchConfig {
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
    }
    const hooks = chainHooks(hookLayers);
    if (hooks) merged.hooks = hooks;
    if (store) merged.store = store;
    if (kind) merged.kind = kind;
    const output = normalizeOutput(merged.output);
    if (output !== undefined) merged.output = output;
    const input = normalizeInput(merged.input);
    if (input !== undefined) merged.input = input;
    return merged;
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
    const base = createTrace({
        console: readEnv('STITCH_TRACE_CONSOLE') === '1',
        file,
        ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    });
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
//     caller keeps the real class identity plus `retryAfterMs`/`response`.
//   • a plain HTTP error carrying `.response` (issue #155): flatten into a StitchError, lifting the
//     response `body`/`url` onto the error so a result-shaped caller can read the API's error
//     payload (`{ error: "…" }`) it would otherwise never see.
async function drain<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
): Promise<{ value: T } | { error: Error }> {
    let value: T | undefined;
    let error: Error | undefined;
    for await (const ev of gen) {
        if (ev.type === 'result') value = ev.value;
        else if (ev.type === 'error') {
            const source = (ev as { [ERROR_SOURCE]?: Error })[ERROR_SOURCE];
            const res =
                source === undefined
                    ? undefined
                    : (
                          source as {
                              response?: { body?: unknown; url?: string };
                          }
                      ).response;
            // A pinned HTTP error (has `.response`, but is neither a StitchError nor a
            // RateLimitError): rebuild as a StitchError carrying the response `body`/`url`. A
            // RateLimitError keeps its class identity (re-surfaced unchanged) so the delegate-backoff
            // caller still gets `retryAfterMs`/`response`.
            if (
                res !== undefined &&
                !(source instanceof StitchError) &&
                !(source instanceof RateLimitError)
            ) {
                error = new StitchError(ev.message, {
                    status: ev.status,
                    attempts: ev.attempts,
                    body: res.body,
                    url: res.url,
                    cause: source,
                });
            } else {
                error =
                    source ??
                    new StitchError(ev.message, {
                        status: ev.status,
                        attempts: ev.attempts,
                    });
            }
        }
    }
    return error ? { error } : { value: value as T };
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
    const ctx = {
        name,
        runId: run.runId,
        traceId: run.traceId,
        ...(run.parentId !== undefined ? { parentId: run.parentId } : {}),
    };
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
    principal?: string;
    register?: (s: Stitch) => void;
}

// `__config` is the PUBLIC view; strip the live secret-bearing handles so the running store,
// credential, and transport cannot be read back off a stitch (ADR 0002 §4/§6, exfil-at-rest).
// The full config lives on `__rawConfig` for fragment composition (see `asConfig`).
export function redactConfig(cfg: StitchConfig): StitchConfig {
    const rest = { ...cfg };
    // Project the auth's NON-SECRET scheme onto the public config (always derived from the live
    // `auth`, never trusted from an externally-set `authScheme`) BEFORE stripping the live,
    // secret-bearing strategy. Like `kind`→id below, this is the public identity of a redacted
    // capability: a stitch's auth round-trips as JSON (the contract gate) and feeds
    // `export --openapi`'s `securitySchemes`, while the credential itself stays unreachable.
    delete (rest as { authScheme?: unknown }).authScheme;
    if (cfg.auth?.scheme)
        (rest as { authScheme?: SecurityScheme }).authScheme = cfg.auth.scheme;
    delete rest.store;
    delete rest.auth;
    delete rest.adapter;
    // Normalise the surface to its id string so __config round-trips as JSON (ADR 0005
    // Decision 11): never expose the live Surface (its hooks don't serialise), only its identity.
    if (rest.kind) (rest as { kind?: unknown }).kind = rest.kind.id;
    return rest;
}

// Stamp the stitch identity: redacted public `__config`, full `__rawConfig`, and the `__stitch` brand.
function attachMeta(target: object, cfg: StitchConfig): void {
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
    // A seam injects shared instances; a standalone stitch builds its own (unchanged behaviour:
    // a store-backed throttle only when a `store` is configured, else the in-process limiter).
    const store = shared?.store ?? cfg.store ?? memoryStore();
    const throttle =
        shared?.throttle ??
        (cfg.store
            ? createStoreThrottle(cfg.throttle, store)
            : createThrottle(cfg.throttle));
    const trace = shared?.trace ?? resolveTrace(cfg.trace);
    const rtOpts: { vault?: StitchStore; principal?: string } = {};
    if (shared?.vault) rtOpts.vault = shared.vault;
    if (shared?.principal !== undefined) rtOpts.principal = shared.principal;
    const rt: Runtime = makeRuntime(cfg, throttle, trace, store, rtOpts);
    const name = cfg.name ?? cfg.path ?? 'stitch';

    // One run per consumption (ADR 0007): mint the identity here so `tee`'s sink ctx and the
    // engine's `start` event share it. Each `.stream()` / awaited call is its own run.
    const streamFn = (input?: StitchInput) => {
        const run = newRunContext();
        return tee<T>(
            execute(rt, input ?? {}, run) as never,
            rt.trace,
            name,
            run,
        );
    };

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
    };
    stitchFn.stream = streamFn;
    stitchFn.safe = (input?: StitchInput) => consumeSafe<T>(streamFn(input));
    stitchFn.unwrap = (input?: StitchInput) => consume<T>(streamFn(input));
    stitchFn.with = (partial: StitchInput) => {
        // bind partial input; the bound stitch reuses the same runtime (cookies/throttle persist)
        const bound = ((input?: StitchInput) =>
            result(mergeInput(partial, input))) as unknown as Stitch<T> & {
            __raw: (input?: StitchInput) => Promise<unknown>;
        };
        bound.stream = (input?: StitchInput) =>
            streamFn(mergeInput(partial, input));
        bound.safe = (input?: StitchInput) =>
            consumeSafe<T>(streamFn(mergeInput(partial, input)));
        bound.unwrap = (input?: StitchInput) =>
            consume<T>(streamFn(mergeInput(partial, input)));
        bound.with = (more: StitchInput) =>
            stitchFn.with(mergeInput(partial, more));
        bound.__raw = (input?: StitchInput) =>
            executeRaw(rt, mergeInput(partial, input));
        attachMeta(bound, cfg);
        attachCacheSurface(bound, rt, (input) => mergeInput(partial, input));
        return bound;
    };
    stitchFn.__raw = (input?: StitchInput) => executeRaw(rt, input ?? {});
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
