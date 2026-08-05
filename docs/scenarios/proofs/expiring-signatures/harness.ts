// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is an AGE IN MILLISECONDS: how long a signature sat between the
// instant it was minted and the instant it reached the wire. So every assertion prints the
// measured number whether it passes or fails — `age 0ms` and `age 360000ms` ARE the findings,
// and they have to be readable out of context.
//
// Two of the checks below exist because half this scenario cannot be measured on a virtual clock
// (C5: the shipped signer stamps `new Date()`), so those runs use REAL time and their numbers
// carry real scheduling jitter. `checkAtMost` / `checkAtLeast` state the bound the claim actually
// rests on rather than pretending a wall-clock measurement is exact.

let failures = 0;
let checks = 0;

/** Assert an observed value equals what the claim predicts. Prints the MEASURED value either way. */
export function check(label: string, actual: unknown, expected: unknown): void {
    checks++;
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`,
    );
}

/**
 * Assert a measured SEQUENCE matches, comparing element-wise via `JSON.stringify`. The measured
 * sequence is printed in full whether it passes or fails — the per-attempt timestamp spine
 * (`["...T120000Z","...T120500Z"]`) and the age spine (`[0,0,0,0]`) ARE the evidence.
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

/**
 * Assert a measured number is at most `bound`. The wall-clock claims need this: "the signature was
 * no more than 250ms old when it hit the wire" is the real statement, and an equality check on a
 * real-time measurement would be a check on the machine's scheduler, not on the library.
 */
export function checkAtMost(
    label: string,
    actual: number,
    bound: number,
): void {
    checks++;
    const ok = actual <= bound;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)}${ok ? ` (<= ${String(bound)})` : ` (expected <= ${String(bound)})`}`,
    );
}

/** Assert a measured number is at least `bound` — the other half of a wall-clock bound. */
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

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown): void {
    console.log(`  note  ${label}: ${String(value)}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring the library doing the RIGHT thing, and one (C5) passes by
 * measuring it doing the wrong one — the verdict statement carries the direction, because
 * "PASS C5" on a claim whose content is "the signer ignores the injected clock" is otherwise
 * unreadable.
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
