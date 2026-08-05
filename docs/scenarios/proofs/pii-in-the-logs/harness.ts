// Assertion + measurement harness for the `pii-in-the-logs` proofs. Every check prints a line and
// the script exits non-zero if any check failed. No test framework — these are standalone `tsx`
// scripts, exactly like the other proof directories.
//
// What this directory needs that the others did not: a SENTINEL SCANNER. Every claim here reduces
// to one question — "did this exact string reach that destination?" — so the primitive is not a
// value comparison but a substring scan of a destination's SERIALIZED BYTES, per sentinel, with the
// byte count reported alongside. `leakRow` records one destination; `printLeakTable` prints the
// destination × sentinel matrix that C1 exists to produce.
//
// The scan is deliberately dumb (`String.includes`). A cleverer matcher would let the harness
// decide what counts as a leak; a substring scan of the bytes a sink actually wrote cannot.

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
 * sequence prints in full whether it passes or fails — an event spine IS the evidence for several
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

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown = ''): void {
    const v = value === '' ? '' : `: ${show(value)}`;
    console.log(`  note  ${label}${v}`);
}

export function heading(text: string): void {
    console.log(`\n${text}`);
}

// ---- the sentinel scanner --------------------------------------------------
// A sentinel is a literal string planted in the canary payload. A destination is anything that can
// be reduced to bytes: a JSONL line, a captured stderr write, a logger message, `JSON.stringify` of
// a wrapper, the bytes a store was handed. `scan` answers, for one destination, which sentinels are
// present in it.

/** One sentinel: a short column code, the literal planted value, and where it sits in the body. */
export interface Sentinel {
    /** Fixed-width column code for the leak table (kept to 3 chars so the matrix fits 100 cols). */
    code: string;
    /** The literal string planted in the canary payload — what `scan` looks for. */
    value: string;
    /** Where it lives in the response body, for the legend. */
    at: string;
}

/** Which of `sentinels` appear literally in `text`. */
export function scan(
    text: string,
    sentinels: readonly Sentinel[],
): Set<string> {
    const hits = new Set<string>();
    for (const s of sentinels) if (text.includes(s.value)) hits.add(s.code);
    return hits;
}

export interface LeakRow {
    dest: string;
    bytes: number;
    hits: Set<string>;
    /** Printed under the table — how this destination's bytes were obtained. */
    how: string;
}

const leakRows: LeakRow[] = [];

/**
 * Record one destination's serialized bytes against the sentinel set. Returns the row so a caller
 * can assert on `hits.size` / `hits.has(code)` immediately.
 *
 * `text` must be the bytes the destination ACTUALLY holds or wrote — a file's contents, a captured
 * stderr buffer, `JSON.stringify` of the object a consumer would log. Passing a hand-built summary
 * would make the table a restatement of the author's belief instead of a measurement.
 */
export function leakRow(
    dest: string,
    text: string,
    sentinels: readonly Sentinel[],
    how = '',
): LeakRow {
    const row: LeakRow = {
        dest,
        bytes: Buffer.byteLength(text, 'utf8'),
        hits: scan(text, sentinels),
        how,
    };
    leakRows.push(row);
    return row;
}

/** Print the accumulated destination × sentinel matrix plus a per-sentinel tally. */
export function printLeakTable(sentinels: readonly Sentinel[]): {
    leaking: number;
    clean: number;
} {
    const w = Math.max(...leakRows.map((r) => r.dest.length), 11);
    const codes = sentinels.map((s) => s.code);
    const head = codes.map((c) => c.padStart(3)).join(' ');
    const rule = codes.map(() => '---').join(' ');
    console.log(
        `\n  ${'destination'.padEnd(w)}  ${'bytes'.padStart(7)}  ${head}\n` +
            `  ${'-'.repeat(w)}  ${'-'.repeat(7)}  ${rule}`,
    );
    for (const r of leakRows) {
        const cells = codes
            .map((c) => (r.hits.has(c) ? ' ●●' : '  ·').padStart(3))
            .join(' ');
        console.log(
            `  ${r.dest.padEnd(w)}  ${String(r.bytes).padStart(7)}  ${cells}`,
        );
    }
    console.log(`\n  ●● = the literal sentinel is present in this destination's bytes
  ·  = absent

  legend:`);
    for (const s of sentinels)
        console.log(
            `    ${s.code.padStart(3)}  ${s.at.padEnd(28)} ${JSON.stringify(s.value)}`,
        );
    const leaking = leakRows.filter((r) => r.hits.size > 0).length;
    return { leaking, clean: leakRows.length - leaking };
}

/** Reset the accumulated table (a script that builds more than one matrix). */
export function resetLeakTable(): void {
    leakRows.length = 0;
}

/** The rows collected so far — for a script that wants to assert over the whole matrix. */
export function rows(): readonly LeakRow[] {
    return leakRows;
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring a LEAK. The verdict statement always carries the direction.
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
