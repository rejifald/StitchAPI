/**
 * @stitchapi/eval-harness — CLI entry.
 *
 * Drives the agent-recommendation eval: for each task × condition, ask a driver
 * to produce a client, classify it (choose), run it offline against sandbox-sim
 * (run), and aggregate a report.
 *
 *   tsx index.ts one <task-id> [--driver stub|claude] [--condition cold|warm]
 *   tsx index.ts all            [--driver stub|claude]
 *   tsx index.ts report         [--driver stub|claude] [--out <file>] [--md <file>]
 *
 * The default driver is `stub` — fully OFFLINE, no LLM, no credentials. Pass
 * `--driver claude` to use the reference CLI driver (needs the `claude` CLI +
 * credentials; billable; never run in CI). See README.md.
 */
import { ClaudeDriver } from './runner/claude-driver';
import { CONDITIONS } from './runner/conditions';
import {
    type AgentDriver,
    type Condition,
    StubDriver,
    mainFileOf,
} from './runner/driver';
import { chooseFromFiles } from './score/choose';
import {
    type MatrixCell,
    buildReport,
    toJson,
    toMarkdown,
} from './score/report';
import { runProduced } from './score/run';
import { type EvalTask, TASKS, getTask, taskIds } from './tasks/index';

import { promises as fs } from 'node:fs';
import { compact } from 'stitchapi';

interface Args {
    command: string;
    positional: string[];
    flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
    const [command = 'all', ...rest] = argv;
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
        const tok = rest[i]!;
        if (tok.startsWith('--')) {
            const key = tok.slice(2);
            const next = rest[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = 'true';
            }
        } else {
            positional.push(tok);
        }
    }
    return { command, positional, flags };
}

function makeDriver(flags: Record<string, string>): AgentDriver {
    const id = flags['driver'] ?? 'stub';
    if (id === 'claude') {
        return new ClaudeDriver(
            flags['model'] ? { model: flags['model'] } : {},
        );
    }
    if (id !== 'stub') {
        throw new Error(`unknown --driver "${id}" (expected stub | claude)`);
    }
    return new StubDriver();
}

/** Run one (task, condition) cell end to end and return a matrix row. */
async function evalCell(
    driver: AgentDriver,
    task: EvalTask,
    condition: Condition,
): Promise<MatrixCell> {
    const run = await driver.runAgent(task, condition);
    const choice = chooseFromFiles(run.files);
    const main = mainFileOf(run.files);

    let compiled = false;
    let ran = false;
    let shapeOk = false;
    let error: string | undefined;

    if (main === undefined) {
        error = 'driver produced no .ts file';
    } else {
        const scored = await runProduced(main, task);
        compiled = scored.compiled;
        ran = scored.ran;
        shapeOk = scored.shapeOk;
        error = scored.error;
    }

    return compact({
        taskId: task.id,
        family: task.family,
        condition,
        choice,
        compiled,
        ran,
        shapeOk,
        transcriptTurns: run.transcriptTurns,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        error,
    });
}

/** Run the full task × condition matrix. */
async function evalMatrix(
    driver: AgentDriver,
    tasks: readonly EvalTask[],
): Promise<MatrixCell[]> {
    const cells: MatrixCell[] = [];
    for (const task of tasks) {
        for (const condition of CONDITIONS) {
            cells.push(await evalCell(driver, task, condition));
        }
    }
    return cells;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const driver = makeDriver(args.flags);

    switch (args.command) {
        case 'one': {
            const id = args.positional[0];
            if (!id) {
                fail(
                    `usage: eval:one <task-id>\n  tasks: ${taskIds().join(', ')}`,
                );
            }
            const task = getTask(id);
            if (!task) {
                fail(`unknown task "${id}"\n  tasks: ${taskIds().join(', ')}`);
            }
            const condition = (args.flags['condition'] ?? 'cold') as Condition;
            const cell = await evalCell(driver, task, condition);
            process.stdout.write(JSON.stringify(cell, null, 2) + '\n');
            break;
        }
        case 'all': {
            const cells = await evalMatrix(driver, TASKS);
            const report = buildReport(driver.id, cells);
            process.stdout.write(toMarkdown(report) + '\n');
            break;
        }
        case 'report': {
            const cells = await evalMatrix(driver, TASKS);
            const report = buildReport(driver.id, cells);
            const json = toJson(report);
            const md = toMarkdown(report);
            if (args.flags['out']) await fs.writeFile(args.flags['out'], json);
            if (args.flags['md']) await fs.writeFile(args.flags['md'], md);
            if (!args.flags['out'] && !args.flags['md']) {
                process.stdout.write(json + '\n');
            } else {
                process.stdout.write(`wrote report (${cells.length} cells)\n`);
            }
            break;
        }
        default:
            fail(
                `unknown command "${args.command}" (expected one | all | report)`,
            );
    }
}

function fail(msg: string): never {
    process.stderr.write(msg + '\n');
    process.exit(1);
}

main().catch((err: unknown) => {
    process.stderr.write(
        `eval-harness failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
});
