// C1 — the vendor ADDS a field the consumer does not model. Non-breaking by every published
// policy (LinkedIn, Xandr), so the right answer is "notice, do not alarm, do not fail".
//
// Measured: `info | undeclared | settlement_delay_ms | undeclared field (number)`, the call
// succeeds, and the added value is STRIPPED from what the caller receives. That last half is the
// part nobody writes down: drift tells you a field appeared and simultaneously guarantees you
// cannot read it, because the value the engine serves is the VALIDATED one (engine.ts:1224).
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c1-added-field.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

const Charge = z.object({
    transaction_id: z.number(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
});

const BASELINE = {
    transaction_id: 100001,
    amount: 4200,
    currency: 'usd',
    status: 'succeeded',
};

/** Collect the drift findings a run emitted, via the trace sink (the accessor C7 measures). */
function collector(): { sink: TraceSink; seen: string[] } {
    const seen: string[] = [];
    return {
        seen,
        sink: {
            handle(e: StitchEvent) {
                if (e.type === 'drift') seen.push(fmt(e.finding));
            },
        },
    };
}

async function main(): Promise<void> {
    heading('C1 — a field the vendor ADDED');

    // ── (a) the added field: one info finding, a successful call ─────────────────────────────
    {
        const { sink, seen } = collector();
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({ ...BASELINE, settlement_delay_ms: 900 }),
            output: drift(Charge),
            trace: sink,
        });
        const r = await call.safe();

        check('(a) the call SUCCEEDED', r.ok, true);
        check('(a) no error', r.error, null);
        checkSeq('(a) findings', seen, [
            'info|undeclared|settlement_delay_ms|undeclared field (number)',
        ]);
        note(
            '(a) → the finding is INFO, it NAMES the field, and it says what type arrived',
            '',
        );
    }

    // ── (b) …and the added value never reaches the caller ────────────────────────────────────
    // The engine serves `validated`, not `raw` (engine.ts:1224), and a Zod object strips unknown
    // keys. So the one accessor a normal caller uses cannot see the new field at all.
    {
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({ ...BASELINE, settlement_delay_ms: 900 }),
            output: drift(Charge),
        });
        const r = await call.safe();
        const data = r.data as Record<string, unknown>;

        checkSeq('(b) keys the caller received', Object.keys(data), [
            'transaction_id',
            'amount',
            'currency',
            'status',
        ]);
        check(
            '(b) the added value on the awaited path',
            data['settlement_delay_ms'],
            undefined,
        );
        note(
            '(b) → the addition is REPORTED and STRIPPED at the same time. To read the new value you need `.inspect().raw` — a second request',
            '',
        );

        const ins = await call.inspect();
        const raw = ins.raw as Record<string, unknown>;
        check(
            '(b) …and `.inspect().raw` does carry it',
            raw['settlement_delay_ms'],
            900,
        );
    }

    // ── (c) `ignore` silences a known addition without touching the schema ───────────────────
    // The acknowledged-surface lever. Path-based, so a field you have already triaged stops
    // producing a finding on every subsequent call.
    {
        const { sink, seen } = collector();
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({ ...BASELINE, settlement_delay_ms: 900 }),
            output: drift(Charge, { ignore: ['settlement_delay_ms'] }),
            trace: sink,
        });
        const r = await call.safe();
        check('(c) still succeeds', r.ok, true);
        checkSeq('(c) findings with `ignore`', seen, []);
    }

    // ── (d) a NESTED addition, and an addition inside every array element ────────────────────
    // The `[]` grammar collapses a per-element addition into ONE finding with a count and a
    // sample coordinate (drift.ts:184-198) — a 50-item list does not produce 50 alarms.
    {
        const { sink, seen } = collector();
        const Envelope = z.object({
            charges: z.array(z.object({ transaction_id: z.number() })),
            meta: z.object({ page: z.number() }),
        });
        const call = stitch({
            url: 'https://pay.example/charges',
            adapter: serving({
                charges: Array.from({ length: 50 }, (_v, i) => ({
                    transaction_id: i,
                    settlement_delay_ms: 900,
                })),
                meta: { page: 1, cursor: 'abc' },
            }),
            output: drift(Envelope),
            trace: sink,
        });
        const r = await call.safe();
        check('(d) still succeeds', r.ok, true);
        checkSeq('(d) findings over 50 elements + a nested key', seen.sort(), [
            'info|undeclared|charges[].settlement_delay_ms|all 50 elements: undeclared field (number)',
            'info|undeclared|meta.cursor|undeclared field (string)',
        ]);
        note(
            '(d) → 51 added values, 2 findings. The array collapse is real and the nested path is fully qualified',
            '',
        );
    }

    // ── (e) the same addition against a stitch with NO output schema ─────────────────────────
    // The control. Without a schema there is nothing to diff against, so the addition passes
    // through to the caller and produces no finding at all.
    {
        const { sink, seen } = collector();
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({ ...BASELINE, settlement_delay_ms: 900 }),
            trace: sink,
        });
        const r = await call.safe();
        const data = r.data as Record<string, unknown>;
        checkSeq('(e) findings with no `output`', seen, []);
        check(
            '(e) …but the value DOES reach the caller',
            data['settlement_delay_ms'],
            900,
        );
        note(
            '(e) → the two properties trade off exactly: schema ⇒ finding + stripped, no schema ⇒ value + silence',
            '',
        );
    }

    finish(
        'C1',
        'CONFIRMED, and quieter than the capture hoped for. An added field produces exactly one `info|undeclared|settlement_delay_ms|undeclared field (number)` finding, the call succeeds, and 51 added values across a 50-element array collapse to 2 findings with `all 50 elements` and a sample coordinate. `ignore: ["settlement_delay_ms"]` silences it without touching the schema. The half the capture does not mention: the engine serves the VALIDATED value (engine.ts:1224), so the added field is STRIPPED — `data.settlement_delay_ms` is `undefined` on the awaited path, and reading it needs `.inspect().raw`, which is a second request',
    );
}

void main();
