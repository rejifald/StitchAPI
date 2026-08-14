// Minimal assertion harness for the proof scripts: every check prints a line, and the script
// exits non-zero if any check failed. No test framework — these are standalone `tsx` scripts.
//
// This scenario's evidence is of two kinds, and each gets its own assertion:
//
//   1. WHAT THE MODEL RECEIVED. Every JSON-RPC response payload is a string, and the question is
//      whether a credential VALUE appears anywhere in it. `checkClean` scans one payload against
//      the whole secret set and prints the byte count it scanned, so "the model got 3,410 bytes
//      and none of them were the token" is a measurement rather than an assurance. Its inverse,
//      `checkDiscloses`, asserts a substring IS present — `describe_stitch` handing the model the
//      internal URL is a real disclosure and has to be recorded as loudly as a clean scan.
//   2. WHAT REACHED THE WIRE. `checkWire` prints a request field the fake adapter recorded, so
//      "the `authorization` header the vendor saw was `Bearer <bearer>`, not the model's
//      `Bearer attacker`" is a wire observation and not a paraphrase.
//
// `check` / `checkSeq` / `note` / `heading` / `finish` follow `deprecation-headers/harness.ts`
// with one addition: every printed line passes through `redact` first. Assertions compare the
// raw bytes, but stdout only ever sees `<label>` where a credential value would be — the same
// rule `checkClean` already applies to leak context, promoted to every printer, because a proof
// script's output ends up in terminal scrollback and PR comments (CodeQL js/clear-text-logging).
import { SECRETS } from './vendor';

let failures = 0;
let checks = 0;

/** Swap each known secret VALUE for its `<label>` in anything headed for stdout. */
function redact(line: string): string {
    let out = line;
    for (const [label, value] of Object.entries(SECRETS))
        out = out.replaceAll(value, `<${label}>`);
    return out;
}

function print(line: string): void {
    console.log(redact(line));
}

/** Render a measured value unambiguously — `undefined` vs `'undefined'` decides several rows. */
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
    print(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${show(actual)}${ok ? '' : ` (expected ${show(expected)})`}`,
    );
}

/**
 * Assert a measured SEQUENCE matches, comparing element-wise via `JSON.stringify`. The measured
 * sequence is printed in full whether it passes or fails — the wire spine
 * (`["Bearer <bearer>","Bearer <bearer>"]`) and the tool list (`["run_stitch","list_stitches",
 * "describe_stitch"]`) ARE the evidence.
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
    print(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${a}${ok ? '' : ` (expected ${e})`}`,
    );
}

/**
 * THE assertion of C1: does this JSON-RPC payload contain a credential VALUE?
 *
 * `payload` is the exact string a real MCP client would read off the transport (the response
 * serialised with `JSON.stringify`, which is what `serveStdio` writes). Every secret in `secrets`
 * is searched for by value; the line reports the byte count scanned so a clean result is a
 * measurement of something rather than the absence of a test.
 *
 * A leak prints the secret's LABEL and the 60 bytes of context around it — never the secret
 * itself, because a proof script's output ends up in a terminal scrollback and a PR comment.
 */
export function checkClean(
    where: string,
    payload: string,
    secrets: Readonly<Record<string, string>>,
): void {
    checks++;
    const hits = Object.entries(secrets).filter(([, value]) =>
        payload.includes(value),
    );
    if (hits.length > 0) failures++;
    if (hits.length === 0) {
        print(
            `  ok    ${where.padEnd(34)} -> CLEAN (${String(Object.keys(secrets).length)} secrets scanned, ${String(payload.length)} bytes)`,
        );
        return;
    }
    const first = hits[0] as [string, string];
    const at = payload.indexOf(first[1]);
    const context = payload
        .slice(Math.max(0, at - 30), at + first[1].length + 30)
        .replaceAll(first[1], `<${first[0]}>`);
    print(
        `  FAIL  ${where.padEnd(34)} -> LEAKED ${hits.map(([k]) => k).join(', ')} in ${String(payload.length)} bytes … ${context} …`,
    );
}

/**
 * The inverse of {@link checkClean}: assert the payload DOES contain a substring. Used where a
 * disclosure is real and must be recorded — `describe_stitch` hands the model the internal
 * endpoint URL and the auth scheme by design, and "by design" is not the same as "not disclosed".
 */
export function checkDiscloses(
    where: string,
    payload: string,
    needle: string,
): void {
    checks++;
    const ok = payload.includes(needle);
    if (!ok) failures++;
    print(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${where.padEnd(34)} -> ${ok ? 'DISCLOSES' : 'absent'} ${show(needle)}`,
    );
}

/**
 * Assert on a field of a request the fake adapter recorded. Separate from `check` only so the
 * output reads as a wire observation — `wire[0].headers.authorization` on the left, what the
 * vendor saw (secrets redacted to their labels) on the right.
 */
export function checkWire(
    field: string,
    actual: unknown,
    expected: unknown,
): void {
    checks++;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    print(
        `  ${ok ? 'ok  ' : 'FAIL'}  wire ${field.padEnd(29)} = ${show(actual)}${ok ? '' : ` (expected ${show(expected)})`}`,
    );
}

/** Assert a measured number is at most `bound` — the request-count ceilings in C5. */
export function checkAtMost(
    label: string,
    actual: number,
    bound: number,
): void {
    checks++;
    const ok = actual <= bound;
    if (!ok) failures++;
    print(
        `  ${ok ? 'ok  ' : 'FAIL'}  ${label}: measured ${String(actual)}${ok ? ` (<= ${String(bound)})` : ` (expected <= ${String(bound)})`}`,
    );
}

/** Record a measurement that is reported but not asserted (context for the verdict). */
export function note(label: string, value: unknown = ''): void {
    const v = value === '' ? '' : `: ${show(value)}`;
    print(`  note  ${label}${v}`);
}

export function heading(text: string): void {
    print(`\n${text}`);
}

/**
 * Print the claim's verdict line and exit. `claim` is e.g. `'C1'`; `statement` is what a PASS
 * means, so the printed line is self-describing when someone reads it out of context.
 *
 * Several claims here PASS by measuring an ABSENCE (C1's clean scans) and several by measuring a
 * disclosure that is real (C3's config read-out), so the verdict statement always carries the
 * direction.
 */
export function finish(claim: string, statement: string): never {
    const pass = failures === 0;
    print(
        `\n${pass ? 'PASS' : 'FAIL'} ${claim} — ${statement} (${checks - failures}/${checks} checks)`,
    );
    process.exit(pass ? 0 : 1);
    // `process.exit` is typed `never`, but TypeScript still wants the end point unreachable.
    throw new Error('unreachable');
}
