// Minimal assertion harness for the proof scripts: every check prints a line, and the script exits
// non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario needs one thing the other proof directories did not: a renderer that prints the
// EXACT DIGITS of a number. That is not `String(n)` and it is definitely not `JSON.stringify(n)` —
// both are fine for a snowflake but both go exponential above ~1e21, and both are the very
// formatting layer whose fidelity is in question. `digits()` below routes an integral double
// through `BigInt`, which is exact by construction: it prints the integer the double ACTUALLY IS,
// with every digit, including the ones the vendor never sent.
//
// The rest — `check` / `checkStr` / `checkSeq` / `note` / `heading` / `finish` — follows
// `stale-fixture/harness.ts` unchanged, so a reader who has seen one proof directory has seen
// this one.

let failures = 0;
let checks = 0;

/**
 * The exact decimal digits of a value, for the one comparison this whole directory is about.
 *
 * - an integral `number` goes through `BigInt`, which cannot round or abbreviate: a double that
 *   holds 1234567890123456768 prints as `1234567890123456768`, never `1.2345678901234568e+18`.
 * - a `bigint` prints its digits with an `n` suffix, so a repaired value is never mistaken for a
 *   corrupted one in the output.
 * - a non-integral number prints via `String`, which is the shortest round-tripping form — the
 *   right rendering for `19.99` and for `0.30000000000000004` alike.
 */
export function digits(v: unknown): string {
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return 'NaN';
        if (!Number.isFinite(v)) return String(v);
        if (Number.isInteger(v)) return BigInt(v).toString();
        return String(v);
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    return String(v);
}

/** Render a measured value unambiguously — `undefined` vs `'undefined'` decides several rows. */
function show(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'number') return digits(v);
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
 * Assert a measured value's EXACT DIGITS equal an expected digit string. The digit string is the
 * evidence — the whole scenario is "these digits are not those digits" — so the comparison is done
 * on the rendered form rather than on the value, and the rendered form is what prints.
 */
export function checkDigits(
    label: string,
    actual: unknown,
    expected: string,
): void {
    checks++;
    const a = digits(actual);
    const ok = a === expected;
    if (!ok) failures++;
    console.log(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${a}${ok ? '' : ` (expected ${expected})`}`,
    );
}

/** Assert an exact string match, printing the measured string. For error messages, mostly. */
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
 * sequence is printed in full whether it passes or fails — the event spine
 * (`["start","progress","result","done"]`) IS the evidence for C1's silence claim.
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
export function note(label: string, value: unknown = ''): void {
    const v = value === '' ? '' : `: ${show(value)}`;
    console.log(`  note  ${label}${v}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

// ---- the sent-vs-received table -------------------------------------------
// Every claim in this directory reduces to one shape: a digit string went onto the wire, some
// other digit string came off it. `wireRow`/`printWireTable` collect and print exactly that, with
// an `intact` column so the eye does not have to diff nineteen digits.

export interface WireRow {
    what: string;
    sent: string;
    received: string;
    intact: boolean;
}

const wireRows: WireRow[] = [];

/** Record one sent-digits / received-digits pair (printed by {@link printWireTable}). */
export function wireRow(
    what: string,
    sent: string,
    received: unknown,
): WireRow {
    const r = {
        what,
        sent,
        received: digits(received),
        intact: digits(received) === sent,
    };
    wireRows.push(r);
    return r;
}

/** Print the accumulated sent/received table and return how many values survived. */
export function printWireTable(): { intact: number; corrupted: number } {
    const w = Math.max(...wireRows.map((r) => r.what.length), 4);
    const s = Math.max(...wireRows.map((r) => r.sent.length), 4);
    const g = Math.max(...wireRows.map((r) => r.received.length), 8);
    console.log(
        `\n  ${'what'.padEnd(w)}  ${'sent'.padEnd(s)}  ${'received'.padEnd(g)}  verdict\n` +
            `  ${'-'.repeat(w)}  ${'-'.repeat(s)}  ${'-'.repeat(g)}  -------`,
    );
    for (const r of wireRows) {
        console.log(
            `  ${r.what.padEnd(w)}  ${r.sent.padEnd(s)}  ${r.received.padEnd(g)}  ${r.intact ? 'intact' : 'CORRUPTED'}`,
        );
    }
    return {
        intact: wireRows.filter((r) => r.intact).length,
        corrupted: wireRows.filter((r) => !r.intact).length,
    };
}

// ---- the seam table -------------------------------------------------------
// C2's question is "can ANY downstream seam see the original digits". Each seam gets one row:
// what it observed, and whether that observation could distinguish a corrupted ID from an intact
// one. `SEES_TEXT` is the only verdict that would refute the capture.

export interface SeamRow {
    seam: string;
    verdict: 'SEES_TEXT' | 'SEES_PARSED' | 'ABSENT';
    observed: string;
}

const seamRows: SeamRow[] = [];

const SEAM_LABEL: Record<SeamRow['verdict'], string> = {
    SEES_TEXT: 'RAW TEXT  ',
    SEES_PARSED: 'parsed body',
    ABSENT: 'nothing    ',
};

/** Record a C2 table row (printed by {@link printSeamTable}). */
export function seamRow(
    seam: string,
    verdict: SeamRow['verdict'],
    observed: string,
): void {
    seamRows.push({ seam, verdict, observed });
}

/** Print the accumulated C2 seam table plus per-verdict tallies. */
export function printSeamTable(): {
    text: number;
    parsed: number;
    absent: number;
} {
    const w = Math.max(...seamRows.map((r) => r.seam.length));
    console.log(
        `\n  ${'seam'.padEnd(w)}  what it holds  what it observed\n  ${'-'.repeat(w)}  -------------  ----------------`,
    );
    for (const r of seamRows) {
        console.log(
            `  ${r.seam.padEnd(w)}  ${SEAM_LABEL[r.verdict]}    ${r.observed}`,
        );
    }
    return {
        text: seamRows.filter((r) => r.verdict === 'SEES_TEXT').length,
        parsed: seamRows.filter((r) => r.verdict === 'SEES_PARSED').length,
        absent: seamRows.filter((r) => r.verdict === 'ABSENT').length,
    };
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring a FAILURE of the library (C1's silence, C2's blind seams),
 * so the verdict statement always carries the direction.
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
