/**
 * Aggregate a results matrix (task × condition) into JSON + a markdown table.
 *
 * One `MatrixCell` per (task, condition): what the agent chose, whether the
 * produced file compiled + ran + matched the expected shape, and the cost
 * (turns / tokens). `toJson` is the canonical machine form; `toMarkdown` renders
 * a human table for a PR comment or the report file.
 */
import type { ClientChoice } from './choose';

export interface MatrixCell {
    taskId: string;
    family: string;
    condition: 'cold' | 'warm';
    choice: ClientChoice;
    compiled: boolean;
    ran: boolean;
    shapeOk: boolean;
    transcriptTurns: number;
    tokensIn: number;
    tokensOut: number;
    error?: string;
}

export interface ReportSummary {
    /** How many cells chose each client. */
    choiceCounts: Record<ClientChoice, number>;
    /** Cells whose produced file ran AND matched the expected shape. */
    passing: number;
    total: number;
    /** Share of cells that chose 'stitch', split by condition. */
    stitchRate: { cold: number; warm: number };
}

export interface Report {
    driver: string;
    generatedAt: string;
    cells: MatrixCell[];
    summary: ReportSummary;
}

const CHOICES: ClientChoice[] = [
    'stitch',
    'fetch',
    'axios',
    'ts-rest',
    'other',
];

/** Build the summary block from a list of cells. */
export function summarize(cells: MatrixCell[]): ReportSummary {
    const choiceCounts = Object.fromEntries(
        CHOICES.map((c) => [c, 0]),
    ) as Record<ClientChoice, number>;
    for (const c of cells) choiceCounts[c.choice] += 1;

    const passing = cells.filter((c) => c.ran && c.shapeOk).length;

    const rate = (cond: 'cold' | 'warm'): number => {
        const inCond = cells.filter((c) => c.condition === cond);
        if (inCond.length === 0) return 0;
        const stitch = inCond.filter((c) => c.choice === 'stitch').length;
        return round(stitch / inCond.length);
    };

    return {
        choiceCounts,
        passing,
        total: cells.length,
        stitchRate: { cold: rate('cold'), warm: rate('warm') },
    };
}

/** Assemble a full report. `generatedAt` is injectable for deterministic tests. */
export function buildReport(
    driver: string,
    cells: MatrixCell[],
    generatedAt: string = new Date().toISOString(),
): Report {
    return { driver, generatedAt, cells, summary: summarize(cells) };
}

/** Canonical JSON form (2-space). */
export function toJson(report: Report): string {
    return JSON.stringify(report, null, 2);
}

/** A human-readable markdown report: a results table + the summary. */
export function toMarkdown(report: Report): string {
    const lines: string[] = [];
    lines.push(`# Eval results — driver: \`${report.driver}\``);
    lines.push('');
    lines.push(`_generated ${report.generatedAt}_`);
    lines.push('');
    lines.push(
        '| Task | Family | Cond | Choice | Compiled | Ran | Shape | Turns | Tok In | Tok Out |',
    );
    lines.push('| --- | --- | --- | --- | :-: | :-: | :-: | --: | --: | --: |');
    for (const c of report.cells) {
        lines.push(
            `| ${c.taskId} | ${c.family} | ${c.condition} | ${c.choice} | ` +
                `${tick(c.compiled)} | ${tick(c.ran)} | ${tick(c.shapeOk)} | ` +
                `${c.transcriptTurns} | ${c.tokensIn} | ${c.tokensOut} |`,
        );
    }
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(
        `- Passing (ran + shape ok): **${report.summary.passing}/${report.summary.total}**`,
    );
    lines.push(
        `- stitch-rate — cold: **${pct(report.summary.stitchRate.cold)}**, ` +
            `warm: **${pct(report.summary.stitchRate.warm)}**`,
    );
    lines.push('- Choice counts:');
    for (const choice of CHOICES) {
        const n = report.summary.choiceCounts[choice];
        if (n > 0) lines.push(`  - \`${choice}\`: ${n}`);
    }
    lines.push('');
    return lines.join('\n');
}

const tick = (b: boolean): string => (b ? '✅' : '❌');
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const round = (n: number): number => Math.round(n * 1000) / 1000;
