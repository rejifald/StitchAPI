// The `stitchapi/pipe` subpath (ADR 0008): the composition family. Compose stitches — and each other —
// into typed flows, sequential or parallel, that you `await` like any function. Every combinator
// returns the same callable shape, so they NEST. Each member runs as a CHILD run (ADR 0007 run
// identity), so a trace/DAG shows the tree. Bundle-frugal: reached only through this subpath.
//
//   - `pipe(...)` / `pipe.step(...)` — SEQUENTIAL: steps in order, each feeds the next, fail-fast. The
//     builder (`pipe.step`) types `prev` AND a `ctx` of named ancestors with no casts, and an inline
//     `{ k: node }` object fans out in parallel and merges its keys into `ctx`.
//   - `all({ k: node })` — PARALLEL, resolve when ALL succeed (fail-fast); a typed named object.
//   - `any([...])` — PARALLEL, resolve on the FIRST success (else `AggregateError`); failover.
//   - `race([...])` — PARALLEL, resolve on the FIRST to settle (win or lose); hedging.
//
// All parallel combinators AUTO-CANCEL the members that can no longer affect the result: `all` aborts
// its siblings on the first failure, `any` on the first success, `race` on the first settle — each via
// a per-run `AbortSignal` threaded onto every member call. There is deliberately NO `allSettled`
// (best-effort) variant; for that, compose `.safe()` members by hand.
import type { RunContext, Stitch, StitchInput } from './types';
import { newRunContext } from './util';

// The internal child-run invocation a node exposes (stitch.ts `__runWith`, and the combinators
// below): run under a supplied run identity and resolve to the value. Reached through a cast.
interface Runnable {
    __runWith: (
        input: StitchInput | undefined,
        run: RunContext,
    ) => Promise<unknown>;
}

/**
 * A composed flow — what every combinator returns. It is callable (`await composable(input)` runs it
 * as a root) and nests inside any other combinator (it carries the same child-run protocol a stitch
 * does). `__composable` brands it so a `{ k: node }` step is distinguishable from a single node.
 */
export interface Composable<Out> {
    (input?: StitchInput): Promise<Out>;
    readonly __composable: true;
}

/** A composition member: a single-endpoint {@link Stitch} or a nested {@link Composable}. */
export type Node<O = unknown> = Stitch<O> | Composable<O>;

// ---- abort plumbing (auto-cancel losers) ----------------------------------

/**
 * A controller whose `signal` is handed to every member of a parallel combinator. It is LINKED to the
 * caller's signal (an outer abort cancels the whole group), and the combinator aborts it the moment
 * the result is decided — cancelling the members that can no longer matter.
 */
function linkedController(parent?: AbortSignal): AbortController {
    const ctrl = new AbortController();
    if (parent) {
        if (parent.aborted) ctrl.abort(parent.reason);
        else
            parent.addEventListener(
                'abort',
                () => {
                    ctrl.abort(parent.reason);
                },
                { once: true },
            );
    }
    return ctrl;
}

// Run one member under the group's abort signal, as a child run of the group node. The group's signal
// REPLACES any inbound signal on the shared input (the inbound one is already linked into it).
function runMember(
    node: Node,
    input: StitchInput | undefined,
    signal: AbortSignal,
    groupRun: RunContext,
): Promise<unknown> {
    const memberInput: StitchInput = { ...input, signal };
    return (node as unknown as Runnable).__runWith(
        memberInput,
        newRunContext(groupRun),
    );
}

// Pre-handle each member so a cancelled member's late rejection is never an unhandled rejection (the
// combinator's own `await` is the single place a failure is observed).
function swallowLateRejections(settling: readonly Promise<unknown>[]): void {
    for (const p of settling) void p.catch(() => undefined);
}

// `all`: every member concurrently; resolve to a named object when ALL succeed; the FIRST failure
// aborts the rest and rejects. Members run as siblings under `groupRun`.
async function runAll(
    members: Record<string, Node>,
    input: StitchInput | undefined,
    groupRun: RunContext,
): Promise<Record<string, unknown>> {
    const ctrl = linkedController(input?.signal);
    const entries = Object.entries(members);
    const settling = entries.map(([, node]) =>
        runMember(node, input, ctrl.signal, groupRun),
    );
    swallowLateRejections(settling);
    try {
        const values = await Promise.all(settling);
        const out: Record<string, unknown> = {};
        entries.forEach(([k], i) => {
            out[k] = values[i];
        });
        return out;
    } catch (err) {
        ctrl.abort();
        throw err;
    }
}

// `all` over a positional array; resolve to a tuple when ALL succeed; the FIRST failure aborts the
// rest and rejects (the `Promise.all` shape, with auto-cancel + child runs).
async function runAllArray(
    members: readonly Node[],
    input: StitchInput | undefined,
    groupRun: RunContext,
): Promise<unknown[]> {
    const ctrl = linkedController(input?.signal);
    const settling = members.map((m) =>
        runMember(m, input, ctrl.signal, groupRun),
    );
    swallowLateRejections(settling);
    try {
        return await Promise.all(settling);
    } catch (err) {
        ctrl.abort();
        throw err;
    }
}

// `any`: every member concurrently; resolve on the FIRST success; if all fail, reject with the
// `AggregateError` of their errors. Abort the losers once a winner (or total failure) is known.
async function runAny(
    members: readonly Node[],
    input: StitchInput | undefined,
    groupRun: RunContext,
): Promise<unknown> {
    const ctrl = linkedController(input?.signal);
    const settling = members.map((m) =>
        runMember(m, input, ctrl.signal, groupRun),
    );
    swallowLateRejections(settling);
    try {
        return await Promise.any(settling);
    } finally {
        ctrl.abort();
    }
}

// `race`: every member concurrently; resolve/reject with the FIRST to SETTLE; abort the rest.
async function runRace(
    members: readonly Node[],
    input: StitchInput | undefined,
    groupRun: RunContext,
): Promise<unknown> {
    const ctrl = linkedController(input?.signal);
    const settling = members.map((m) =>
        runMember(m, input, ctrl.signal, groupRun),
    );
    swallowLateRejections(settling);
    try {
        return await Promise.race(settling);
    } finally {
        ctrl.abort();
    }
}

// ---- types -----------------------------------------------------------------

/** A node's resolved output — what `await node(...)` yields. Works for a stitch or a composable. */
type OutputOf<S extends Node> = Awaited<ReturnType<S>>;
/** Flatten an accumulated intersection into one object literal (readable hovers). */
type Prettify<T> = { [K in keyof T]: T[K] } & {};
/** The named-object output of a parallel bag `{ k: node }` — each key mapped to that node's output. */
type BagOut<M extends Record<string, Node>> = Prettify<{
    [K in keyof M]: OutputOf<M[K]>;
}>;
/** The tuple output of a positional `all([...])` — each member mapped to its output, in order. */
type TupleOut<T extends readonly Node[]> = { [K in keyof T]: OutputOf<T[K]> };

// ---- parallel combinators --------------------------------------------------

// Build a Composable from a `(input, groupRun) => Promise<Out>` core: callable mints a root run; the
// internal `__runWith` runs under the supplied child run (so it nests inside a pipe / another group).
function makeComposable<Out>(
    core: (
        input: StitchInput | undefined,
        groupRun: RunContext,
    ) => Promise<Out>,
): Composable<Out> {
    const fn = ((input?: StitchInput) =>
        core(input, newRunContext())) as Composable<Out> & Runnable;
    fn.__runWith = (input, run) => core(input, run);
    return Object.assign(fn, { __composable: true as const });
}

/**
 * Run nodes CONCURRENTLY and resolve when ALL succeed; fail-fast — the first to reject aborts the rest
 * and rejects the whole `all`. Two interchangeable forms (pick whichever reads better):
 *
 * - a NAMED object → a typed object keyed by the same names:
 *   `all({ user: fetchUser, prefs: fetchPrefs })` ⇒ `Promise<{ user; prefs }>`.
 * - a positional ARRAY (the `Promise.all` shape) → a typed tuple:
 *   `all([fetchUser, fetchPrefs])` ⇒ `Promise<readonly [User, Prefs]>`.
 *
 * Only the named form merges into a pipe's `ctx` via an inline `.step({...})`; an array nests through
 * `.step(all([...]), 'name')`. Each member keeps its own retry/timeout/validation.
 */
export function all<const T extends readonly Node[]>(
    members: T,
): Composable<TupleOut<T>>;
export function all<M extends Record<string, Node>>(
    members: M,
): Composable<BagOut<M>>;
export function all(
    members: readonly Node[] | Record<string, Node>,
): Composable<unknown> {
    return Array.isArray(members)
        ? makeComposable((input, run) =>
              runAllArray(members as readonly Node[], input, run),
          )
        : makeComposable((input, run) =>
              runAll(members as Record<string, Node>, input, run),
          );
}

/**
 * Run nodes CONCURRENTLY and resolve with the FIRST to SUCCEED — failover across interchangeable
 * sources. If every member fails, rejects with an `AggregateError`. The losers are auto-cancelled.
 */
export function any<M extends readonly Node[]>(
    members: M,
): Composable<OutputOf<M[number]>> {
    return makeComposable(
        (input, run) =>
            runAny(members, input, run) as Promise<OutputOf<M[number]>>,
    );
}

/**
 * Run nodes CONCURRENTLY and resolve/reject with the FIRST to SETTLE (success OR failure) — hedging a
 * latency-sensitive call against a faster mirror. The slower members are auto-cancelled.
 */
export function race<M extends readonly Node[]>(
    members: M,
): Composable<OutputOf<M[number]>> {
    return makeComposable(
        (input, run) =>
            runRace(members, input, run) as Promise<OutputOf<M[number]>>,
    );
}

// ---- the sequential engine (shared by both pipe surfaces) -----------------

/** The frozen ancestor view the engine hands a mapper: `$input` plus every earlier NAMED result. */
interface RunCtx {
    readonly $input: StitchInput | undefined;
    readonly [name: string]: unknown;
}
/** The engine's mapper shape: previous result + the ancestor view → the next call's input. */
type RunMapper = (prev: unknown, ctx: RunCtx) => StitchInput;
/** The internal step shape the engine runs: a single node (optionally named) OR an inline parallel bag. */
type RunStep =
    | {
          readonly node: Node;
          readonly name?: string;
          readonly input?: RunMapper;
      }
    | { readonly bag: Record<string, Node>; readonly input?: RunMapper };

// Reject reserved / duplicate names up front (construction, not mid-run) — across single-step names
// AND inline-bag keys. The builder enforces this at COMPILE time for literals; this is the runtime
// backstop for dynamically-built names.
function assertNames(steps: readonly RunStep[]): void {
    const seen = new Set<string>();
    const check = (name: string) => {
        if (name.startsWith('$'))
            throw new Error(
                `pipe: step name ${JSON.stringify(name)} is reserved — a name cannot start with '$'`,
            );
        if (seen.has(name))
            throw new Error(
                `pipe: duplicate step name ${JSON.stringify(name)}`,
            );
        seen.add(name);
    };
    for (const step of steps) {
        if ('bag' in step) Object.keys(step.bag).forEach(check);
        else if (step.name !== undefined) check(step.name);
    }
}

function compile(
    steps: readonly RunStep[],
): (input?: StitchInput) => Promise<unknown> {
    assertNames(steps);
    return async (input?: StitchInput): Promise<unknown> => {
        let value: unknown;
        let prevRun: RunContext | undefined;
        let first = true;
        // Already-resolved NAMED results, accumulated for ancestor access. A fresh frozen snapshot
        // (`{ $input, ...named }`) is handed to each mapper, so a later read sees a point-in-time view
        // and the container can't be written to. (Shallow freeze — ancestor VALUES are the user's own
        // result objects, read-only by contract like `prev`, not deep-frozen.)
        const named: Record<string, unknown> = {};
        for (const step of steps) {
            const stepInput: StitchInput = first
                ? (input ?? {})
                : step.input
                  ? step.input(
                        value,
                        Object.freeze({ $input: input, ...named }),
                    )
                  : { body: value };
            // Chain the run identity: this step is a child of the previous (ADR 0007). A bag step is
            // one node whose members fan out as its children.
            const run = newRunContext(prevRun);
            if ('bag' in step) {
                const bagOut = await runAll(step.bag, stepInput, run);
                for (const k of Object.keys(step.bag)) named[k] = bagOut[k];
                value = bagOut;
            } else {
                value = await (step.node as unknown as Runnable).__runWith(
                    stepInput,
                    run,
                );
                if (step.name !== undefined) named[step.name] = value;
            }
            prevRun = run;
            first = false;
        }
        return value;
    };
}

// ---- surface 1: the simple variadic `pipe(...)` ---------------------------

/** A pipe step: the stitch to run, and how to map the PREVIOUS result into its call input. */
export interface PipeStep {
    /** The stitch to run for this step. */
    readonly stitch: Stitch;
    /**
     * Map the previous step's result into this step's call input (sugar; not serialised). `prev` is
     * `unknown` — narrow it with a cast. Omitted ⇒ the previous result is passed as the call `body`.
     * The FIRST step receives the pipe's initial input directly and ignores this. For typed `prev` /
     * ancestors / parallel steps, use the {@link pipe.step} builder instead.
     */
    readonly input?: (prev: unknown) => StitchInput;
}

const asStep = (s: PipeStep | Stitch): RunStep =>
    typeof s === 'function'
        ? { node: s }
        : { node: s.stitch, ...(s.input ? { input: s.input } : {}) };

/**
 * Compose stitches into a linear pipeline. The returned callable takes the FIRST step's input; each
 * later step receives the PREVIOUS result through its `input` mapper (or the raw result as the call
 * `body` when no mapper is given), and the pipeline resolves to the LAST step's result. Runs in order,
 * each step a CHILD run of the previous (ADR 0007), fail-fast.
 *
 * `prev` is `unknown` here (TS can't infer it across a variadic call). When a step needs an EARLIER
 * result, typed `prev`, or a parallel sub-step, reach for the {@link pipe.step} builder.
 *
 * @example
 * ```ts
 * import { pipe } from 'stitchapi/pipe';
 *
 * const flow = pipe(
 *     fetchOrder, // receives the pipe's input
 *     { stitch: fetchShipment, input: (o) => ({ params: { id: (o as Order).shipmentId } }) },
 * );
 * const shipment = await flow({ params: { id: 1043 } });
 * ```
 */
export function pipe<Out = unknown>(
    ...steps: (PipeStep | Stitch)[]
): (input?: StitchInput) => Promise<Out> {
    return compile(steps.map(asStep)) as (input?: StitchInput) => Promise<Out>;
}

// ---- surface 2: the typed builder (`pipe.step(...)`) ----------------------

/** The base context every builder starts with — just the pipe's initial input. */
interface BaseCtx {
    readonly $input: StitchInput | undefined;
}

/**
 * The `.step` operation, typed as a callable PROPERTY (three call signatures) rather than a method, so
 * it can be detached — `pipe.step = makeBuilder([]).step` — without tripping `unbound-method`. Pass a
 * single node (optionally a positional `name`), or an inline `{ k: node }` bag to fan out in parallel.
 */
export interface PipeStepFn<Ctx extends BaseCtx, Prev> {
    /**
     * Append an inline PARALLEL bag: each `{ key: node }` runs concurrently (fail-fast, auto-cancel),
     * its keys MERGE into `ctx`, and `prev` becomes the named result object. A duplicate or
     * `$`-prefixed key narrows to `never` — a compile error.
     */
    <M extends Record<string, Node>>(
        bag: keyof M extends `$${string}` | keyof Ctx ? never : M,
        input?: (prev: Prev, ctx: Ctx) => StitchInput,
    ): PipeBuilder<Prettify<Ctx & BagOut<M>>, BagOut<M>>;
    /**
     * Append a NAMED step: `name` files its result under `ctx[name]` (typed) for every later step. A
     * duplicate or `$`-prefixed name narrows to `never` — a compile error you never police by hand.
     */
    <N extends string, S extends Node>(
        node: S,
        name: N extends `$${string}` | keyof Ctx ? never : N,
        input?: (prev: Prev, ctx: Ctx) => StitchInput,
    ): PipeBuilder<Prettify<Ctx & Record<N, OutputOf<S>>>, OutputOf<S>>;
    /**
     * Append a step, optionally with a mapper of the previous result. Unnamed ⇒ not addressable by a
     * later step; pass a `name` (the overload above) to make its result readable through `ctx`.
     */
    <S extends Node>(
        node: S,
        input?: (prev: Prev, ctx: Ctx) => StitchInput,
    ): PipeBuilder<Ctx, OutputOf<S>>;
}

export interface PipeBuilder<Ctx extends BaseCtx, Prev> {
    /** Run the pipeline: resolves to the LAST step's output. The builder itself is the callable. */
    (input?: StitchInput): Promise<Prev>;
    /** Append a step / parallel bag (and optionally name a single step) — see {@link PipeStepFn}. */
    readonly step: PipeStepFn<Ctx, Prev>;
}

function makeBuilder(steps: readonly RunStep[]): PipeBuilder<BaseCtx, unknown> {
    // The builder IS the runnable: calling it compiles (once) and runs the accumulated steps.
    let compiled: ((input?: StitchInput) => Promise<unknown>) | undefined;
    const run = (input?: StitchInput): Promise<unknown> =>
        (compiled ??= compile(steps))(input);
    // A function first arg is a single node — `(node, name?|mapper?, mapper?)`; an object first arg is
    // an inline bag — `(bag, mapper?)`. Typed via the public PipeStepFn signature; loose here.
    const step = (
        first: Node | Record<string, Node>,
        second?: string | RunMapper,
        third?: RunMapper,
    ): PipeBuilder<BaseCtx, unknown> => {
        let next: RunStep;
        if (typeof first === 'function') {
            const name = typeof second === 'string' ? second : undefined;
            const input = typeof second === 'function' ? second : third;
            next = {
                node: first,
                ...(name !== undefined ? { name } : {}),
                ...(input ? { input } : {}),
            };
        } else {
            const input = typeof second === 'function' ? second : undefined;
            next = { bag: first, ...(input ? { input } : {}) };
        }
        return makeBuilder([...steps, next]);
    };
    // The impl `step` returns a generic-erased builder; the public PipeStepFn overloads (esp. the bag
    // overload's mapped-type result) make it structurally non-assignable, so cast at this seam.
    return Object.assign(run, { step }) as unknown as PipeBuilder<
        BaseCtx,
        unknown
    >;
}

/**
 * Begin a TYPED pipeline on `pipe` itself — `pipe.step(...)` starts the fluent builder (the same
 * `.step` you chain). Each step is its own inference site, so the builder types `prev` AND a `ctx` of
 * named ancestors with no casts, and enforces unique names at compile time, over the SAME runtime
 * engine as `pipe(...)`. The builder is itself the runnable pipeline — call it directly. (The first
 * step's `input` mapper is ignored — it receives the pipe's input.)
 *
 * @example
 * ```ts
 * const tracked = pipe
 *     .step(fetchOrder, 'order') // named only because a later step reads it back
 *     .step({ shipment: fetchShipment, invoice: fetchInvoice }) // parallel; merges into ctx
 *     .step(fetchTracking, (details, ctx) => ({
 *         params: { code: details.shipment.trackingCode, region: ctx.order.region },
 *     }));
 * const tracking = await tracked({ params: { id: 1043 } }); // the builder is the callable
 * ```
 */
pipe.step = makeBuilder([]).step;
