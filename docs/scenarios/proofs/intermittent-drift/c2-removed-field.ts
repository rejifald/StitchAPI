// C2 — the vendor REMOVES a field. Breaking by every published policy, and the capture's question
// is whether it is distinguishable IN LEVEL from C1's addition.
//
// It is — by three levels and by a different `change` kind. But the distinction is NOT a property
// of the removal: it is a property of HOW YOU DECLARED THE FIELD. The same missing key produces
// `error` (call fails), `verbose`, or NOTHING AT ALL depending on one word in your schema. That is
// the finding of this file, and it is the mirror image of C1: an addition is classified by the
// vendor's behaviour, a removal is classified by yours.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c2-removed-field.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

/** The response after the vendor dropped `currency`. */
const WITHOUT_CURRENCY = {
    transaction_id: 100001,
    amount: 4200,
    status: 'succeeded',
};

interface Outcome {
    ok: boolean;
    message: string | null;
    findings: string[];
    data: unknown;
}

/** Run the removed-field body against one schema shape and reduce it to a comparable outcome. */
async function against(schema: unknown): Promise<Outcome> {
    const findings: string[] = [];
    const sink: TraceSink = {
        handle(e: StitchEvent) {
            if (e.type === 'drift') findings.push(fmt(e.finding));
        },
    };
    const call = stitch({
        url: 'https://pay.example/charges/1',
        adapter: serving(WITHOUT_CURRENCY),
        output: drift(schema as never),
        trace: sink,
    });
    const r = await call.safe();
    return {
        ok: r.ok,
        message: r.error?.message ?? null,
        findings,
        data: r.data,
    };
}

async function main(): Promise<void> {
    heading('C2 — a field the vendor REMOVED');

    // ── (a) required in the schema → hard `error`, the call FAILS ────────────────────────────
    {
        const o = await against(
            z.object({
                transaction_id: z.number(),
                amount: z.number(),
                currency: z.string(),
                status: z.string(),
            }),
        );
        check('(a) the call FAILED', o.ok, false);
        check('(a) error message', o.message, 'contract violation (drift)');
        check('(a) data the caller got', o.data, null);
        checkSeq('(a) findings', o.findings, [
            'error|invalid|currency|Invalid input: expected string, received undefined',
        ]);
        note(
            "(a) → `error` vs C1's `info`, `invalid` vs `undeclared`. Distinguishable in level AND in kind",
            '',
        );
    }

    // ── (b) optional in the schema → COMPLETE SILENCE ────────────────────────────────────────
    // `drift()` diffs raw against validated. An absent optional is absent in BOTH, so there is no
    // diff, so there is nothing to classify. This is the case that bites: the field you marked
    // optional two years ago because it was "sometimes missing" is now permanently gone, and the
    // library's most-advertised feature is structurally unable to say so.
    {
        const o = await against(
            z.object({
                transaction_id: z.number(),
                amount: z.number(),
                currency: z.string().optional(),
                status: z.string(),
            }),
        );
        check('(b) the call SUCCEEDED', o.ok, true);
        checkSeq('(b) findings', o.findings, []);
        check(
            '(b) `currency` on the value the caller got',
            (o.data as Record<string, unknown>)['currency'],
            undefined,
        );
        note(
            '(b) → zero findings, zero levels, a successful call. An OPTIONAL field can be removed by the vendor and NOTHING in the drift system fires',
            '',
        );
    }

    // ── (c) `.default()` in the schema → `verbose|defaulted`, and a fabricated value ─────────
    // The third outcome. The caller receives a `currency` the vendor did not send, and the only
    // trace is the QUIETEST level in the vocabulary — dropped entirely by `severity: 'warn'`.
    {
        const o = await against(
            z.object({
                transaction_id: z.number(),
                amount: z.number(),
                currency: z.string().default('usd'),
                status: z.string(),
            }),
        );
        check('(c) the call SUCCEEDED', o.ok, true);
        checkSeq('(c) findings', o.findings, [
            'verbose|defaulted|currency|default applied',
        ]);
        check(
            '(c) …and the caller received a currency the vendor never sent',
            (o.data as Record<string, unknown>)['currency'],
            'usd',
        );
        note(
            '(c) → for a MONEY field this is the same class of bug as C3: a plausible value manufactured at the boundary, logged at `verbose`',
            '',
        );
    }

    // ── (d) nullable in the schema → also silent, and for a different reason ─────────────────
    // `.nullable()` covers a null VALUE, not an absent KEY, so a removal still hits the required
    // check. Included because "make it nullable" is the reflex fix for C4 and it does not
    // interact with removal at all.
    {
        const o = await against(
            z.object({
                transaction_id: z.number(),
                amount: z.number(),
                currency: z.string().nullable(),
                status: z.string(),
            }),
        );
        check('(d) the call FAILED (nullable ≠ optional)', o.ok, false);
        checkSeq('(d) findings', o.findings, [
            'error|invalid|currency|Invalid input: expected string, received undefined',
        ]);
    }

    // ── (e) the three outcomes side by side ──────────────────────────────────────────────────
    // One vendor change, one wire body, four schemas, four different answers.
    {
        const rows: string[] = [];
        for (const [label, currency] of [
            ['required ', z.string()],
            ['optional ', z.string().optional()],
            ['default()', z.string().default('usd')],
            ['nullable ', z.string().nullable()],
        ] as const) {
            const o = await against(
                z.object({
                    transaction_id: z.number(),
                    amount: z.number(),
                    currency,
                    status: z.string(),
                }),
            );
            const level = o.findings[0]?.split('|')[0] ?? '<none>';
            rows.push(`${label} → ok=${o.ok} level=${level}`);
        }
        checkSeq('(e) the same removal, four declarations', rows, [
            'required  → ok=false level=error',
            'optional  → ok=true level=<none>',
            'default() → ok=true level=verbose',
            'nullable  → ok=false level=error',
        ]);
        note(
            '(e) → the LEVEL of a removal is decided by your schema, not by the vendor. "Removal is breaking" is a property you have to have already declared',
            '',
        );
    }

    finish(
        'C2',
        'CONFIRMED WITH A CONDITION. A removed field IS distinguishable from C1\'s addition — `error|invalid|currency|Invalid input: expected string, received undefined` against `info|undeclared`, three levels apart and a different `change` kind — and the call fails with `data: null`. But that is true only when the field is REQUIRED in your schema. The same wire body against `.optional()` produces a successful call and ZERO findings; against `.default("usd")` it produces `verbose|defaulted` and hands the caller a currency the vendor never sent. Four declarations, four answers, one vendor change. The removal is classified by YOUR schema, where the addition in C1 was classified by the vendor',
    );
}

void main();
