/**
 * Reference agent driver: shells out to the `claude` CLI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS DRIVER IS NEVER RUN IN CI AND NEVER BY THE SMOKE TESTS.
 *  It needs the `claude` CLI installed AND credentials in the environment, and it
 *  makes real, billable model calls. The offline default is `StubDriver`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It deliberately imports NO Anthropic SDK — the only coupling to "Claude" is the
 * `claude` executable invoked via `node:child_process`. This keeps the harness's
 * dependency tree identical to packages/sandbox-sim (tsx + typescript + @types/node)
 * and lets the whole package typecheck with the CLI absent.
 *
 * Opt in with `index.ts --driver claude`. Without the CLI on PATH `runAgent`
 * rejects with a clear message; nothing here runs at import time.
 */
import type { WorkspaceDescriptor } from './conditions';
import { describeCondition } from './conditions';
import type { AgentDriver, AgentRun, Condition } from './driver';
import { MAIN_FILE } from './driver';

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeDriverOptions {
    /** Executable to invoke. Default 'claude' (resolved on PATH). */
    bin?: string;
    /** Model id to pass through, if the CLI supports `--model`. */
    model?: string;
    /** Extra args appended verbatim. */
    extraArgs?: string[];
    /** Per-run timeout in ms. Default 5 minutes. */
    timeoutMs?: number;
}

/**
 * Build the full instruction handed to the CLI: the task prompt, plus a strict
 * output contract so the produced file is machine-collectable. We ask the agent
 * to write its answer to `<scratch>/client.ts` exporting `run(fetch)` — the same
 * contract the scorer expects (see runner/prebaked.ts).
 */
export function buildInstruction(
    prompt: string,
    workspace: WorkspaceDescriptor,
): string {
    return [
        prompt,
        '',
        '---',
        `Write your solution to a single file at ${MAIN_FILE} in the current`,
        'working directory. The file MUST export',
        '`export async function run(fetch: typeof globalThis.fetch): Promise<unknown>`',
        'so it can be tested with an injected fetch. Do not run it; just write it.',
        workspace.notes,
    ].join('\n');
}

/** Resolve the `claude` CLI; reject if absent. Spawns `--version` to probe. */
function probeCli(bin: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['--version'], { stdio: 'ignore' });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`'${bin} --version' timed out`));
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(
                new Error(
                    `claude CLI not available ('${bin}'): ${err.message}. ` +
                        'Install it and authenticate, or use the default StubDriver.',
                ),
            );
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`'${bin} --version' exited ${code ?? '?'}`));
        });
    });
}

/** Run the CLI non-interactively in `cwd`, returning its stdout. */
function runCli(
    bin: string,
    args: string[],
    cwd: string,
    instruction: string,
    timeoutMs: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        // `-p <prompt>` is the headless/print mode of the CLI; we feed the
        // instruction as a single prompt and let it edit files in `cwd`.
        const child = spawn(bin, ['-p', instruction, ...args], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`claude run timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else
                reject(
                    new Error(
                        `claude exited ${code ?? '?'}: ${err.slice(0, 500)}`,
                    ),
                );
        });
    });
}

/**
 * Best-effort token/turn extraction from the CLI's textual output. The CLI's
 * machine-readable JSON format varies across versions, so this is intentionally
 * loose — a live run that cares about exact numbers should pass `--output-format
 * json` via `extraArgs` and parse it. Missing data reports as 0.
 */
function parseUsage(stdout: string): {
    transcriptTurns: number;
    tokensIn: number;
    tokensOut: number;
} {
    const turns = (stdout.match(/\bturn\b/gi) ?? []).length;
    const inMatch = /input[_ ]tokens["\s:]+(\d+)/i.exec(stdout);
    const outMatch = /output[_ ]tokens["\s:]+(\d+)/i.exec(stdout);
    return {
        transcriptTurns: turns,
        tokensIn: inMatch ? Number(inMatch[1]) : 0,
        tokensOut: outMatch ? Number(outMatch[1]) : 0,
    };
}

export class ClaudeDriver implements AgentDriver {
    readonly id = 'claude';
    private readonly bin: string;
    private readonly model?: string;
    private readonly extraArgs: string[];
    private readonly timeoutMs: number;

    constructor(opts: ClaudeDriverOptions = {}) {
        this.bin = opts.bin ?? 'claude';
        this.model = opts.model;
        this.extraArgs = opts.extraArgs ?? [];
        this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    }

    async runAgent(
        task: { id: string; prompt: string },
        condition: Condition,
    ): Promise<AgentRun> {
        await probeCli(this.bin, 30_000);

        // Materialize a scratch workspace for the condition, run the CLI inside it,
        // then collect whatever .ts files it produced.
        const root = await fs.mkdtemp(
            path.join(os.tmpdir(), `eval-${task.id}-${condition}-`),
        );
        try {
            const workspace = await describeCondition(condition, root);
            await workspace.materialize();

            const instruction = buildInstruction(task.prompt, workspace);
            const args = [
                ...(this.model ? ['--model', this.model] : []),
                ...this.extraArgs,
            ];
            const stdout = await runCli(
                this.bin,
                args,
                root,
                instruction,
                this.timeoutMs,
            );

            const files = await collectTsFiles(root);
            return { files, ...parseUsage(stdout) };
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    }
}

/** Read every *.ts file under `root` (recursively) into a path→source map. */
async function collectTsFiles(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    async function walk(dir: string, rel: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const abs = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(abs, relPath);
            else if (e.name.endsWith('.ts'))
                out[relPath] = await fs.readFile(abs, 'utf8');
        }
    }
    await walk(root, '');
    return out;
}
