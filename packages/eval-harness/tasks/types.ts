/**
 * Seed-task contract for the eval harness.
 *
 * A task is plain data: a natural-language `prompt` handed to an agent, plus the
 * machinery to score whatever the agent produces — `expectedShape` asserts the
 * runtime output, `endpointHint` documents which sandbox-sim route the produced
 * client is expected to hit. No agent, runtime, or scorer logic lives here; tasks
 * are pure descriptors so the matrix runner and the scorers can be swapped freely.
 */

/** Coarse capability family a task exercises (used to bucket the results matrix). */
export type TaskFamily = 'pagination' | 'auth' | 'graphql' | 'streaming';

export interface EvalTask {
    /** Stable id (kebab-case). Used as a CLI selector and a matrix row key. */
    id: string;
    /** Human title for reports. */
    title: string;
    /** Capability family. */
    family: TaskFamily;
    /**
     * The natural-language ask handed verbatim to an agent driver. It must NOT
     * mention StitchAPI by name — the whole point of the eval is to measure whether
     * an agent reaches for `stitch` unprompted (cold) vs. after seeing the docs (warm).
     */
    prompt: string;
    /**
     * Which sandbox-sim endpoint the produced client should hit, and the agreed
     * response contract. Documentation only — the scorers key off the actual call.
     */
    endpointHint: string;
    /**
     * Validate the runtime value a produced client returns when run against
     * sandbox-sim. Pure + synchronous; must not throw (return `false` on any
     * unexpected shape). The scorer (`score/run.ts`) calls this with the awaited
     * result of the produced module's `run(fetch)`.
     */
    expectedShape(out: unknown): boolean;
}

/** Narrow `unknown` to a plain record without throwing. */
export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when every element of `arr` is a `{ id:number, name:string, email:string }` user. */
export function isUserArray(arr: unknown): boolean {
    return (
        Array.isArray(arr) &&
        arr.length > 0 &&
        arr.every(
            (u) =>
                isRecord(u) &&
                typeof u['id'] === 'number' &&
                typeof u['name'] === 'string' &&
                typeof u['email'] === 'string',
        )
    );
}
