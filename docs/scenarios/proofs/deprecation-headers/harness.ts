// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is REACHABILITY: given an accessor, is the response header there or not.
// That is a yes/no with a value attached, and both halves matter — "`.inspect()` does not carry
// `Sunset`" and "`hooks.onResponse` carries `Wed, 01 Jan 2026 00:00:00 GMT`" are the same
// measurement pointed at two places. So `checkReach` is the assertion this file exists for: it
// prints the accessor, whether the header was REACHED, and the value it reached, on one line that
// reads out of context — the C1 table is literally its output.
//
// The rest follows `intermittent-drift/harness.ts`: `check` for an exact value rendered with
// `JSON.stringify` (so `undefined` and `'undefined'` stay distinguishable), `checkSeq` for a
// measured sequence, `note` for a reported-but-not-asserted number, `finish` for the verdict.

let failures = 0;
let checks = 0;

/** Render a measured value unambiguously — `undefined` vs `'undefined'` decides C1. */
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
 * (`["start","progress","result","done"]`) and the fleet report
 * (`["users — sunset in 12 days", ...]`) ARE the evidence.
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
 * THE assertion of C1: can this accessor see a response header, and what did it see?
 *
 * Both halves on one line, because the pair is the finding. `hooks.onResponse -> REACHED
 * "Wed, 01 Jan 2026 00:00:00 GMT"` and `.inspect() -> ABSENT` are the consolidation deliverable,
 * and a bare `true`/`false` is unreadable three pages later. `expected` is whether the claim
 * predicts reachability, so a wrong prediction fails loudly rather than quietly recording whatever
 * happened.
 */
export function checkReach(
    accessor: string,
    value: unknown,
    expected: boolean,
): void {
    checks++;
    const reached = value !== undefined && value !== null;
    const ok = reached === expected;
    if (!ok) failures++;
    const verdict = reached ? `REACHED ${show(value)}` : 'ABSENT';
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${accessor.padEnd(22)} -> ${verdict}${
            ok ? '' : ` (expected ${expected ? 'REACHED' : 'ABSENT'})`
        }`,
    );
}

/** Assert a measured number is at most `bound` — the de-duplication ceiling in C7. */
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
 * Several claims here PASS by measuring an ABSENCE (C1's five accessors that carry nothing) and
 * several by measuring the library doing something genuinely good (C5's tripwire), so the verdict
 * statement always carries the direction.
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
