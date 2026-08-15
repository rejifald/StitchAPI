// Spawn `probe.ts` in a fresh process and read back its one line of JSON.
//
// The claim scripts do not measure anything themselves. They ask for measurements, one process each,
// and assert on the shapes of the curves that come back. That separation is deliberate: a claim
// script that measured in-process would be comparing numbers taken from a heap its own earlier
// measurements had already grown and fragmented.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'probe.ts');
/** The repo root — `pnpm exec` must run there for `tsx` to resolve. */
const ROOT = join(HERE, '..', '..', '..', '..');

/** A measurement that succeeded. */
export interface ProbeOk {
    ok: true;
    mode: string;
    rows: number;
    wireBytes: number;
    records: number;
    peakHeap: number;
    peakLive: number;
    peakBuffers: number;
    settled: number;
    ratio: number;
    ticks: number;
    marks: number;
    ms: number;
}
/** A measurement whose workload BLEW UP. Also data — C3's pre-#665 cap trip was one of these. */
export interface ProbeFail {
    ok: false;
    mode: string;
    rows: number;
    error: string;
}
export type Probe = ProbeOk | ProbeFail;

export interface ProbeArgs {
    mode: string;
    rows: number;
    /** `stream.buffer.chars`. Omit for the library default (~8M). */
    buffer?: number;
    /** Extra node flags, e.g. `['--max-old-space-size=96']` to give the run a real heap ceiling. */
    nodeArgs?: string[];
}

/** The raw outcome of a probe process, INCLUDING one that died. C7 needs the corpse. */
export interface ProbeRun {
    /** Exit code. `null` when the process was killed by a signal. */
    status: number | null;
    stdout: string;
    stderr: string;
    /** The parsed measurement, when the process lived long enough to print one. */
    measurement: Probe | undefined;
    /** True when V8 aborted on a heap limit — the only signal the buffered path ever gives. */
    heapOom: boolean;
}

/** Run one probe process and hand back everything it did, alive or dead. */
export function probeRun({
    mode,
    rows,
    buffer,
    nodeArgs = [],
}: ProbeArgs): ProbeRun {
    const args = [
        'exec',
        'tsx',
        '--expose-gc',
        ...nodeArgs,
        PROBE,
        `--mode=${mode}`,
        `--rows=${String(rows)}`,
    ];
    if (buffer !== undefined) args.push(`--buffer=${String(buffer)}`);
    const r = spawnSync('pnpm', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    const line = stdout.trim().split('\n').at(-1) ?? '';
    return {
        status: r.status,
        stdout,
        stderr,
        measurement: line.startsWith('{')
            ? (JSON.parse(line) as Probe)
            : undefined,
        heapOom: /heap out of memory|Allocation failed/i.test(
            `${stdout}\n${stderr}`,
        ),
    };
}

/** Run one probe. Throws only when the CHILD ITSELF failed to run (a crash, a bad path). */
export function probe(args: ProbeArgs): Probe {
    const r = probeRun(args);
    if (r.measurement === undefined) {
        throw new Error(
            `probe ${args.mode}@${String(args.rows)} produced no measurement.\n` +
                `exit=${String(r.status)}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
    }
    return r.measurement;
}

/** Run one probe and insist it succeeded. */
export function probeOk(args: ProbeArgs): ProbeOk {
    const p = probe(args);
    if (!p.ok)
        throw new Error(`probe ${p.mode}@${String(p.rows)} failed: ${p.error}`);
    return p;
}

/** The 1x / 10x / 100x series every scaling claim in this directory is built on. */
export const SCALES = [1_000, 10_000, 100_000] as const;

/**
 * Run a mode across {@link SCALES}. Returns the three measurements in order.
 *
 * A cap large enough to be irrelevant is passed by default so the SHAPE of the curve is what is
 * measured rather than where the library's 8M-char guard happens to sit; C3 measures the guard
 * itself, separately and on purpose.
 */
export function series(mode: string, buffer = 1_000_000_000): ProbeOk[] {
    return SCALES.map((rows) => probeOk({ mode, rows, buffer }));
}
