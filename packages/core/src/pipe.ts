// The `stitchapi/pipe` subpath (ADR 0008): composition. Combine stitches — and each other — into
// flows you `await` like any function. SEQUENTIAL composition is `linked(body)`: write a body of plain
// `await`s and call stitches through the supplied `run`, so each call is a CHILD run of the prior (ADR
// 0007 run identity) and the sequence shares one trace chain `stepA → stepB → stepC`. PARALLEL
// composition is `all` / `any` / `race`: run independent stitches CONCURRENTLY as sibling child runs
// (the trace draws a fan); every combinator returns the same callable shape a stitch does, so they NEST
// inside one another — and `run` accepts a combinator as a node, so a parallel fan joins the scope.
//
//   - `linked(body)` — SEQUENTIAL: plain `await`s through `run`; ancestors are variables (no `ctx`).
//   - `all({ k: node })` / `all([...])` / `all(a, b)` — resolve when ALL succeed (fail-fast); object or tuple.
//   - `any([...])` / `any(a, b)` — resolve on the FIRST success (else `AggregateError`); failover across mirrors.
//   - `race([...])` / `race(a, b)` — resolve on the FIRST to settle (win or lose); hedging a slow call.
//
// The array members and the bare-argument members are the SAME thing — `all([a, b])` and `all(a, b)`
// build the identical group. The bracketed form is the `Promise.all`/`Promise.any`/`Promise.race`
// shape; the argument-list form drops the ceremony when you are just listing stitches inline.
//
// Every parallel combinator AUTO-CANCELS the members that can no longer affect the result — `all` on
// the first failure, `any` on the first success, `race` on the first settle — via a per-group
// `AbortSignal` linked to the caller's. There is deliberately NO `allSettled` (best-effort) variant;
// for that, compose `.safe()` members by hand. Bundle-frugal: reached only through this subpath.
import type { Args } from './infer';
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

// Normalize a combinator's arguments to its member list. A single ARRAY argument IS the list (the
// bracketed `all([a, b])` form); otherwise the arguments themselves are the members (the bare
// `all(a, b)` argument-list form). A member is always a function — never an array — so a lone array
// argument is unambiguous.
function membersFrom(args: readonly unknown[]): readonly Node[] {
    const lone = args.length === 1 ? args[0] : undefined;
    return (Array.isArray(lone) ? lone : args) as readonly Node[];
}

// True for the NAMED-bag argument of `all`: a single plain object of named members. A stitch or
// composable is a FUNCTION (so `typeof === 'object'` excludes it) and the array form is an array, so a
// lone non-array object can only be the named-bag form.
function isBag(x: unknown): x is Record<string, Node> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Run nodes CONCURRENTLY and resolve when ALL succeed; fail-fast — the first to reject aborts the rest
 * and rejects the whole `all`. Three interchangeable forms (pick whichever reads better):
 *
 * - a NAMED object → a typed object keyed by the same names:
 *   `all({ user: fetchUser, prefs: fetchPrefs })` ⇒ `Promise<{ user; prefs }>`.
 * - a positional ARRAY (the `Promise.all` shape) → a typed tuple:
 *   `all([fetchUser, fetchPrefs])` ⇒ `Promise<readonly [User, Prefs]>`.
 * - the same members as bare ARGUMENTS → the identical tuple, without the brackets:
 *   `all(fetchUser, fetchPrefs)` ⇒ `Promise<readonly [User, Prefs]>`.
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
export function all<const T extends readonly Member[]>(
    ...members: T
): Composable<TupleOut<T>>;
export function all(...args: readonly unknown[]): Composable<unknown> {
    // A lone plain-object argument is the NAMED-bag form; a lone array or bare member arguments are the
    // positional tuple form.
    const first = args[0];
    if (args.length === 1 && isBag(first)) {
        const bag = first;
        return makeComposable((input, run) => runAll(bag, input, run));
    }
    return makeComposable((input, run) =>
        runAllArray(membersFrom(args), input, run),
    );
}

/**
 * Run nodes CONCURRENTLY and resolve with the FIRST to SUCCEED — failover across interchangeable
 * sources. If every member fails, rejects with an `AggregateError`. The losers are auto-cancelled.
 * Distinct from a stitch's built-in `retry` (which re-hits the SAME endpoint): `any` is redundancy
 * across DIFFERENT ones — a primary and a mirror, two regions, two providers of the same shape. Pass
 * the members as an ARRAY (`any([a, b])`) or as bare ARGUMENTS (`any(a, b)`) — same combinator.
 */
export function any<M extends readonly Member[]>(
    members: M,
): Composable<OutputOf<M[number]>>;
export function any<M extends readonly Member[]>(
    ...members: M
): Composable<OutputOf<M[number]>>;
export function any(...args: readonly unknown[]): Composable<unknown> {
    return makeComposable((input, run) =>
        runAny(membersFrom(args), input, run),
    );
}

/**
 * Run nodes CONCURRENTLY and resolve/reject with the FIRST to SETTLE (success OR failure) — hedging a
 * latency-sensitive call against a faster mirror. The slower members are auto-cancelled. Where `any`
 * waits past failures for a success, `race` takes the first result of any kind. Pass the members as an
 * ARRAY (`race([a, b])`) or as bare ARGUMENTS (`race(a, b)`) — same combinator.
 */
export function race<M extends readonly Member[]>(
    members: M,
): Composable<OutputOf<M[number]>>;
export function race<M extends readonly Member[]>(
    ...members: M
): Composable<OutputOf<M[number]>>;
export function race(...args: readonly unknown[]): Composable<unknown> {
    return makeComposable((input, run) =>
        runRace(membersFrom(args), input, run),
    );
}

// ---- linked: sequential composition as a SCOPE -----------------------------
// SEQUENTIAL composition written as ordinary code: you write plain `await`s, and the `run` handed to
// the body threads each call's run identity so the sequence shares ONE trace tree — each call a CHILD
// run of the prior (ADR 0007 run identity), drawing the chain `stepA → stepB → stepC` — while earlier
// results stay plain typed variables (no `ctx`, no builder, no casts).

/**
 * The scoped caller handed to a {@link linked} body. It runs a node as the NEXT link in the scope — a
 * child run of the call before it (ADR 0007) — and resolves to its typed value. A {@link Stitch} is
 * called with its own typed input; a combinator ({@link Composable} — an {@link all}/{@link any}/
 * {@link race} result) with the shared {@link StitchInput}, so a parallel fan inside a sequential scope
 * still joins the one trace.
 */
export interface ScopedRun {
    // `NoInfer` on the args pins `I` to the STITCH's own input — otherwise TS also infers `I` from the
    // input argument, and a narrower literal (`{ params: { id } }`) fights the stitch's full input type.
    <O, I>(stitch: Stitch<O, I>, ...args: Args<NoInfer<I>>): Promise<O>;
    <O>(node: Composable<O>, input?: StitchInput): Promise<O>;
}

/**
 * Open a run SCOPE and run a body of plain `await`s inside it. Every node called through `run` joins
 * the scope as a CHILD run of the call before it (ADR 0007), so a sequence of awaits draws one trace
 * chain `stepA → stepB → stepC` — written as ordinary code, with ancestors as plain typed variables
 * instead of a `ctx`. `linked` resolves to whatever the body returns, and FAILS FAST: a rejected call
 * rejects the whole scope.
 *
 * The trade: the flow is imperative, so it is not a value you can pass around or introspect; and
 * run-chaining follows CALL ORDER, so for genuinely concurrent calls inside the body reach for
 * {@link all} (which `run` accepts as a node, keeping the fan inside the same trace). What it buys:
 * the readability of plain `await`s and typed ancestors-as-variables, with the linked trace a single
 * stitch already has.
 *
 * @example
 * ```ts
 * import { linked } from 'stitchapi/pipe';
 *
 * const tracking = await linked(async (run) => {
 *     const order = await run(fetchOrder, { params: { id: 1043 } });
 *     const shipment = await run(fetchShipment, { params: { id: order.shipmentId } });
 *     return run(fetchTracking, {
 *         params: { code: shipment.trackingCode, region: order.region }, // ancestor = a variable
 *     });
 * });
 * ```
 */
export function linked<T>(
    body: (run: ScopedRun) => Promise<T> | T,
): Promise<T> {
    // The last run identity minted in this scope; the next call chains under it (ADR 0007). The first
    // call (prev undefined) is the scope's ROOT run.
    let prev: RunContext | undefined;
    const run = ((node: Stitch | Composable<unknown>, input?: StitchInput) => {
        const ctx = newRunContext(prev);
        prev = ctx;
        return (node as unknown as Runnable).__runWith(input, ctx);
    }) as unknown as ScopedRun;
    return Promise.resolve(body(run));
}
