/**
 * Agent driver contract + an offline StubDriver.
 *
 * An `AgentDriver` is the pluggable thing that, given a task and a condition
 * (cold/warm), produces a set of source files plus some bookkeeping (turns +
 * token usage). The eval loop is agnostic to HOW the files were produced — a real
 * agent (see claude-driver.ts) or the deterministic StubDriver used by the smoke
 * tests + the default CLI run.
 *
 * The StubDriver imports the pre-baked snippets from `runner/prebaked.ts`. Those
 * snippets deliberately use `stitch`/`graphql` so the rest of the pipeline
 * (choose → run) has a real, runnable, offline artifact to score with no LLM and
 * no network.
 */
import type { EvalTask } from '../tasks/index';
import { PREBAKED } from './prebaked';

/** The condition a task is run under (see runner/conditions.ts). */
export type Condition = 'cold' | 'warm';

/** What a driver produces for one (task, condition) cell. */
export interface AgentRun {
    /** Produced files, keyed by relative path. The "main" entry the scorer runs
     *  is conventionally `client.ts` (see `mainFileOf`). */
    files: Record<string, string>;
    /** How many agent turns it took (0 for the stub). */
    transcriptTurns: number;
    /** Prompt tokens consumed (0 for the stub — no model was called). */
    tokensIn: number;
    /** Completion tokens produced (0 for the stub). */
    tokensOut: number;
}

export interface AgentDriver {
    /** A short id used in reports (e.g. 'stub', 'claude'). */
    readonly id: string;
    runAgent(task: EvalTask, condition: Condition): Promise<AgentRun>;
}

/** Convention: the runnable entry the scorer transpiles + imports. */
export const MAIN_FILE = 'client.ts';

/** Pick the scorable main file from a produced file set. */
export function mainFileOf(files: Record<string, string>): string | undefined {
    if (files[MAIN_FILE] !== undefined) return files[MAIN_FILE];
    // Fall back to the first *.ts file if a driver named it differently.
    const firstTs = Object.keys(files)
        .filter((k) => k.endsWith('.ts'))
        .sort()[0];
    return firstTs !== undefined ? files[firstTs] : undefined;
}

/**
 * Deterministic, offline driver. Returns a pre-baked stitch-using `client.ts` per
 * task regardless of condition (the stub does not read docs — it always knows the
 * answer). Cold/warm differ only in the reported turn/token counts so reports look
 * realistic; both produce the same correct artifact.
 */
export class StubDriver implements AgentDriver {
    readonly id = 'stub';

    runAgent(task: EvalTask, condition: Condition): Promise<AgentRun> {
        const source = PREBAKED[task.id];
        if (source === undefined) {
            return Promise.reject(
                new Error(
                    `StubDriver has no pre-baked snippet for "${task.id}"`,
                ),
            );
        }
        // Warm "costs" less than cold in this fixture — the docs short-circuit the
        // agent's exploration. Numbers are illustrative, not measured.
        const warm = condition === 'warm';
        return Promise.resolve({
            files: { [MAIN_FILE]: source },
            transcriptTurns: warm ? 2 : 4,
            tokensIn: warm ? 1200 : 2600,
            tokensOut: warm ? 380 : 520,
        });
    }
}
