// The `stitchapi/pipe` subpath (ADR 0008): linear composition. Run stitches in sequence, feeding
// each result to the next, with each step a CHILD run of the prior (ADR 0007 run identity) — so a
// trace shows the chain `stepA → stepB → stepC` and the playground DAG draws the same edges. The
// step-to-step MAPPING is a closure (acknowledged sugar, the same category as `transform` /
// `paginate.next`), while the STRUCTURE — the ordered member stitches — round-trips. Fail-fast: a
// step's error rejects the pipeline. Bundle-frugal: reached only through the `pipe` subpath.
import type { RunContext, Stitch, StitchInput } from './types';
import { newRunContext } from './util';

/** A pipe step: the stitch to run, and how to turn the previous result into its call input. */
export interface PipeStep {
    /** The stitch to run for this step. */
    readonly stitch: Stitch;
    /**
     * Map the previous step's result to this step's call input (sugar; not serialised). Omitted ⇒
     * the previous result is passed as the call `body`. The FIRST step receives the pipe's initial
     * input directly and ignores this.
     */
    readonly input?: (prev: unknown) => StitchInput;
}

// The internal child-run invocation a stitch exposes (stitch.ts `__runWith`): run under a supplied
// run identity and resolve to the value. Reached through a cast — it is not on the public Stitch.
interface Runnable {
    __runWith: (
        input: StitchInput | undefined,
        run: RunContext,
    ) => Promise<unknown>;
}

const asStep = (s: PipeStep | Stitch): PipeStep =>
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
    ...steps: (PipeStep | Stitch)[]
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
