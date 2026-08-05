// C7 — is the finding ACTIONABLE at 3am: field path, expected, actual? And which of the six
// accessors carries it?
//
// Scenario 11 measured that `.safe()` gets a generic message while `.report().findings` has the
// detail. That generalises here, and the shape of the answer is a table with a hole in it:
//
//   await / .safe()   — NOTHING on a soft finding, and a GENERIC message on a hard one
//   hooks.onResponse  — runs before validation; no finding exists yet
//   .stream()         — every finding, same run, one request     ← the cheap live accessor
//   trace sink        — every finding, same run, zero cost       ← the one that also aggregates
//   .inspect()        — findings + raw + validated, FRESH PROBE  ← the only one with both VALUES
//   .report()         — the above plus attempts/timing/config, FRESH PROBE
//
// "Expected vs actual" is only half-carried. A HARD finding has both (`Expected number, received
// string`) because the message comes from Zod. A SOFT finding has neither: `detail` is
// `kindOf(old) -> kindOf(new)` (drift.ts:77-83), which is types, not values.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c7-accessors.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

const Charge = z.object({
    transaction_id: z.coerce.number().catch(0),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
});
const Strict = z.object({
    transaction_id: z.number(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
});

/** The drifting response every accessor in this file is pointed at: `"abc"` becomes `0`. */
const DRIFTED = {
    transaction_id: 'abc',
    amount: 4200,
    currency: 'usd',
    status: 'succeeded',
    settlement_delay_ms: 900,
};

async function main(): Promise<void> {
    heading('C7 — which accessor carries the finding');

    // ── (a) await / `.safe()` on a SOFT finding: nothing at all ──────────────────────────────
    {
        let wire = 0;
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: async () => {
                wire += 1;
                return { status: 200, headers: {}, body: DRIFTED };
            },
            output: drift(Charge),
        });
        const r = await call.safe();
        checkSeq('(a) `SafeResult` keys', Object.keys(r).sort(), [
            'data',
            'error',
            'ok',
        ]);
        check('(a) ok', r.ok, true);
        check('(a) error', r.error, null);
        check(
            '(a) the value the caller holds',
            (r.data as Record<string, unknown>)['transaction_id'],
            0,
        );
        check('(a) requests made', wire, 1);
        note(
            '(a) → a $0 charge, a successful call, and NOTHING on the result object to read. The finding exists and this accessor cannot see it',
            '',
        );
    }

    // ── (b) await / `.safe()` on a HARD finding: a generic message ───────────────────────────
    // `StitchError` has `{ status, attempts, body, url }` and no `findings` (types.ts:1656-1690).
    // The field name is emitted on the event stream and then dropped on the way out.
    {
        const findings: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings.push(fmt(e.finding));
                if (e.type === 'error') findings.push(`event:${e.message}`);
            },
        };
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving(DRIFTED),
            output: drift(Strict),
            trace: sink,
        });
        const r = await call.safe();
        check(
            '(b) error message on `.safe()`',
            r.error?.message,
            'contract violation (drift)',
        );
        checkSeq(
            '(b) `StitchError` own keys',
            Object.keys(r.error ?? {}).sort(),
            ['attempts', 'body', 'name', 'status', 'url'],
        );
        check(
            '(b) is `findings` on the error?',
            'findings' in (r.error ?? {}),
            false,
        );
        checkSeq('(b) what the SINK saw for the same run', findings, [
            'error|invalid|transaction_id|Expected number, received string',
            'event:contract violation (drift)',
        ]);
        note(
            '(b) → the sink names the field and both types. `.safe()` gets four words. Same run, same instant',
            '',
        );
    }

    // ── (c) `.stream()`: the same run, every finding, one request ────────────────────────────
    // The cheapest live accessor. You reassemble the result from the `result` event.
    {
        let wire = 0;
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: async () => {
                wire += 1;
                return { status: 200, headers: {}, body: DRIFTED };
            },
            output: drift(Charge),
        });
        const types: string[] = [];
        const seen: string[] = [];
        let value: unknown;
        for await (const e of call.stream()) {
            types.push(e.type);
            if (e.type === 'drift') seen.push(fmt(e.finding));
            if (e.type === 'result')
                value = (e.data as Record<string, unknown>)['transaction_id'];
        }
        checkSeq('(c) event spine', types, [
            'start',
            'progress',
            'drift',
            'drift',
            'result',
            'done',
        ]);
        checkSeq('(c) findings', seen.sort(), [
            'info|undeclared|settlement_delay_ms|undeclared field (number)',
            'warn|coerced|transaction_id|string -> number',
        ]);
        check('(c) the validated value, off the `result` event', value, 0);
        check('(c) requests made', wire, 1);
        note(
            '(c) → findings AND the value, one request, same run. What `.stream()` does not carry is the RAW body, so you still cannot see that the string was `"abc"`',
            '',
        );
    }

    // ── (d) `.inspect()`: the only accessor with raw AND validated in one object ─────────────
    // …and it is a FRESH probe. Two requests: the one you made, and the one the probe makes.
    {
        let wire = 0;
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: async () => {
                wire += 1;
                return { status: 200, headers: {}, body: DRIFTED };
            },
            output: drift(Charge),
        });
        await call.safe();
        const ins = await call.inspect();
        checkSeq('(d) `Inspection` keys', Object.keys(ins).sort(), [
            'data',
            'error',
            'findings',
            'source',
            'status',
        ]);
        checkSeq('(d) findings', ins.findings.map(fmt).sort(), [
            'info|undeclared|settlement_delay_ms|undeclared field (number)',
            'warn|coerced|transaction_id|string -> number',
        ]);
        check(
            '(d) RAW value the vendor sent',
            (ins.raw as Record<string, unknown>)['transaction_id'],
            'abc',
        );
        check(
            '(d) VALIDATED value the caller gets',
            (ins.data as Record<string, unknown>)['transaction_id'],
            0,
        );
        check('(d) requests made for both', wire, 2);
        note(
            '(d) → `"abc"` → `0`, both halves visible, which is the ONLY place the $0 charge is diagnosable from one object. It cost a second request and it is a different response than the one that hurt you',
            '',
        );
    }

    // ── (e) `.report()`: `.inspect()` plus run diagnostics, still a fresh probe ──────────────
    {
        const vendorSeries = [
            DRIFTED,
            {
                transaction_id: 100002,
                amount: 4200,
                currency: 'usd',
                status: 'succeeded',
            },
        ];
        let i = 0;
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: async () => ({
                status: 200,
                headers: {},
                body: venderAt(vendorSeries, i++),
            }),
            output: drift(Charge),
        });
        const first = await call.safe();
        check(
            '(e) the call that drifted',
            (first.data as Record<string, unknown>)['transaction_id'],
            0,
        );
        const rep = await call.report();
        checkSeq('(e) `RunReport` keys', Object.keys(rep).sort(), [
            'attempts',
            'cache',
            'config',
            'data',
            'error',
            'findings',
            'source',
            'status',
            'timing',
        ]);
        checkSeq('(e) findings the report saw', rep.findings.map(fmt), []);
        note(
            '(e) → the drifting call is over; the probe hit a clean response and reported ZERO findings. `.report()` answers "how is this endpoint right now", never "what happened on the call I just made"',
            '',
        );
    }

    // ── (f) expected/actual: carried on hard findings, absent on soft ones ───────────────────
    {
        const hard: string[] = [];
        const soft: string[] = [];
        const capture = (into: string[]): TraceSink => ({
            handle(e: StitchEvent) {
                if (e.type === 'drift') into.push(e.finding.detail ?? '<none>');
            },
        });
        await stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving(DRIFTED),
            output: drift(Strict),
            trace: capture(hard),
        }).safe();
        await stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving(DRIFTED),
            output: drift(Charge),
            trace: capture(soft),
        }).safe();

        checkSeq('(f) HARD finding detail', hard, [
            'Expected number, received string',
        ]);
        checkSeq('(f) SOFT finding details', soft.sort(), [
            'string -> number',
            'undeclared field (number)',
        ]);
        note(
            "(f) → the hard detail is Zod's message and carries expected+actual TYPES. The soft detail is `kindOf(old) -> kindOf(new)` (drift.ts:77-83). Neither carries a VALUE, on any accessor except `.inspect().raw`",
            '',
        );
    }

    // ── (g) the array case does carry a coordinate ───────────────────────────────────────────
    // `sample` (ADR 0017, drift.ts:191-197) gives the concrete index of the first occurrence, so a
    // per-element finding stays recoverable from the raw body.
    {
        const found: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift')
                    found.push(
                        `${fmt(e.finding)} sample=${e.finding.sample ?? '<none>'}`,
                    );
            },
        };
        const call = stitch({
            url: 'https://pay.example/charges',
            adapter: serving({
                charges: [
                    { transaction_id: 1 },
                    { transaction_id: 2 },
                    { transaction_id: 'abc' },
                    { transaction_id: null },
                ],
            }),
            output: drift(
                z.object({
                    charges: z.array(
                        z.object({
                            transaction_id: z.coerce.number().catch(0),
                        }),
                    ),
                }),
            ),
            trace: sink,
        });
        await call.safe();
        checkSeq('(g) heterogeneous array findings', found.sort(), [
            'warn|coerced|charges[].transaction_id|1 element: null -> number sample=charges[3].transaction_id',
            'warn|coerced|charges[].transaction_id|1 element: string -> number sample=charges[2].transaction_id',
        ]);
        note(
            '(g) → two distinct detail variants, each with its own count and a CONCRETE index. This is the most actionable finding shape in the library',
            '',
        );
    }

    finish(
        'C7',
        'PARTLY ACTIONABLE, AND IT DEPENDS ENTIRELY ON THE ACCESSOR. The FIELD PATH is always carried, on every accessor that carries a finding at all, including the array case where `sample=charges[2].transaction_id` gives a concrete index. EXPECTED/ACTUAL is only half there: a HARD finding carries both types (`Expected number, received string`, Zod\'s message), a SOFT one carries `kindOf(old) -> kindOf(new)` and no values. The accessor table: `await`/`.safe()` carries NOTHING for a soft finding (`{ok,data,error}` and a $0 value) and a generic `contract violation (drift)` for a hard one — `StitchError` has no `findings` — while the trace sink for the SAME run named the field and both types; `hooks.onResponse` runs before validation; `.stream()` gets every finding plus the validated value in ONE request; `.inspect()` is the only accessor with RAW (`"abc"`) and VALIDATED (`0`) in one object, and `.report()` adds the run diagnostics — but both are FRESH PROBES: `.report()` on the drifting stitch reported ZERO findings because the probe hit a clean response',
    );
}

/** Index into a fixed response series, clamping to the last element. */
function venderAt<T>(series: T[], i: number): T {
    return series[Math.min(i, series.length - 1)] as T;
}

void main();
