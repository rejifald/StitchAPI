// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is REQUESTS THAT REACHED THE SERVER and PEAK IN-FLIGHT. Every claim
// here is ultimately a statement about one of those two numbers — "100 calls, 30 distinct ids, how
// many requests?" and "you asked for 8 at a time, how many were actually open?" — so both have a
// dedicated assertion that prints the comparison, not just the value. `100 requests for 30 ids`
// and `peak 100 in-flight under concurrency: 8` have to be readable out of context.
//
// Everything else follows `unconfirmed-write/harness.ts`: `check` for an exact value, `checkSeq`
// for a measured sequence, `note` for a reported-but-not-asserted number, `finish` for the verdict.

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
 * sequence is printed in full whether it passes or fails — the per-id request spine
 * (`[1,1,1,4,1]`) and the retry-arrival spine (`[100,100,100]`) ARE the evidence.
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
 * THE assertion of C2: how many requests reached the server, against how many DISTINCT resources
 * were asked for.
 *
 * Both numbers, because the pair is the finding. `100 requests for 30 distinct ids` is a fan-out
 * that paid 3.3x its quota; `30 requests for 30 distinct ids` is in-flight coalescing working. A
 * bare "30" says neither.
 */
export function checkRequests(
    label: string,
    requests: number,
    distinct: number,
    expected: number,
): void {
    checks++;
    const ok = requests === expected;
    if (!ok) failures++;
    const ratio = (requests / distinct).toFixed(2);
    const verdict =
        requests === distinct
            ? '  <- one per distinct id'
            : `  <- ${ratio}x the distinct-id floor`;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: REQUESTS ${String(requests)} for ${String(distinct)} distinct ids${verdict}${
            ok ? '' : ` (expected ${String(expected)})`
        }`,
    );
}

/**
 * THE assertion of C3: the peak number of requests open at the server at once, against the bound
 * the caller declared.
 *
 * Printed together for the same reason `checkRequests` prints both sides: `peak 100, declared
 * bound 8` is the footgun this scenario exists to catch, and it is unreadable as a bare `100`.
 * Pass `bound: undefined` for the unbounded baseline.
 */
export function checkPeak(
    label: string,
    peak: number,
    bound: number | undefined,
    expected: number,
): void {
    checks++;
    const ok = peak === expected;
    if (!ok) failures++;
    const against =
        bound === undefined
            ? ' (no bound declared)'
            : peak <= bound
              ? `, declared bound ${String(bound)}  <- HELD`
              : `, declared bound ${String(bound)}  <- BREACHED by ${String(peak - bound)}`;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: PEAK IN-FLIGHT ${String(peak)}${against}${
            ok ? '' : ` (expected ${String(expected)})`
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

/** Assert a measured number is at least `bound` — the de-clustering floor in C5. */
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
 * Print the claim's verdict line and exit. `claim` is e.g. `'C2'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Some claims here PASS by measuring the library doing something genuinely good (C2's in-flight
 * coalescing) and some by measuring an unbounded fan-out that looked bounded, so the verdict
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
