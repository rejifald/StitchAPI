// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is THE VALUE THE CALLER RECEIVED. A drift finding that says
// `warn|coerced|transaction_id|string -> number` is compatible with the caller getting `12345` and
// with the caller getting `0`, and the whole scenario turns on which one it was. So `check` prints
// the measured value with `JSON.stringify`, not `String` — `0`, `"0"`, `null` and `"12345"` have to
// be distinguishable on the page, and `String(null)` and `String('null')` are not.
//
// `checkSeq` carries the drift findings themselves (a finding is only a claim if its level, kind,
// path and detail are all on the page) and the per-call value spines the rate claims are computed
// from.

let failures = 0;
let checks = 0;

/** Render a measured value unambiguously — `0` vs `"0"` vs `null` is the whole scenario. */
function show(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (typeof v === 'bigint') return `${v}n`;
    if (Number.isNaN(v)) return 'NaN';
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
 * sequence is printed in full whether it passes or fails — the finding spine
 * (`["warn|coerced|transaction_id|string -> number"]`) and the per-call value spine
 * (`[12345,0,0]`) ARE the evidence.
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

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown): void {
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
 * Some claims here PASS by measuring DAMAGE (C3's `0`), and some PASS by measuring that the library
 * does the right thing (C1's silence, C6's 5.0%). The verdict statement carries the direction.
 */
export function finish(claim: string, statement: string): never {
    const pass = failures === 0;
    console.log(
        `\n${pass ? 'PASS' : 'FAIL'} ${claim} — ${statement} (${checks - failures}/${checks} checks)`,
    );
    process.exit(pass ? 0 : 1);
    // `process.exit` is typed `never`, but TypeScript still wants the end point unreachable.
    throw new Error('unreachable');
}
