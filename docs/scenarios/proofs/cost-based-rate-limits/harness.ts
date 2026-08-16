// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.

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

/** Assert an observed value equals what the claim predicts. Prints the MEASURED number either way. */
export function check(label: string, actual: unknown, expected: unknown): void {
    checks++;
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`,
    );
}

/**
 * Assert a measured number is within `tolerance` of `expected`. The cost arithmetic here is
 * floating point (points refill continuously), so an exact `Object.is` on a computed wait would
 * assert the float, not the claim.
 */
export function checkNear(
    label: string,
    actual: number,
    expected: number,
    tolerance = 1e-6,
): void {
    checks++;
    const ok = Math.abs(actual - expected) <= tolerance;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${actual}${ok ? '' : ` (expected ${expected} ±${tolerance})`}`,
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
