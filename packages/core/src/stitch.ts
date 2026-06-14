// The authoring surface: stitch() + the extends composition facade +
// `.with()` partial application, all resolving to one canonical config. For a shared surface —
// shared runtime + a trusted principal boundary — reach for `seam` (see seam.ts).
import {
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
import { createThrottle } from './resilience';
import { createStoreThrottle, memoryStore } from './store';
import { consoleSink, createTrace, exportsFromEnv, multiplex } from './trace';
import {
    type DriftOptions,
    type DriftSpec,
    type HookContext,
    type Hooks,
    type InputSchemas,
    type Stitch,
    type StitchConfig,
    type StitchEvent,
    type StitchInput,
    type StitchResult,
    type StitchStore,
    type TraceSink,
    isStitch,
} from './types';
import { deepMerge, readEnv } from './util';
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
    for (const k of ['params', 'query', 'body', 'headers'] as const) {
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
    for (const layer of layers) {
        if (layer.hooks) hookLayers.push(layer.hooks);
        if (layer.store) store = layer.store;
        // hooks/store are accumulated above; strip them so deepMerge only folds the rest
        // (exactOptionalPropertyTypes forbids spreading them back in as `undefined`).
        const rest = { ...layer };
        delete rest.hooks;
        delete rest.store;
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

function getTrace(): TraceSink {
    const file = fileFromEnv(readEnv('STITCH_TRACE_FILE'));
    const base = createTrace({
        console: readEnv('STITCH_TRACE_CONSOLE') === '1',
        file,
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
async function consume<T>(
    gen: AsyncGenerator<{ type: string } & Record<string, unknown>>,
): Promise<T> {
    let result: T | undefined;
    let failure: { message?: string; status?: number } | undefined;
    for await (const ev of gen) {
        if (ev.type === 'result') result = ev['value'] as T;
        else if (ev.type === 'error')
            failure = ev as { message?: string; status?: number };
    }
    if (failure) {
        const e = new Error(failure.message ?? 'stitch failed') as Error & {
            status?: number;
        };
        e.name = 'StitchError';
        if (failure.status !== undefined) e.status = failure.status;
        throw e;
    }
    return result as T;
}

function tee<T>(
    gen: AsyncGenerator<StitchEvent<T>, void>,
    trace: TraceSink,
    name: string,
): AsyncGenerator<StitchEvent<T>, void> {
    async function* wrapped() {
        for await (const ev of gen) {
            trace.handle(ev, { name });
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
    delete rest.store;
    delete rest.auth;
    delete rest.adapter;
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

    const streamFn = (input?: StitchInput) =>
        tee<T>(execute(rt, input ?? {}) as never, rt.trace, name);

    const result = (input?: StitchInput): StitchResult<T> => {
        const make = () => streamFn(input);
        return {
            then: (onF, onR) => consume<T>(make() as never).then(onF, onR),
            catch: (onR: (e: unknown) => unknown) =>
                consume<T>(make() as never).catch(onR),
            stream: () => make(),
        } as StitchResult<T>;
    };

    const stitchFn = result as unknown as Stitch<T> & {
        __raw: (input?: StitchInput) => Promise<unknown>;
    };
    stitchFn.stream = streamFn;
    stitchFn.with = (partial: StitchInput) => {
        // bind partial input; the bound stitch reuses the same runtime (cookies/throttle persist)
        const bound = ((input?: StitchInput) =>
            result(mergeInput(partial, input))) as unknown as Stitch<T> & {
            __raw: (input?: StitchInput) => Promise<unknown>;
        };
        bound.stream = (input?: StitchInput) =>
            streamFn(mergeInput(partial, input));
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
     */
    <
        TExplicit = never,
        C extends Partial<StitchConfig> = Partial<StitchConfig>,
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
    C extends Partial<StitchConfig> & {
        query: string;
    } = Partial<StitchConfig> & {
        query: string;
    },
>(config: C): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>> {
    return makeStitch<ResolveOutput<TExplicit, C>>({
        ...config,
        kind: 'graphql',
        method: 'POST',
        unwrap: config.unwrap ?? 'data',
    });
}
