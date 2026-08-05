// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is a MEASURED NUMBER, and heap numbers are noisy. So the assertions here
// are deliberately loose where the physics is loose and tight where it is not:
//
//   - `check` / `checkSeq` — exact equality, for the CORRECTNESS half (element counts, boundaries,
//     event spines). Nothing noisy about those.
//   - `checkFlat` — "peak heap did NOT grow with N". Asserts the 100x measurement is within a
//     tolerance of the 1x one. The flat-vs-linear shape is the robust signal, not any single figure.
//   - `checkLinear` — the opposite claim: peak heap DID grow roughly with N. Asserts growth exceeds
//     a floor, so a merely-noisy measurement cannot pass it.
//   - `checkAtMost` / `checkAtLeast` — one-sided bounds, for ratios where only the direction matters.
//
// Every one of them prints the measured number whether it passes or fails, because the number is
// the finding.

let failures = 0;
let checks = 0;

/** Render a measured value unambiguously. */
function show(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    return JSON.stringify(v) ?? String(v);
}

/** Bytes as MB, 1 decimal — the unit every heap number in this directory is reported in. */
export function mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** A ratio as `12.4x`. */
export function x(ratio: number): string {
    return `${ratio.toFixed(1)}x`;
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

/** Assert a measured SEQUENCE matches, element-wise via `JSON.stringify`. Prints it in full. */
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

/** One-sided bound: the measured number must not exceed `limit`. */
export function checkAtMost(
    label: string,
    actual: number,
    limit: number,
    render: (n: number) => string = show,
): void {
    checks++;
    const ok = actual <= limit;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${render(actual)} (limit ${render(limit)})`,
    );
}

/** One-sided bound: the measured number must be at least `floor`. */
export function checkAtLeast(
    label: string,
    actual: number,
    floor: number,
    render: (n: number) => string = show,
): void {
    checks++;
    const ok = actual >= floor;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${render(actual)} (floor ${render(floor)})`,
    );
}

/**
 * FLAT: `big` (the 100x workload) used no more than `tolerance`x the heap of `small` (the 1x one).
 * This is the control assertion — a decoder whose working set is one record is flat by construction,
 * so the tolerance can be tight (2x) and still never flake. `+1` guards a divide-by-zero when a
 * measurement lands at 0 bytes of retained heap, which happens for the truly O(1) modes.
 */
export function checkFlat(
    label: string,
    small: number,
    big: number,
    tolerance = 2,
): void {
    checks++;
    const growth = (big + 1) / (small + 1);
    const ok = growth <= tolerance;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${mb(small)} -> ${mb(big)} = ${x(growth)} growth (flat if <= ${x(tolerance)})`,
    );
}

/**
 * LINEAR: `big` used at least `floor`x the heap of `small`. The workloads differ by 100x, so a floor
 * of 10x is far outside anything measurement noise produces — this cannot pass by accident.
 */
export function checkLinear(
    label: string,
    small: number,
    big: number,
    floor = 10,
): void {
    checks++;
    const growth = (big + 1) / (small + 1);
    const ok = growth >= floor;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${mb(small)} -> ${mb(big)} = ${x(growth)} growth (linear if >= ${x(floor)})`,
    );
}

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown = ''): void {
    const v =
        value === ''
            ? ''
            : `: ${typeof value === 'string' ? value : show(value)}`;
    console.log(`  note  ${label}${v}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
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
