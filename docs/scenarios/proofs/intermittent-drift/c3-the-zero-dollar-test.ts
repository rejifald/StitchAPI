// C3 — THE DECIDING CLAIM. `transaction_id` stops being a number.
//
// The capture's fear: "if `"abc"` becomes `NaN` or `0` at info level, that is the $0 transaction
// with a warning nobody reads." Half of that is refuted and half of it is worse than written.
//
// REFUTED: the default posture is SAFE. A plain `z.number()` receiving `"12345"` is a HARD failure
// — `error|invalid`, the call throws, `data` is `null`. And even `z.coerce.number()` receiving
// `"abc"` is a hard failure, because `Number("abc")` is `NaN` and Zod rejects `NaN` as a number.
// The library does not manufacture a $0 charge out of `"abc"` on its own.
//
// WORSE: there are two ordinary schema spellings that DO, and the finding they produce is
// BYTE-IDENTICAL to the finding for the correct coercion. `warn|coerced|transaction_id|
// string -> number` is what you get when `"12345"` became `12345`, and it is exactly what you get
// when `"abc"` became `0`. The `detail` carries KINDS, not VALUES (drift.ts:77-83). And the
// nullable case reaches `0` with no `.catch()` at all, because `Number(null) === 0`.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c3-the-zero-dollar-test.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

/** What the caller ends up holding, plus everything the library said about it. */
interface Received {
    ok: boolean;
    /** The value of `transaction_id` ON THE AWAITED PATH. The number this whole scenario is about. */
    value: unknown;
    findings: string[];
    message: string | null;
}

async function receive(schema: unknown, wire: unknown): Promise<Received> {
    const findings: string[] = [];
    const sink: TraceSink = {
        handle(e: StitchEvent) {
            if (e.type === 'drift') findings.push(fmt(e.finding));
        },
    };
    const call = stitch({
        url: 'https://pay.example/charges/1',
        adapter: serving({
            transaction_id: wire,
            amount: 4200,
            currency: 'usd',
            status: 'succeeded',
        }),
        output: drift(schema as never),
        trace: sink,
    });
    const r = await call.safe();
    const data = r.data as Record<string, unknown> | null;
    return {
        ok: r.ok,
        value: data === null ? null : data['transaction_id'],
        findings,
        message: r.error?.message ?? null,
    };
}

const rest = {
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
};
const STRICT = z.object({ transaction_id: z.number(), ...rest });
const COERCE = z.object({ transaction_id: z.coerce.number(), ...rest });
const COERCE_CATCH = z.object({
    transaction_id: z.coerce.number().catch(0),
    ...rest,
});

async function main(): Promise<void> {
    heading('C3 — the $0-transaction test');

    // ── (a) number → string, strict schema. THE DEFAULT, AND IT IS SAFE ──────────────────────
    {
        const r = await receive(STRICT, '12345');
        check('(a) the call FAILED', r.ok, false);
        check('(a) value the caller received', r.value, null);
        checkSeq('(a) findings', r.findings, [
            'error|invalid|transaction_id|Invalid input: expected number, received string',
        ]);
        note(
            '(a) → a plain `z.number()` makes a type change FATAL with the field named and the two types named. No coercion, no $0 charge',
            '',
        );
    }

    // ── (b) number → string, coercing schema, PLAUSIBLE value. Correct and warned ────────────
    {
        const r = await receive(COERCE, '12345');
        check('(b) the call SUCCEEDED', r.ok, true);
        check('(b) value the caller received', r.value, 12345);
        check('(b) …and it is a number', typeof r.value, 'number');
        checkSeq('(b) findings', r.findings, [
            'warn|coerced|transaction_id|string -> number',
        ]);
        note(
            '(b) → the RIGHT answer: the correct value, and a `warn` saying the wire type moved. This is what `coerced` is for',
            '',
        );
    }

    // ── (c) number → string, coercing schema, NON-NUMERIC value. Also safe ───────────────────
    // The capture's worst case, and it does not happen: `Number("abc")` is `NaN`, and Zod's
    // `z.number()` rejects `NaN`. The coercion fails closed.
    {
        const r = await receive(COERCE, 'abc');
        check('(c) the call FAILED', r.ok, false);
        check('(c) value the caller received', r.value, null);
        checkSeq('(c) findings', r.findings, [
            'error|invalid|transaction_id|Invalid input: expected number, received NaN',
        ]);
        note(
            '(c) → REFUTES the capture: `z.coerce.number()` on `"abc"` does NOT silently become NaN or 0. It is an `error` and the call fails',
            '',
        );
    }

    // ── (d) THE $0 TRANSACTION, ROUTE 1: `.catch(0)` ─────────────────────────────────────────
    // `.catch()` is the ordinary Zod spelling for "this vendor is loose, don't fail my call".
    // It turns (c)'s hard failure into a zero, at `warn`.
    {
        const r = await receive(COERCE_CATCH, 'abc');
        check('(d) the call SUCCEEDED', r.ok, true);
        check('(d) VALUE THE CALLER RECEIVED', r.value, 0);
        check(
            '(d) …and it is a number, so nothing downstream blinks',
            typeof r.value,
            'number',
        );
        checkSeq('(d) findings', r.findings, [
            'warn|coerced|transaction_id|string -> number',
        ]);
    }

    // ── (e) …and (b) and (d) are INDISTINGUISHABLE from the finding ─────────────────────────
    // This is the actual finding of C3. Same level, same kind, same path, same detail. One is
    // correct, one is a $0 charge, and the drift system reports them with the same 42 bytes.
    {
        const good = await receive(COERCE_CATCH, '12345');
        const bad = await receive(COERCE_CATCH, 'abc');
        check(
            '(e) the two findings are byte-identical',
            JSON.stringify(good.findings) === JSON.stringify(bad.findings),
            true,
        );
        checkSeq('(e) the finding both produce', good.findings, [
            'warn|coerced|transaction_id|string -> number',
        ]);
        checkSeq(
            '(e) the values behind it',
            [good.value, bad.value],
            [12345, 0],
        );
        note(
            '(e) → `detail` is `kindOf(old) -> kindOf(new)` (drift.ts:77-83). The values are never in the finding, so no alert built on findings can separate these two',
            '',
        );
    }

    // ── (f) THE $0 TRANSACTION, ROUTE 2: `null`, and no `.catch()` needed ────────────────────
    // `Number(null) === 0`. A vendor that starts sending `null` for `transaction_id` on the data
    // that triggers it lands a hard zero in a plain `z.coerce.number()` schema.
    {
        const r = await receive(COERCE, null);
        check('(f) the call SUCCEEDED', r.ok, true);
        check('(f) VALUE THE CALLER RECEIVED', r.value, 0);
        checkSeq('(f) findings', r.findings, [
            'warn|coerced|transaction_id|null -> number',
        ]);
        note(
            '(f) → no `.catch()`, no garbage string, no error. Just `null` and `z.coerce.number()`. This is C4 and C3 being the same bug',
            '',
        );
    }

    // ── (g) every wire value `z.coerce.number()` turns into exactly 0 ────────────────────────
    // Six of them, and only two reject. Any of these six on a money field is a $0 charge at
    // `warn`, or — for `0` and `"0"` — no finding at all.
    {
        const rows: string[] = [];
        for (const wire of [null, '', '  ', false, [], '0', 'abc', 12345]) {
            const parsed = z.coerce.number().safeParse(wire);
            rows.push(
                `${JSON.stringify(wire)} → ${parsed.success ? JSON.stringify(parsed.data) : 'REJECTED'}`,
            );
        }
        checkSeq('(g) `z.coerce.number()` over eight wire values', rows, [
            'null → 0',
            '"" → 0',
            '"  " → 0',
            'false → 0',
            '[] → 0',
            '"0" → 0',
            '"abc" → REJECTED',
            '12345 → 12345',
        ]);
        note(
            '(g) → six wire values become exactly `0`. Only `"abc"` (and `undefined`) reject. `"0"` and `0` produce no finding at all — they are not a coercion',
            '',
        );
    }

    // ── (h) the OTHER direction: number → string ─────────────────────────────────────────────
    // Symmetric, and the coercion is total (every number has a string form), so it never fails.
    {
        const NUM_TO_STR = z.object({ transaction_id: z.string(), ...rest });
        const strict = await receive(NUM_TO_STR, 12345);
        check('(h) `z.string()` on a number: call FAILED', strict.ok, false);
        checkSeq('(h) findings', strict.findings, [
            'error|invalid|transaction_id|Invalid input: expected string, received number',
        ]);

        const COERCE_STR = z.object({
            transaction_id: z.coerce.string(),
            ...rest,
        });
        const coerced = await receive(COERCE_STR, 12345);
        check('(h) `z.coerce.string()`: call SUCCEEDED', coerced.ok, true);
        check('(h) VALUE THE CALLER RECEIVED', coerced.value, '12345');
        checkSeq('(h) findings', coerced.findings, [
            'warn|coerced|transaction_id|number -> string',
        ]);
        note(
            '(h) → `warn`, correct value, and now every `===` against a numeric id in your code is false. A string id is not a $0 charge, it is a lookup miss',
            '',
        );
    }

    // ── (i) the TOLERANT schema: total blindness ─────────────────────────────────────────────
    // `z.union([number, string])` and `z.unknown()` accept both shapes, so raw === validated,
    // so `diff` produces nothing. The schema written specifically to survive the drift is the one
    // that makes the drift undetectable.
    {
        const UNION = z.object({
            transaction_id: z.union([z.number(), z.string()]),
            ...rest,
        });
        const u = await receive(UNION, '12345');
        check('(i) union: call SUCCEEDED', u.ok, true);
        check('(i) VALUE THE CALLER RECEIVED', u.value, '12345');
        checkSeq('(i) findings', u.findings, []);

        const UNKNOWN = z.object({ transaction_id: z.unknown(), ...rest });
        const k = await receive(UNKNOWN, 'abc');
        check('(i) z.unknown(): call SUCCEEDED', k.ok, true);
        check('(i) VALUE THE CALLER RECEIVED', k.value, 'abc');
        checkSeq('(i) findings', k.findings, []);
        note(
            '(i) → drift is a diff against the validated value. A schema that accepts both shapes has nothing to diff, so a tolerant schema is a SILENT one',
            '',
        );
    }

    // ── (j) what the DOWNSTREAM cast does with each of them ──────────────────────────────────
    // The library hands you a value; the $0 charge happens one line later. This is what
    // `Number(x)` and `Number(x) || 0` — the two lines every integration has — do with what the
    // caller actually received in (a)-(i).
    {
        const cases: [string, unknown][] = [
            ['coerce+catch "abc" (d)', 0],
            ['coerce null (f)', 0],
            ['union "12345" (i)', '12345'],
            ['unknown "abc" (i)', 'abc'],
            ['coerce.string 12345 (h)', '12345'],
        ];
        const rows = cases.map(
            ([label, v]) =>
                `${label}: Number()=${String(Number(v))} Number()||0=${String(Number(v) || 0)} ===12345 is ${String(v === 12345)}`,
        );
        checkSeq('(j) the downstream cast', rows, [
            'coerce+catch "abc" (d): Number()=0 Number()||0=0 ===12345 is false',
            'coerce null (f): Number()=0 Number()||0=0 ===12345 is false',
            'union "12345" (i): Number()=12345 Number()||0=12345 ===12345 is false',
            'unknown "abc" (i): Number()=NaN Number()||0=0 ===12345 is false',
            'coerce.string 12345 (h): Number()=12345 Number()||0=12345 ===12345 is false',
        ]);
        note(
            '(j) → three separate routes to a literal 0, and every single row fails a `=== 12345` identity check. The silent ones (i) are the ones with no finding at all',
            '',
        );
    }

    finish(
        'C3',
        'THE CAPTURE IS HALF WRONG AND THE OTHER HALF IS WORSE. Refuted: the default is SAFE. `z.number()` on `"12345"` is `error|invalid|transaction_id|Invalid input: expected number, received string` and the call FAILS with `data: null`; `z.coerce.number()` on `"abc"` also FAILS (`received NaN`) because Zod rejects NaN. StitchAPI does not manufacture a $0 charge on its own. Confirmed and worse: TWO ordinary spellings do. `z.coerce.number().catch(0)` on `"abc"` hands the caller literal `0` at `warn`, and `z.coerce.number()` on `null` hands the caller literal `0` at `warn` with NO `.catch()` at all, because `Number(null) === 0` — six wire values (`null`, `""`, `"  "`, `false`, `[]`, `"0"`) coerce to exactly 0 and only `"abc"` rejects. And the finding for `"12345" -> 12345` is BYTE-IDENTICAL to the finding for `"abc" -> 0`: both are `warn|coerced|transaction_id|string -> number`, because `detail` is `kindOf(old) -> kindOf(new)` (drift.ts:77-83) and the VALUES are never in the finding. The tolerant schemas people write to survive drift — `z.union([number,string])`, `z.unknown()` — pass the raw string through with ZERO findings',
    );
}

void main();
