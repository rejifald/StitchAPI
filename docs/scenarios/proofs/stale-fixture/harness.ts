// Minimal assertion harness for the proof scripts: every check prints a line, and the script exits
// non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence has one unusual shape that needed its own assertion, so it is worth
// naming up front. Most proofs measure "did the library do the right thing". C2 has to measure
// something else: **did the test assert anything at all**. A `timeout.total` test written with
// `manualClock()` does not fail — it passes, having exercised nothing. `checkVacuous` is the
// assertion for that: it runs the SAME script body twice, once with the clock advanced by the
// amount the test claims is decisive and once with the clock never advanced, and PASSES when the
// two outcomes are identical. Identical outcomes mean the `advance()` call was decoration.
//
// `check` / `checkSeq` / `note` / `heading` / `finish` follow `intermittent-drift/harness.ts`
// unchanged, so a reader who has seen one proof directory has seen this one.

let failures = 0;
let checks = 0;

// A stalled `await` must never read as a pass: if the event loop drains before `finish()` has
// printed a verdict, the run was silently truncated mid-file. `process.exit` inside `finish()`
// skips `beforeExit`, so real passes and fails are unaffected — only a stall trips this.
let finished = false;
process.on('beforeExit', () => {
    if (!finished) {
        console.log(
            '\nFAIL — the event loop drained before finish() ran: a probe stalled mid-file',
        );
        process.exitCode = 1;
    }
});

/** Render a measured value unambiguously — `undefined` vs `'undefined'` decides several rows. */
function show(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    return JSON.stringify(v) ?? String(v);
}

/** Assert an observed value equals what the claim predicts. Prints the MEASURED value either way. */
export function check(label: string, actual: unknown, expected: unknown): void {
    checks++;
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${show(actual)}${ok ? '' : ` (expected ${show(expected)})`}`,
    );
}

/**
 * Assert a measured SEQUENCE matches, comparing element-wise via `JSON.stringify`. The measured
 * sequence is printed in full whether it passes or fails — the event spine
 * (`["start","progress","retry","progress","result","done"]`) and the backoff gaps
 * (`[1000,2000,4000]`) ARE the evidence.
 */
export function checkSeq(
    label: string,
    actual: readonly unknown[],
    expected: readonly unknown[],
): void {
    checks++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${a}${ok ? '' : ` (expected ${e})`}`,
    );
}

/** Assert a measured number lies within `tol` of `expected` — for the one wall-clock row in C2. */
export function checkNear(
    label: string,
    actual: number,
    expected: number,
    tol: number,
): void {
    checks++;
    const ok = Math.abs(actual - expected) <= tol;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)} (expected ${String(expected)} ±${String(tol)})`,
    );
}

/** Assert a measured value is at least `bound`. */
export function checkAtLeast(
    label: string,
    actual: number,
    bound: number,
): void {
    checks++;
    const ok = actual >= bound;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)}${ok ? ` (>= ${String(bound)})` : ` (expected >= ${String(bound)})`}`,
    );
}

/** The outcome of one run of a clock-sensitivity probe, reduced to a comparable string. */
export type Outcome = string;

/**
 * THE assertion of C2. `body(advanceMs)` runs a scenario and returns a string summarising what
 * happened. It is called twice: once with the amount of virtual time the test believes is decisive,
 * and once with `0`. The claim under test is "`manualClock` drives this feature", so:
 *
 * - **driven**: the two outcomes DIFFER — `advance()` changed the result, the assertion had teeth.
 * - **inert**: the two outcomes are IDENTICAL — the feature never consulted the injected clock, so
 *   a test that advances it and then asserts on the result asserts nothing about time.
 *
 * Both directions are legitimate measurements, so `expect` says which one this row claims, and the
 * printed line always carries both outcomes.
 */
export async function checkClockDriven(
    feature: string,
    expect: 'driven' | 'inert',
    body: (advanceMs: number) => Promise<Outcome>,
    advanceMs: number,
): Promise<void> {
    checks++;
    const advanced = await body(advanceMs);
    const frozen = await body(0);
    const driven = advanced !== frozen;
    const verdict = driven ? 'driven' : 'inert';
    const ok = verdict === expect;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${feature.padEnd(30)} -> ${verdict.toUpperCase().padEnd(6)} ` +
            `advance(${String(advanceMs)})=${advanced} | advance(0)=${frozen}` +
            `${ok ? '' : ` (expected ${expect})`}`,
    );
}

/**
 * One row of the C2 table. Three verdicts, because two were not enough:
 *
 * - `CLOCK` — `advance()` drives it. A test can assert on it.
 * - `WALL`  — it reads `Date.now()` through `util.now()` regardless. A test that advances the clock
 *             and asserts on it is asserting nothing the advance caused.
 * - `NONE`  — the feature has no time in it to drive. Neither a win nor a gap; recorded so the
 *             table is an enumeration rather than a selection.
 */
export interface ClockRow {
    feature: string;
    verdict: 'CLOCK' | 'WALL' | 'NONE';
    evidence: string;
}

const rows: ClockRow[] = [];

const LABEL: Record<ClockRow['verdict'], string> = {
    CLOCK: 'manualClock',
    WALL: 'WALL CLOCK ',
    NONE: 'no time    ',
};

/** Record a C2 table row (printed by {@link printClockTable}). */
export function row(
    feature: string,
    verdict: ClockRow['verdict'],
    evidence: string,
): void {
    rows.push({ feature, verdict, evidence });
}

/** Print the accumulated C2 table, plus the per-verdict tallies. */
export function printClockTable(): {
    clock: number;
    wall: number;
    none: number;
} {
    const w = Math.max(...rows.map((r) => r.feature.length));
    console.log(
        `\n  ${'feature'.padEnd(w)}  driven by    evidence\n  ${'-'.repeat(w)}  -----------  --------`,
    );
    for (const r of rows) {
        console.log(
            `  ${r.feature.padEnd(w)}  ${LABEL[r.verdict]}  ${r.evidence}`,
        );
    }
    return {
        clock: rows.filter((r) => r.verdict === 'CLOCK').length,
        wall: rows.filter((r) => r.verdict === 'WALL').length,
        none: rows.filter((r) => r.verdict === 'NONE').length,
    };
}

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown = ''): void {
    const v = value === '' ? '' : `: ${show(value)}`;
    console.log(`  note  ${label}${v}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring a FAILURE of the library (C2's inert rows, C5's asymmetry),
 * so the verdict statement always carries the direction.
 */
export function finish(claim: string, statement: string): never {
    finished = true;
    const pass = failures === 0;
    console.log(
        `\n${pass ? 'PASS' : 'FAIL'} ${claim} — ${statement} (${checks - failures}/${checks} checks)`,
    );
    process.exit(pass ? 0 : 1);
    // `process.exit` is typed `never`, but TypeScript still wants the end point unreachable.
    throw new Error('unreachable');
}
