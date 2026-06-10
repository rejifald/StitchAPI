// The authoring surface: stitch() + the three composition facades (extends / defineStitch /
// builder) + `.with()` partial application, all resolving to one canonical config.
import { execute, executeRaw, makeRuntime, type Runtime } from './engine';
import { createTrace } from './trace';
import { createThrottle } from './resilience';
import {
    isStitch,
    type DriftOptions,
    type DriftSpec,
    type Hooks,
    type InputSchemas,
    type Stitch,
    type StitchConfig,
    type StitchInput,
    type StitchResult,
    type TraceSink,
} from './types';
import { deepMerge } from './util';
import { toValidator, type Validator } from './validator';

type Fragment = Partial<StitchConfig> | Stitch | string;

// ---- composition ----------------------------------------------------------
function asConfig(f: Fragment): Partial<StitchConfig> {
    if (typeof f === 'string') return { path: f };
    if (isStitch(f)) return f.__config;
    return f;
}

function flatten(layers: Fragment[]): Partial<StitchConfig>[] {
    const out: Partial<StitchConfig>[] = [];
    for (const layer of layers) {
        const cfg = asConfig(layer);
        if (cfg.extends) out.push(...flatten(cfg.extends as Fragment[]));
        const { extends: _drop, ...rest } = cfg;
        out.push(rest);
    }
    return out;
}

function chainHooks(layers: Hooks[]): Hooks | undefined {
    if (!layers.length) return undefined;
    const keys: (keyof Hooks)[] = ['onRequest', 'onResponse', 'onError', 'onRetry'];
    const merged: Hooks = {};
    for (const k of keys) {
        const fns = layers.map((h) => h[k]).filter(Boolean) as Array<(c: never) => unknown>;
        if (!fns.length) continue;
        // onResponse/onError/onRetry unwind child→base; onRequest runs base→child.
        const ordered = k === 'onRequest' ? fns : fns.slice().reverse();
        merged[k] = async (ctx: never) => {
            for (const fn of ordered) await fn(ctx);
        };
    }
    return merged;
}

function normalizeOutput(out: StitchConfig['output']): StitchConfig['output'] {
    if (!out) return undefined;
    if ((out as DriftSpec).__kind === 'drift') return out;
    return toValidator(out) as Validator;
}

function normalizeInput(input: InputSchemas | undefined): InputSchemas | undefined {
    if (!input) return undefined;
    const out: InputSchemas = {};
    for (const k of ['params', 'query', 'body', 'headers'] as const) {
        if (input[k]) out[k] = toValidator(input[k]) as Validator;
    }
    return out;
}

function compose(config: Fragment): StitchConfig {
    const layers = flatten([config]);
    let merged: Partial<StitchConfig> = {};
    const hookLayers: Hooks[] = [];
    for (const layer of layers) {
        if (layer.hooks) hookLayers.push(layer.hooks);
        merged = deepMerge(merged, { ...layer, hooks: undefined });
    }
    merged.hooks = chainHooks(hookLayers);
    merged.output = normalizeOutput(merged.output);
    merged.input = normalizeInput(merged.input);
    return merged as StitchConfig;
}

// ---- shared trace sink (zero-infra: console off in tests, JSONL file) ------
function getTrace(): TraceSink {
    return createTrace({
        console: process.env.STITCH_TRACE_CONSOLE === '1',
        file: process.env.STITCH_TRACE_FILE || undefined,
    });
}

// ---- the streaming spine + await sugar ------------------------------------
async function consume<T>(gen: AsyncGenerator<{ type: string } & Record<string, unknown>>): Promise<T> {
    let result: T | undefined;
    let failure: { message?: string; status?: number } | undefined;
    for await (const ev of gen) {
        if (ev.type === 'result') result = ev.value as T;
        else if (ev.type === 'error') failure = ev as { message?: string; status?: number };
    }
    if (failure) {
        const e = new Error(failure.message ?? 'stitch failed') as Error & { status?: number };
        e.name = 'StitchError';
        e.status = failure.status;
        throw e;
    }
    return result as T;
}

function tee<T>(
    gen: AsyncGenerator<import('./types').StitchEvent<T>, void, unknown>,
    trace: TraceSink,
    name: string,
): AsyncGenerator<import('./types').StitchEvent<T>, void, unknown> {
    async function* wrapped() {
        for await (const ev of gen) {
            trace.handle(ev, { name });
            yield ev;
        }
    }
    return wrapped();
}

function mergeInput(a: StitchInput = {}, b: StitchInput = {}): StitchInput {
    return {
        params: { ...(a.params ?? {}), ...(b.params ?? {}) },
        query: { ...(a.query ?? {}), ...(b.query ?? {}) },
        headers: { ...(a.headers ?? {}), ...(b.headers ?? {}) },
        body: b.body !== undefined ? b.body : a.body,
    };
}

function makeStitch<T = unknown>(config: Fragment): Stitch<T> {
    const cfg = compose(config);
    const rt: Runtime = makeRuntime(cfg, createThrottle(cfg.throttle), getTrace());
    const name = cfg.name ?? cfg.path ?? 'stitch';

    const streamFn = (input?: StitchInput) => tee<T>(execute(rt, input ?? {}) as never, rt.trace, name);

    const result = (input?: StitchInput): StitchResult<T> => {
        const make = () => streamFn(input);
        return {
            then: (onF, onR) => consume<T>(make() as never).then(onF, onR),
            catch: (onR: (e: unknown) => unknown) => consume<T>(make() as never).catch(onR),
            stream: () => make(),
        } as StitchResult<T>;
    };

    const stitchFn = result as unknown as Stitch<T> & {
        __raw: (input?: StitchInput) => Promise<unknown>;
    };
    stitchFn.stream = streamFn;
    stitchFn.with = (partial: StitchInput) => {
        // bind partial input; the bound stitch reuses the same runtime (cookies/throttle persist)
        const bound = ((input?: StitchInput) => result(mergeInput(partial, input))) as unknown as Stitch<T> & {
            __raw: (input?: StitchInput) => Promise<unknown>;
        };
        bound.stream = (input?: StitchInput) => streamFn(mergeInput(partial, input));
        bound.with = (more: StitchInput) => stitchFn.with(mergeInput(partial, more));
        bound.__raw = (input?: StitchInput) => executeRaw(rt, mergeInput(partial, input));
        Object.defineProperty(bound, '__config', { value: cfg });
        Object.defineProperty(bound, '__stitch', { value: true });
        return bound;
    };
    stitchFn.__raw = (input?: StitchInput) => executeRaw(rt, input ?? {});
    Object.defineProperty(stitchFn, '__config', { value: cfg });
    Object.defineProperty(stitchFn, '__stitch', { value: true });
    return stitchFn;
}

// ---- public API -----------------------------------------------------------
export interface StitchFn {
    <T = unknown>(config: string | (Partial<StitchConfig> & { path?: string })): Stitch<T>;
    use(...fragments: Fragment[]): Builder;
}

export const stitch: StitchFn = Object.assign(
    <T = unknown>(config: string | Partial<StitchConfig>) => makeStitch<T>(config as Fragment),
    {
        use: (...fragments: Fragment[]) => makeBuilder({ extends: fragments }),
    },
);

/** preset(): a named bundle of reusable defaults (just an identity-tagged fragment). */
export const preset = (cfg: Partial<StitchConfig>): Partial<StitchConfig> => cfg;

/** defineStitch(): bind base fragments, return a stitch() factory (evolution of prestitch). */
export function defineStitch(...fragments: Fragment[]) {
    return <T = unknown>(config: string | Partial<StitchConfig>): Stitch<T> => {
        const c: Partial<StitchConfig> = typeof config === 'string' ? { path: config } : { ...config };
        c.extends = [...fragments, ...((c.extends as Fragment[]) ?? [])] as StitchConfig['extends'];
        return makeStitch<T>(c);
    };
}

/** drift(): wrap an output schema with leveled drift options. */
export function drift(schema: unknown, options: DriftOptions = {}): DriftSpec {
    return { __kind: 'drift', schema: toValidator(schema) as Validator, options };
}

/** graphql(): a stitch preset for GraphQL-over-HTTP — POST { query, variables }, unwrap `data`. */
export function graphql<T = unknown>(config: Partial<StitchConfig> & { query: string }): Stitch<T> {
    return makeStitch<T>({ ...config, kind: 'graphql', method: 'POST', unwrap: config.unwrap ?? 'data' });
}

// ---- fluent builder facade ------------------------------------------------
export interface Builder {
    (input?: StitchInput): StitchResult<unknown>;
    use(...f: Fragment[]): Builder;
    get(path: string): Builder;
    post(path: string): Builder;
    put(path: string): Builder;
    delete(path: string): Builder;
    returns(schema: unknown): Builder;
    unwrap(key: string): Builder;
    auth(a: StitchConfig['auth']): Builder;
    retry(r: StitchConfig['retry']): Builder;
    throttle(t: StitchConfig['throttle']): Builder;
    timeout(t: StitchConfig['timeout']): Builder;
    stream(input?: StitchInput): ReturnType<Stitch['stream']>;
    with(partial: StitchInput): Stitch;
}

function makeBuilder(initial: Partial<StitchConfig>): Builder {
    const acc: Partial<StitchConfig> = { ...initial };
    let built: Stitch | null = null;
    const ensure = () => (built ??= makeStitch(acc));
    const invalidate = () => (built = null);

    const fn = ((input?: StitchInput) => ensure()(input)) as Builder;
    fn.use = (...f) => ((acc.extends = [...((acc.extends as Fragment[]) ?? []), ...f] as StitchConfig['extends']), invalidate(), fn);
    fn.get = (p) => ((acc.method = 'GET'), (acc.path = p), invalidate(), fn);
    fn.post = (p) => ((acc.method = 'POST'), (acc.path = p), invalidate(), fn);
    fn.put = (p) => ((acc.method = 'PUT'), (acc.path = p), invalidate(), fn);
    fn.delete = (p) => ((acc.method = 'DELETE'), (acc.path = p), invalidate(), fn);
    fn.returns = (schema) => ((acc.output = schema as StitchConfig['output']), invalidate(), fn);
    fn.unwrap = (key) => ((acc.unwrap = key), invalidate(), fn);
    fn.auth = (a) => ((acc.auth = a), invalidate(), fn);
    fn.retry = (r) => ((acc.retry = r), invalidate(), fn);
    fn.throttle = (t) => ((acc.throttle = t), invalidate(), fn);
    fn.timeout = (t) => ((acc.timeout = t), invalidate(), fn);
    fn.stream = (input) => ensure().stream(input);
    fn.with = (partial) => ensure().with(partial);
    return fn;
}
