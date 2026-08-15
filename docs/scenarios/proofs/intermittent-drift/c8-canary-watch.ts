// C8 — the most honest answer for a canary rollout: quiet on additions, loud on removals and type
// changes, and a rate you can alert on. Six workloads, one configuration, priced against a
// hand-rolled equivalent.
//
// The assembled answer is TWO declarative lines plus a sink:
//
//   output: drift(StrictCharge, { severity: { undeclared: 'verbose' } }),
//   trace: new DriftRate({ clock, window: '1m', zeroWatch: ['transaction_id', 'amount'] }),
//
// The schema is STRICT on purpose. Every softening — `.catch()`, `.optional()`, `.nullable()`,
// `z.union`, `z.coerce` — was measured in C2/C3/C4 to be a way of turning a loud change into a
// quiet one or into a fabricated value. On a money field, "the call failed" is the correct answer
// to "the vendor sent something I do not understand", and `drift()` is what makes ADDITIONS not
// pay for that strictness.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c8-canary-watch.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { chargeOutput } from './canary-watch';
import { DriftRate } from './drift-rate';
import { FakeVendor, type Mutation } from './fake-vendor';
import { HandRate, type Shape, guardedCall } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Count the CODE lines between the `<count:begin>` / `<count:end>` markers of a file. */
function countedLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8').split('\n');
    const from = src.findIndex((l) => l.includes('<count:begin>'));
    const to = src.findIndex((l) => l.includes('<count:end>'));
    return src
        .slice(from + 1, to)
        .filter(
            (l) =>
                l.trim() !== '' &&
                !l.trim().startsWith('//') &&
                !l.trim().startsWith('*') &&
                !l.trim().startsWith('/*'),
        ).length;
}

/** The `DriftOptions` the soft-schema comparison in (c) reuses. */
const CANARY_DRIFT = { severity: { undeclared: 'verbose' } } as const;

/** The equivalent declaration for the hand-rolled baseline. */
const SHAPE: Shape = {
    transaction_id: { type: 'number', required: true },
    amount: { type: 'number', required: true },
    currency: { type: 'string', required: true },
    status: { type: 'string', required: true },
};

/** What the watch is asked to conclude about one workload. */
interface Verdict {
    /** Calls that reached the caller with a usable value. */
    ok: number;
    /** Calls that failed rather than hand over a value nobody can trust. */
    failed: number;
    /** The alert lines, or `[]` for silence. */
    alerts: string[];
    /** Any call where the caller was handed a literal `0` on a money field. */
    zeros: number;
}

const WORKLOADS: { label: string; mutation: Mutation; rate: number }[] = [
    { label: 'clean            ', mutation: 'none', rate: 0 },
    { label: 'addition 100%    ', mutation: 'added', rate: 1 },
    { label: 'removal 5%       ', mutation: 'removed', rate: 0.05 },
    { label: 'retype 5%        ', mutation: 'retyped', rate: 0.05 },
    { label: 'garbage retype 5%', mutation: 'garbage', rate: 0.05 },
    { label: 'null 5%          ', mutation: 'nulled', rate: 0.05 },
];

async function runStitch(m: Mutation, rate: number): Promise<Verdict> {
    const clock = manualClock();
    const vendor = new FakeVendor({ mutation: m, rate });
    const watch = new DriftRate({
        clock,
        window: 60_000,
        zeroWatch: ['transaction_id', 'amount'],
    });
    const charge = stitch({
        name: 'charge',
        url: 'https://pay.example/charges',
        adapter: vendor.adapter(),
        output: chargeOutput,
        trace: watch,
        clock,
    });
    const v: Verdict = { ok: 0, failed: 0, alerts: [], zeros: 0 };
    for (let i = 0; i < 100; i += 1) {
        const r = await charge.safe();
        if (r.ok) {
            v.ok += 1;
            const d = r.data as Record<string, unknown>;
            if (d['transaction_id'] === 0 || d['amount'] === 0) v.zeros += 1;
        } else v.failed += 1;
        await clock.advance(500);
    }
    // Only `warn` and above is an alert; `verbose`/`info` rows are the release log.
    v.alerts = watch
        .report()
        .filter((line) => !/: (verbose|info)\|/.test(line));
    return v;
}

async function runHand(m: Mutation, rate: number): Promise<Verdict> {
    const clock = manualClock();
    const vendor = new FakeVendor({ mutation: m, rate });
    const adapter = vendor.adapter();
    const watch = new HandRate(() => clock.now(), 60_000);
    const v: Verdict = { ok: 0, failed: 0, alerts: [], zeros: 0 };
    for (let i = 0; i < 100; i += 1) {
        const r = await guardedCall(
            adapter,
            'https://pay.example/charges',
            SHAPE,
            watch,
        );
        if (r.ok) {
            v.ok += 1;
            const d = r.value ?? {};
            if (d['transaction_id'] === 0 || d['amount'] === 0) v.zeros += 1;
        } else v.failed += 1;
        await clock.advance(500);
    }
    v.alerts = watch
        .report()
        .filter((line) => !/: (verbose|info)\|/.test(line));
    return v;
}

async function main(): Promise<void> {
    heading('C8 — the assembled canary watch');

    // ── (a) the six workloads through the assembled configuration ───────────────────────────
    {
        const rows: string[] = [];
        for (const w of WORKLOADS) {
            const v = await runStitch(w.mutation, w.rate);
            rows.push(
                `${w.label} ok=${v.ok} failed=${v.failed} zeros=${v.zeros} alerts=${v.alerts.length}`,
            );
        }
        checkSeq('(a) outcomes', rows, [
            'clean             ok=100 failed=0 zeros=0 alerts=0',
            'addition 100%     ok=100 failed=0 zeros=0 alerts=0',
            'removal 5%        ok=95 failed=5 zeros=0 alerts=1',
            'retype 5%         ok=95 failed=5 zeros=0 alerts=1',
            'garbage retype 5% ok=95 failed=5 zeros=0 alerts=1',
            'null 5%           ok=95 failed=5 zeros=0 alerts=1',
        ]);
        note(
            '(a) → SILENT on 100% additions, LOUD on all four breaking classes at 5%, and ZERO $0 charges on any workload. That is the target the capture set',
            '',
        );
    }

    // ── (b) the alert lines themselves ───────────────────────────────────────────────────────
    {
        const lines: string[] = [];
        for (const w of WORKLOADS) {
            const v = await runStitch(w.mutation, w.rate);
            lines.push(`${w.label} → ${v.alerts[0] ?? '<silent>'}`);
        }
        checkSeq('(b) what an on-call engineer reads', lines, [
            'clean             → <silent>',
            'addition 100%     → <silent>',
            'removal 5%        → 5.0% of calls: error|invalid|currency|Invalid input: expected string, received undefined (5/100)',
            'retype 5%         → 5.0% of calls: error|invalid|transaction_id|Invalid input: expected number, received string (5/100)',
            'garbage retype 5% → 5.0% of calls: error|invalid|transaction_id|Invalid input: expected number, received string (5/100)',
            'null 5%           → 5.0% of calls: error|invalid|transaction_id|Invalid input: expected number, received null (5/100)',
        ]);
        note(
            '(b) → the rate, the field, and both types, on one line, with no per-call noise. The two retype workloads read IDENTICALLY, which is fine here BECAUSE neither produced a value',
            '',
        );
    }

    // ── (c) the same six workloads against the SOFT schema, to price the strictness ──────────
    // This is the configuration a team writes when the strict one starts failing calls. It keeps
    // 100% availability and pays for it in fabricated money.
    {
        const Soft = z.object({
            transaction_id: z.coerce.number().catch(0),
            amount: z.coerce.number().catch(0),
            currency: z.string().default('usd'),
            status: z.string(),
        });
        const rows: string[] = [];
        for (const w of WORKLOADS) {
            const clock = manualClock();
            const vendor = new FakeVendor({
                mutation: w.mutation,
                rate: w.rate,
            });
            const watch = new DriftRate({
                clock,
                window: 60_000,
                zeroWatch: ['transaction_id', 'amount'],
            });
            const charge = stitch({
                name: 'charge',
                url: 'https://pay.example/charges',
                adapter: vendor.adapter(),
                output: drift(Soft, CANARY_DRIFT),
                trace: watch,
                clock,
            });
            let ok = 0;
            let zeros = 0;
            for (let i = 0; i < 100; i += 1) {
                const r = await charge.safe();
                await clock.advance(500);
                if (!r.ok) continue;
                ok += 1;
                const d = r.data as Record<string, unknown>;
                if (d['transaction_id'] === 0 || d['amount'] === 0) zeros += 1;
            }
            rows.push(`${w.label} ok=${ok} zeros=${zeros}`);
        }
        checkSeq('(c) the soft schema', rows, [
            'clean             ok=100 zeros=0',
            'addition 100%     ok=100 zeros=0',
            'removal 5%        ok=100 zeros=0',
            'retype 5%         ok=100 zeros=0',
            'garbage retype 5% ok=100 zeros=5',
            'null 5%           ok=100 zeros=5',
        ]);
        note(
            "(c) → EVERY call succeeds on every workload, and TEN $0 charges land across two of them. The `garbage` row is C3's `.catch(0)` route and the `null` row is C3's bare `z.coerce.number()` route",
            '',
        );
    }

    // ── (d) the hand-rolled baseline agrees, workload for workload ───────────────────────────
    {
        const rows: string[] = [];
        for (const w of WORKLOADS) {
            const v = await runHand(w.mutation, w.rate);
            rows.push(
                `${w.label} ok=${v.ok} failed=${v.failed} zeros=${v.zeros} alerts=${v.alerts.length}`,
            );
        }
        checkSeq('(d) the same six, no library', rows, [
            'clean             ok=100 failed=0 zeros=0 alerts=0',
            'addition 100%     ok=100 failed=0 zeros=0 alerts=0',
            'removal 5%        ok=95 failed=5 zeros=0 alerts=1',
            'retype 5%         ok=95 failed=5 zeros=0 alerts=1',
            'garbage retype 5% ok=95 failed=5 zeros=0 alerts=1',
            'null 5%           ok=100 failed=0 zeros=0 alerts=1',
        ]);
        note(
            '(d) → identical on additions, removals and BOTH retypes. The one row that differs is `null 5%`, and the hand-rolled version is BETTER there: it levels a null as `warn`, passes the null through, and alerts — which is the fourth industry class (`nullable is warning-level, value intact`) that C5 measured as inexpressible in `DriftOptions`',
            '',
        );
    }

    // ── (e) the price, in lines ──────────────────────────────────────────────────────────────
    {
        const declarative = countedLines('canary-watch.ts');
        const sink = countedLines('drift-rate.ts');
        const hand = countedLines('hand-rolled.ts');
        check('(e) the declarative configuration', declarative, 9);
        check('(e) the DriftRate sink (user code)', sink, 84);
        check('(e) hand-rolled, same feature set', hand, 92);
        check('(e) library total (config + sink)', declarative + sink, 93);
        note(
            '(e) → 93 vs 92, a wash. The DETECTION is 9 declarative lines against ~35 hand-rolled; the AGGREGATION is ~84 lines of user code either way, and the sink pays an extra `spanId` join that the hand-rolled loop gets for free by having the raw body and the value in the same scope',
            '',
        );
    }

    // ── (f) what the 74 lines do not have ────────────────────────────────────────────────────
    // The same argument scenario 11 landed on: the detector is not what the library is buying.
    // One `retry` line recovers a 503 mid-canary, with the drift rate still counting logical calls
    // rather than wire attempts.
    {
        const clock = manualClock();
        let n = 0;
        let wire = 0;
        const watch = new DriftRate({ clock, window: 600_000 });
        const charge = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: async () => {
                wire += 1;
                if (wire % 4 === 1 && wire < 30)
                    return { status: 503, headers: {}, body: {} };
                n += 1;
                return {
                    status: 200,
                    headers: {},
                    body: {
                        transaction_id: n % 20 === 0 ? null : 100000 + n,
                        amount: 4200,
                        currency: 'usd',
                        status: 'succeeded',
                    },
                };
            },
            output: chargeOutput,
            trace: watch,
            clock,
            retry: { attempts: 3, backoff: { base: 100 } },
        });
        let ok = 0;
        for (let i = 0; i < 100; i += 1) {
            const p = charge.safe();
            await clock.advance(0);
            await clock.advance(100);
            await clock.advance(200);
            const r = await p;
            if (r.ok) ok += 1;
            await clock.advance(400);
        }
        check('(f) wire requests', wire, 108);
        check('(f) logical calls counted', watch.calls, 100);
        check('(f) successful calls', ok, 95);
        checkSeq('(f) the alert', watch.report(), [
            '5.0% of calls: error|invalid|transaction_id|Invalid input: expected number, received null (5/100)',
        ]);
        note(
            '(f) → 108 wire requests, 100 logical calls, and the rate is over LOGICAL calls. Retry did not inflate the denominator, and the 8 recovered 503s never touched the drift number',
            '',
        );
    }

    // ── (g) the one thing this configuration still cannot do ─────────────────────────────────
    // Everything above is the STRICT posture, where a type change fails the call. The moment any
    // field is softened for availability, C3(e) is back: the finding for the benign coercion and
    // the finding for the $0 charge are byte-identical, and the ONLY thing that separates them is
    // the sink's join to the `result` event.
    {
        const clock = manualClock();
        const Soft = z.object({
            transaction_id: z.coerce.number().catch(0),
            amount: z.number(),
            currency: z.string(),
            status: z.string(),
        });
        const bodies = [
            {
                transaction_id: '100001',
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            },
            {
                transaction_id: 'abc',
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            },
        ];
        let i = 0;
        const watch = new DriftRate({
            clock,
            zeroWatch: ['transaction_id'],
        });
        const charge = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: async () => ({
                status: 200,
                headers: {},
                body: bodies[i++ % 2],
            }),
            output: drift(Soft, CANARY_DRIFT),
            trace: watch,
            clock,
        });
        for (let k = 0; k < 10; k += 1) await charge.safe();
        checkSeq('(g) the alert on a softened field', watch.report(), [
            '100.0% of calls: warn|coerced|transaction_id|string -> number (10/10, 5 landed 0)',
        ]);
        note(
            '(g) → 10 calls, ONE finding identity, and only the `5 landed 0` half says half of them were $0 charges. That clause is the sink joining `drift` to `result` on `ctx.spanId` — it is not in any finding',
            '',
        );
    }

    finish(
        'C8',
        'ACHIEVABLE, AND THE STRICT POSTURE IS THE ONE THAT WORKS. Two declarative lines — `output: drift(StrictCharge, { severity: { undeclared: "verbose" } })` and `trace: new DriftRate(...)` — measured over six workloads at 100 calls each: SILENT on a 100% addition rollout, and one alert line per breaking class at 5%, each carrying the rate, the field and both types (`5.0% of calls: error|invalid|transaction_id|Invalid input: expected number, received null (5/100)`). ZERO $0 charges on every workload. The same six against the SOFT schema people write for availability keep 100% of calls and produce TEN $0 charges. The price is a WASH: 9 declarative lines + an 84-line sink = 93, against 92 hand-rolled. The detection half is 9 lines against ~35; the aggregation half is ~84 lines of user code either way. What the 92 lines do not have is the resilience stack, measured here as one `retry` line absorbing 8 x 503 across the canary with the rate still counting 100 LOGICAL calls out of 108 wire requests. And the hand-rolled classifier BEATS `DriftOptions` on one row: it levels a null `warn` and passes the value through, the fourth industry class C5 found inexpressible. The residual gap is C3(e): the moment a field is softened, the benign coercion and the $0 charge share one finding identity, and only the sink\'s `spanId` join to the `result` event (`10/10, 5 landed 0`) separates them',
    );
}

void main();
