// Assertion + measurement harness for the `dual-run-migration` proofs. Every check prints a line and
// the script exits non-zero if any check failed. No test framework — these are standalone `tsx`
// scripts, exactly like the other proof directories.
//
// What this directory needs that the others did not: a CHANNEL TABLE and a REQUEST LEDGER.
//
//   - Every claim here reduces to "how many requests did the vendor actually receive, and what was
//     in them?" — so the primitive is a count and a literal URL string taken from the fake
//     transport, never a belief about what the config should have done. `ledgerRow` records one
//     measured configuration; `printLedger` prints the matrix.
//   - C1 asks a four-part question ("can the shadow hurt the primary?") whose answer is a table:
//     channel × safe-by-default × what it takes. `channelRow` / `printChannels` build exactly that.
//
// TIMING NOTE, stated once and inherited by every script here. Scenario 19 measured that
// `manualClock()` does NOT drive `timeout.total`, `cache.ttl`, event `at` / `done.elapsed`, OAuth2
// expiry, or SigV4. Two consequences for this directory:
//
//   - C1 (a) measures CALLER-OBSERVED LATENCY, which is wall-clock by definition. It uses
//     `performance.now()` and a real `setTimeout` inside the fake adapter. Every latency number in
//     this directory is REAL TIME, and is reported in a band rather than as an exact figure.
//   - C1 (d) measures CIRCUIT COOLDOWN, which `manualClock` DOES drive (retry backoff, throttle
//     pacing, per-attempt timeout, circuit cooldown). Those scripts inject a `manualClock` and say so.

let failures = 0;
let checks = 0;

/** Render a measured value unambiguously — `undefined` vs `'undefined'` decides several rows. */
function show(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'string') return JSON.stringify(v);
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

/** Assert an exact string match, printing the measured string. For URLs and error messages. */
export function checkStr(
    label: string,
    actual: string,
    expected: string,
): void {
    checks++;
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`,
    );
}

/**
 * Assert a measured SEQUENCE matches, comparing element-wise via `JSON.stringify`. The measured
 * sequence prints in full whether it passes or fails — a request ledger IS the evidence for several
 * rows here.
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
 * Assert a measured number falls in an inclusive BAND. The only honest assertion shape for a
 * wall-clock latency: the measurement is real time, so an exact equality would be a flake, and a
 * bare `note` would let the reader supply the verdict. Prints the measured number either way.
 */
export function checkBand(
    label: string,
    actual: number,
    lo: number,
    hi: number,
): void {
    checks++;
    const ok = actual >= lo && actual <= hi;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${actual}${ok ? '' : ` (expected ${lo}..${hi})`}`,
    );
}

/** Assert a substring is present — for an error message whose prefix is the load-bearing part. */
export function checkHas(
    label: string,
    haystack: string,
    needle: string,
): void {
    checks++;
    const ok = haystack.includes(needle);
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${ok ? 'present' : 'ABSENT'} in ${JSON.stringify(haystack)}${ok ? '' : ` (wanted ${JSON.stringify(needle)})`}`,
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

// ---- the request ledger ----------------------------------------------------
// One row per measured CONFIGURATION: how many requests each version's endpoint actually received.
// The counts come from the fake transport (vendor.ts), which is the only thing in the process that
// can see a request — so a row is a measurement of the wire, not of the config's intent.

export interface LedgerRow {
    config: string;
    v1: number;
    v2: number;
    /** What the caller observed — a value, an error class, a count. Free text. */
    caller: string;
}

const ledgerRows: LedgerRow[] = [];

export function ledgerRow(
    config: string,
    v1: number,
    v2: number,
    caller: string,
): LedgerRow {
    const row: LedgerRow = { config, v1, v2, caller };
    ledgerRows.push(row);
    return row;
}

export function printLedger(title = 'requests the vendor received'): void {
    if (ledgerRows.length === 0) return;
    const w = Math.max(...ledgerRows.map((r) => r.config.length), 6);
    const c = Math.max(...ledgerRows.map((r) => r.caller.length), 6);
    console.log(
        `\n  ${title}\n\n  ${'configuration'.padEnd(w)}  ${'v1'.padStart(4)}  ${'v2'.padStart(4)}  ${'caller saw'.padEnd(c)}\n` +
            `  ${'-'.repeat(w)}  ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(c)}`,
    );
    for (const r of ledgerRows)
        console.log(
            `  ${r.config.padEnd(w)}  ${String(r.v1).padStart(4)}  ${String(r.v2).padStart(4)}  ${r.caller.padEnd(c)}`,
        );
}

export function resetLedger(): void {
    ledgerRows.length = 0;
}

// ---- the C1 channel table --------------------------------------------------
// Four ways a shadow can hurt a primary. Each row is filled from a MEASUREMENT in this directory,
// and carries the measurement that decided it so the table is auditable from its own output.

export interface ChannelRow {
    /** `(a) latency`, `(b) thrown`, … — the capture's own labels. */
    channel: string;
    /** Is the primary safe with NO extra configuration? */
    safeByDefault: boolean;
    /** The number/string that decided the cell. */
    measured: string;
    /** What it takes to make it safe (or `'—'` when it already is). */
    fix: string;
}

const channelRows: ChannelRow[] = [];

export function channelRow(row: ChannelRow): ChannelRow {
    channelRows.push(row);
    return row;
}

export function printChannels(): void {
    if (channelRows.length === 0) return;
    const w = Math.max(...channelRows.map((r) => r.channel.length), 7);
    const m = Math.max(...channelRows.map((r) => r.measured.length), 8);
    console.log(
        `\n  C1 — the four channels a shadow can hurt the primary through\n\n` +
            `  ${'channel'.padEnd(w)}  safe?  ${'measured'.padEnd(m)}  what it takes\n` +
            `  ${'-'.repeat(w)}  -----  ${'-'.repeat(m)}  -------------`,
    );
    for (const r of channelRows)
        console.log(
            `  ${r.channel.padEnd(w)}  ${(r.safeByDefault ? 'YES' : 'NO').padEnd(5)}  ${r.measured.padEnd(m)}  ${r.fix}`,
        );
}

// ---- line counting ---------------------------------------------------------
// C2 and C8 report a COST in lines. Counting them by hand invites flattery, so the scripts count
// the real thing: executable lines in a marked region of a file on disk.

/**
 * Count EXECUTABLE lines between `>>> BEGIN USER CODE` and `<<< END USER CODE` in a source file —
 * blank lines and comment-only lines excluded. This is the honest denominator for "what does the
 * working spelling cost": it counts what a reader would have to write and maintain, not the prose
 * explaining it.
 */
export function countUserLines(source: string, marker = ''): number {
    const lines = source.split('\n');
    const begin = `>>> BEGIN USER CODE${marker ? ' ' + marker : ''}`;
    const end = `<<< END USER CODE${marker ? ' ' + marker : ''}`;
    let inside = false;
    let count = 0;
    for (const raw of lines) {
        const line = raw.trim();
        if (!inside) {
            if (line.includes(begin)) inside = true;
            continue;
        }
        if (line.includes(end)) break;
        if (line === '') continue;
        if (line.startsWith('//') || line.startsWith('*') || line === '*/')
            continue;
        count++;
    }
    return count;
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring a HAZARD. The verdict statement always carries the direction.
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
