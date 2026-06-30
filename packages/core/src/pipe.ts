// The `stitchapi/pipe` subpath (ADR 0008): composition. Combine stitches — and each other — into
// flows you `await` like any function. SEQUENTIAL composition is `pipe(...)`: run stitches in order,
// feeding each result to the next, each step a CHILD run of the prior (ADR 0007 run identity), so a
// trace shows the chain `stepA → stepB → stepC`. PARALLEL composition is `all` / `any` / `race`: run
// independent stitches CONCURRENTLY as sibling child runs (the trace draws a fan), and because every
// combinator returns the same callable shape a stitch does, they NEST inside one another.
//
//   - `all({ k: node })` / `all([...])` — resolve when ALL succeed (fail-fast); a named object or tuple.
//   - `any([...])` — resolve on the FIRST success (else `AggregateError`); failover across mirrors.
//   - `race([...])` — resolve on the FIRST to settle (win or lose); hedging a slow call against a mirror.
//
// Every parallel combinator AUTO-CANCELS the members that can no longer affect the result — `all` on
// the first failure, `any` on the first success, `race` on the first settle — via a per-group
// `AbortSignal` linked to the caller's. There is deliberately NO `allSettled` (best-effort) variant;
// for that, compose `.safe()` members by hand. Bundle-frugal: reached only through this subpath.
import type { RunContext, Stitch, StitchInput } from './types';
import { newRunContext } from './util';

// The internal child-run invocation a node exposes (stitch.ts `__runWith`, and the combinators
// below): run under a supplied run identity and resolve to the value. Reached through a cast — it is
// not on the public Stitch.
interface Runnable {
    __runWith: (
        input: StitchInput | undefined,
        run: RunContext,
    ) => Promise<unknown>;
}

/**
 * A composed flow — what every combinator returns. It is callable (`await composable(input)` runs it
 * as a root) and nests inside any other combinator (it carries the same child-run protocol a stitch
 * does). `__composable` brands it so it is distinguishable from a bare callable.
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

/**
 * The public member constraint: gate on the stitch / composable BRAND, not the call signature. A
 * stitch's input is CONTRAVARIANT, so constraining on the call signature would (exactly like `pipe`
 * before #365) reject a stitch built from a templated URL — its narrow `TIn` is not assignable to the
 * bare `Stitch` default. Gating on `__stitch` / `__composable` accepts every real stitch or composable,
 * narrow input or not, while still rejecting a plain function. The internal {@link Node} keeps the call
 * signature — the runtime reaches members through a cast, not through this constraint.
 */
type Member = { readonly __stitch: true } | { readonly __composable: true };

/**
 * A member's resolved output — `Awaited` of its call-signature return (a `StitchResult<O>` or a
 * `Promise<O>`). Inferred from the CALL SIGNATURE alone (not full-`Stitch` assignability), so a
 * narrow-input stitch resolves to its real output instead of collapsing to `never`.
 */
type OutputOf<S> = S extends (...args: never[]) => infer R ? Awaited<R> : never;
/** Flatten an accumulated intersection into one object literal (readable hovers). */
type Prettify<T> = { [K in keyof T]: T[K] } & {};
/** The named-object output of a parallel bag `{ k: node }` — each key mapped to that node's output. */
type BagOut<M extends Record<string, Member>> = Prettify<{
    [K in keyof M]: OutputOf<M[K]>;
}>;
/** The tuple output of a positional `all([...])` — each member mapped to its output, in order. */
type TupleOut<T extends readonly Member[]> = { [K in keyof T]: OutputOf<T[K]> };

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
 * Each member keeps its own retry/timeout/validation, runs as a sibling child run (the trace draws a
 * fan), and is auto-cancelled if a sibling fails first.
 */
export function all<const T extends readonly Member[]>(
    members: T,
): Composable<TupleOut<T>>;
export function all<M extends Record<string, Member>>(
    members: M,
): Composable<BagOut<M>>;
export function all(
    members: readonly Member[] | Record<string, Member>,
): Composable<unknown> {
    return Array.isArray(members)
        ? makeComposable((input, run) =>
              runAllArray(members as unknown as readonly Node[], input, run),
          )
        : makeComposable((input, run) =>
              runAll(members as unknown as Record<string, Node>, input, run),
          );
}

/**
 * Run nodes CONCURRENTLY and resolve with the FIRST to SUCCEED — failover across interchangeable
 * sources. If every member fails, rejects with an `AggregateError`. The losers are auto-cancelled.
 * Distinct from a stitch's built-in `retry` (which re-hits the SAME endpoint): `any` is redundancy
 * across DIFFERENT ones — a primary and a mirror, two regions, two providers of the same shape.
 */
export function any<M extends readonly Member[]>(
    members: M,
): Composable<OutputOf<M[number]>> {
    return makeComposable(
        (input, run) =>
            runAny(
                members as unknown as readonly Node[],
                input,
                run,
            ) as Promise<OutputOf<M[number]>>,
    );
}

/**
 * Run nodes CONCURRENTLY and resolve/reject with the FIRST to SETTLE (success OR failure) — hedging a
 * latency-sensitive call against a faster mirror. The slower members are auto-cancelled. Where `any`
 * waits past failures for a success, `race` takes the first result of any kind.
 */
export function race<M extends readonly Member[]>(
    members: M,
): Composable<OutputOf<M[number]>> {
    return makeComposable(
        (input, run) =>
            runRace(
                members as unknown as readonly Node[],
                input,
                run,
            ) as Promise<OutputOf<M[number]>>,
    );
}

// ---- sequential: the variadic `pipe(...)` ---------------------------------

/**
 * A stitch accepted as a pipe member regardless of its inferred input/output types. `Stitch<TOut,
 * TIn>` is CONTRAVARIANT in `TIn` (it sits in the call signature and in `with()`'s parameter), so a
 * stitch with a NARROWER input — e.g. one built from a templated URL `'/users/{id}'`, whose `TIn`
 * carries a required `params: { id }` — is *not* assignable to the bare `Stitch` default
 * (`Stitch<unknown, StitchInput>`). `never` in the input slot erases that contravariance (`never`
 * is assignable to every `TIn`), so every stitch is accepted while `TOut` stays `unknown`. This is
 * the idiom pipe's own example uses; without it that example fails to type-check (TS2345).
 */
type AnyStitch = Stitch<unknown, never>;

/** A pipe step: the stitch to run, and how to turn the previous result into its call input. */
export interface PipeStep {
    /** The stitch to run for this step. */
    readonly stitch: AnyStitch;
    /**
     * Map the previous step's result to this step's call input (sugar; not serialised). Omitted ⇒
     * the previous result is passed as the call `body`. The FIRST step receives the pipe's initial
     * input directly and ignores this.
     */
    readonly input?: (prev: unknown) => StitchInput;
}

const asStep = (s: PipeStep | AnyStitch): PipeStep =>
    typeof s === 'function' ? { stitch: s } : s;

/**
 * Compose stitches into a linear pipeline. The returned callable takes the FIRST step's input; each
 * later step receives the previous result through its `input` mapper (or the raw result as the call
 * `body` when no mapper is given), and the pipeline resolves to the LAST step's result.
 *
 * Each step runs as a CHILD run of the previous (ADR 0007), so a trace/DAG shows the chain. Steps
 * run sequentially and the pipeline FAILS FAST — a step's `StitchError` rejects the whole pipe.
 *
 * @example
 * ```ts
 * import { pipe } from 'stitchapi/pipe';
 *
 * const flow = pipe(
 *     fetchUser, // receives the pipe's input
 *     { stitch: fetchPosts, input: (u) => ({ params: { userId: (u as User).id } }) },
 * );
 * const posts = await flow({ params: { id: 1 } });
 * ```
 */
export function pipe<Out = unknown>(
    ...steps: (PipeStep | AnyStitch)[]
): (input?: StitchInput) => Promise<Out> {
    const resolved = steps.map(asStep);
    return async (input?: StitchInput): Promise<Out> => {
        let value: unknown;
        let prevRun: RunContext | undefined;
        let first = true;
        for (const step of resolved) {
            const stepInput: StitchInput = first
                ? (input ?? {})
                : step.input
                  ? step.input(value)
                  : { body: value };
            // Chain the run identity: step N is a child of step N-1 — the linear causality the
            // trace/DAG draws. The first step (prevRun undefined) is a root run.
            const run = newRunContext(prevRun);
            value = await (step.stitch as unknown as Runnable).__runWith(
                stepInput,
                run,
            );
            prevRun = run;
            first = false;
        }
        return value as Out;
    };
}
