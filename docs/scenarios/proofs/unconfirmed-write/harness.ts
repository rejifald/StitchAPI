// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is A COUNT OF CHARGES. Every other number here — how many requests
// reached the wire, how many distinct idempotency keys they carried, what the caller was told — is
// only interesting because it explains that count. So `checkCharges` is the assertion that matters
// and it prints BOTH sides of the comparison, always: how many charges the vendor ended up holding
// against how many the caller meant to create. `created 2, intended 1` is the finding, and it has to
// be readable out of context.
//
// Everything else follows `expiring-signatures/harness.ts`: `check` for an exact value, `checkSeq`
// for a measured sequence, `note` for a reported-but-not-asserted number, `finish` for the verdict.

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
 * sequence is printed in full whether it passes or fails — the per-attempt key spine
 * (`["chg-inv-1001","chg-inv-1001"]`) and the per-request status spine (`[500,500,500]`) ARE the
 * evidence.
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
 * THE assertion of this scenario: how many charges the vendor actually holds, against how many the
 * caller intended to create.
 *
 * It takes both numbers because the pair is the finding — a bare "2" means nothing, and
 * `created 2, intended 1  ← DOUBLE CHARGE` is the whole result of C2. `expected` is what the claim
 * predicts the library will do, which is NOT always `intended`: several claims here PASS by
 * measuring a double charge that the configuration made inevitable.
 */
export function checkCharges(
    label: string,
    created: number,
    intended: number,
    expected: number,
): void {
    checks++;
    const ok = created === expected;
    if (!ok) failures++;
    const verdict =
        created > intended
            ? `  <- ${String(created - intended)} MORE THAN INTENDED`
            : created < intended
              ? `  <- ${String(intended - created)} FEWER THAN INTENDED`
              : '  <- matches intent';
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: CHARGES created ${String(created)}, intended ${String(intended)}${verdict}${
            ok ? '' : ` (expected created ${String(expected)})`
        }`,
    );
}

/** Assert a measured number is at most `bound`. */
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

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown): void {
    console.log(`  note  ${label}: ${String(value)}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C2'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Half the claims here PASS by measuring the library doing the right thing and half by measuring it
 * doing something that costs money, so the verdict statement always carries the direction.
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
