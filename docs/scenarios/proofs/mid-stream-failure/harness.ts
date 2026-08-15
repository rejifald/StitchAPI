// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's whole argument is a SEQUENCE (which deltas did the consumer actually see, in what
// order), so `checkSeq` is the load-bearing assertion: it prints the measured sequence in full on
// pass AND on fail, because "the consumer saw `ABCABCABCABC`" is the finding.

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
 * sequence is printed in full whether it passes or fails — for this scenario the sequence IS the
 * evidence, so it must be readable out of context.
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
    console.log(`  note  ${label}: ${String(value)}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
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
