// C8 — assemble the safest answer available and run it against every workload in this scenario,
// reporting CHARGES CREATED against CHARGES INTENDED. Then run the same workloads with the config
// the docs' first example uses, as the control.
//
// The safe answer is three declarations and one function:
//
//   1. `idempotency: { keyOf: refKeyOf }` — a key derived from the business fact, so it survives a
//      restart (C2) and does not move when the body is rebuilt (C3).
//   2. `retry` with the DEFAULT `retry.on` — 500 stays out of it, so a cached failure is not
//      retried into the ground (C4 (a)). A transport failure is still retried unconditionally, and
//      the stable key is what makes that safe (C7 (d)).
//   3. `settleCharge` — the user code, and it is QUERY-FIRST, not query-on-failure. The first draft
//      of this file queried only after an ambiguous outcome and still double-charged on W6: a
//      recovery that runs after the write cannot un-write it. Asking before writing is the only
//      ordering that prevents the TTL duplicate.
//
// MEASURED, over six workloads and six intended payments:
//   • assembled: 5 charges — every workload settled correctly, the sixth payment being a card the
//     vendor declined.
//   • control (`idempotency: true`, no recovery): 8 charges, with TWO duplicates (the restart, C2;
//     the TTL prune, C6) and one payment that went through only because the key changed.
//
// The two results that surprised this file are both in the write-up below: W5, where the stable key
// makes a recorded failure STICKY and the random key quietly re-tries it into a success; and the
// concurrency race, where query-first is safe only because the key is stable.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c8-assembled.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { ManualClock } from '../../../../packages/core/src/testing';
import { FakePayments } from './fake-payments';
import type { Charge, FakePaymentsOptions } from './fake-payments';
import {
    check,
    checkCharges,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { refKeyOf } from './keys';
import type { Payment } from './keys';
import { runOut } from './virtual-time';

const URL_CHARGES = 'https://api.pay.test/v1/charges';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

// ── THE USER CODE UNDER TEST ────────────────────────────────────────────────────────────────
// Everything between the two markers is what a caller writes on top of the library.
//
// >>> BEGIN USER CODE
type Settlement =
    | { state: 'settled'; charge: Charge }
    | { state: 'refused'; reason: unknown }
    | { state: 'unknown' };

const charge = (pay: FakePayments, clock: ManualClock) =>
    stitch({
        method: 'POST',
        url: URL_CHARGES,
        adapter: pay.adapter(),
        idempotency: { keyOf: refKeyOf },
        retry: { attempts: 3, backoff: { curve: 'fixed', base: '2s' } },
        timeout: { perAttempt: '5s' },
        clock,
    });

const findByRef = (pay: FakePayments, clock: ManualClock) =>
    stitch({
        method: 'GET',
        url: URL_CHARGES,
        pick: 'data',
        adapter: pay.adapter(),
        clock,
    });

async function settleCharge(
    pay: FakePayments,
    clock: ManualClock,
    payment: Payment,
): Promise<Settlement> {
    const look = async (): Promise<Charge | undefined> =>
        (
            (await findByRef(
                pay,
                clock,
            )({ query: { ref: payment.ref } })) as Charge[]
        )[0];
    const already = await look(); // ask BEFORE writing — the TTL duplicate is not undoable
    if (already) return { state: 'settled', charge: already };
    const r = await charge(pay, clock)({ body: payment }).safe();
    if (r.ok) return { state: 'settled', charge: r.data as Charge };
    // A status means the vendor answered: the outcome is known, even when it is a refusal.
    if (r.error.status !== undefined)
        return { state: 'refused', reason: r.error.body };
    const landed = await look(); // no status = transport-level = genuinely unknown (C7)
    return landed ? { state: 'settled', charge: landed } : { state: 'unknown' };
}
// <<< END USER CODE

/** The control: `idempotency: true` + `retry`, awaited, no recovery. The docs' first example. */
async function chargeNaively(
    pay: FakePayments,
    clock: ManualClock,
    payment: Payment,
): Promise<void> {
    const call = stitch({
        method: 'POST',
        url: URL_CHARGES,
        adapter: pay.adapter(),
        idempotency: true,
        retry: { attempts: 3, backoff: { curve: 'fixed', base: '2s' } },
        timeout: { perAttempt: '5s' },
        clock,
    });
    await call({ body: payment }).safe();
}

type Driver = (
    pay: FakePayments,
    clock: ManualClock,
    payment: Payment,
) => Promise<unknown>;

/**
 * The six workloads, each one intended payment, each one a case an earlier claim measured. Running
 * them against a single driver is what turns eight separate findings into one number.
 */
const WORKLOADS: {
    label: string;
    ref: string;
    opts: Omit<FakePaymentsOptions, 'clock'>;
    /** How many times the job runs — 2 models a crash and a queue re-drive. */
    runs: number;
    /** Virtual ms between runs. Past the 24h TTL is the C6 case. */
    gapMs?: number;
}[] = [
    { label: 'W1 clean success', ref: 'inv-1', opts: {}, runs: 1 },
    {
        label: 'W2 transport blip, retried in-call',
        ref: 'inv-2',
        opts: { dropBeforeProcessingOn: [1] },
        runs: 1,
    },
    {
        label: 'W3 processed then response lost, retried in-call',
        ref: 'inv-3',
        opts: { loseResponseOn: [1] },
        runs: 1,
    },
    {
        label: 'W4 every attempt lost, job re-driven after a crash',
        ref: 'inv-4',
        opts: { loseResponseOn: [1, 2, 3] },
        runs: 2,
    },
    {
        label: 'W5 card declined, the failure is recorded',
        ref: 'inv-5',
        opts: { failChargeOn: [1] },
        runs: 2,
    },
    {
        label: 'W6 re-driven 25h later, past the key TTL',
        ref: 'inv-6',
        opts: { loseResponseOn: [1, 2, 3] },
        runs: 2,
        gapMs: 25 * HOUR,
    },
];

async function runWorkloads(drive: Driver): Promise<{
    created: number;
    intended: number;
    perWorkload: string[];
    writes: number;
}> {
    let created = 0;
    let intended = 0;
    let writes = 0;
    const perWorkload: string[] = [];
    for (const w of WORKLOADS) {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, ...w.opts });
        const payment: Payment = { ref: w.ref, amount: 4999, currency: 'usd' };
        intended++;
        for (let run = 0; run < w.runs; run++) {
            if (run > 0 && w.gapMs) await runOut(clock, w.gapMs, HOUR);
            const pending = drive(pay, clock, payment);
            await runOut(clock, 120_000);
            await pending;
        }
        created += pay.chargeCount();
        writes += pay.calls.filter((c) => c.method === 'POST').length;
        perWorkload.push(`${w.label}: ${String(pay.chargeCount())}`);
    }
    return { created, intended, perWorkload, writes };
}

async function main(): Promise<void> {
    heading(
        'C8 — six workloads, six intended payments: how many charges does the vendor end up holding?',
    );

    // ── the control ─────────────────────────────────────────────────────────────────────────
    {
        const { created, intended, perWorkload, writes } = await runWorkloads(
            (pay, clock, payment) => chargeNaively(pay, clock, payment),
        );
        checkSeq('control — charges per workload', perWorkload, [
            'W1 clean success: 1',
            'W2 transport blip, retried in-call: 1',
            'W3 processed then response lost, retried in-call: 1',
            // The re-drive mints a new key and charges again — C2.
            'W4 every attempt lost, job re-driven after a crash: 2',
            // The re-drive's NEW key misses the recorded failure entirely and is processed fresh,
            // so the declined payment quietly goes through on the second try. See the note below.
            'W5 card declined, the failure is recorded: 1',
            // The prune makes the second run fresh whatever the key — C6.
            'W6 re-driven 25h later, past the key TTL: 2',
        ]);
        checkCharges(
            'control — `idempotency: true`, no recovery',
            created,
            intended,
            8,
        );
        note('control — write requests issued', writes);
        note(
            'control — W5 is the subtle one',
            'a random key never reaches the recorded failure, so the "cached 500" the vendor stored protects nobody — the second run just charged',
        );
    }

    // ── the assembled answer ────────────────────────────────────────────────────────────────
    {
        const { created, intended, perWorkload, writes } = await runWorkloads(
            (pay, clock, payment) => settleCharge(pay, clock, payment),
        );
        checkSeq('assembled — charges per workload', perWorkload, [
            'W1 clean success: 1',
            'W2 transport blip, retried in-call: 1',
            'W3 processed then response lost, retried in-call: 1',
            'W4 every attempt lost, job re-driven after a crash: 1',
            // The stable key DOES reach the recorded failure, so the decline stands. Correct, and
            // it is the mirror image of the control's W5 — see the note.
            'W5 card declined, the failure is recorded: 0',
            'W6 re-driven 25h later, past the key TTL: 1',
        ]);
        checkCharges(
            'assembled — derived key + default `retry.on` + query-first',
            created,
            intended,
            5,
        );
        note('assembled — write requests issued', writes);
        note(
            'assembled — reading it',
            'five charges for six payments; the missing one is W5, whose card the vendor declined. Every workload settled correctly',
        );
        note(
            'assembled — W5’s cost',
            'a stable key makes a RECORDED failure sticky for the whole TTL: a 500 that was transient is replayed as a decision. That is the price of the property that fixes W4',
        );
    }

    // ── why query-FIRST, and why it is only safe with a stable key ──────────────────────────
    // The capture calls out the race: between the query and the write, the original can land. It is
    // real, and the derived key is what covers it — measured both ways, running the two jobs
    // CONCURRENTLY so both queries return empty before either write goes out.
    {
        const race = async (
            keyed: boolean,
        ): Promise<{ charges: number; keys: number }> => {
            const clock = manualClock(T0);
            const pay = new FakePayments({ clock });
            const payment: Payment = {
                ref: 'inv-race',
                amount: 4999,
                currency: 'usd',
            };
            const build = (): ReturnType<typeof stitch> =>
                stitch({
                    method: 'POST',
                    url: URL_CHARGES,
                    adapter: pay.adapter(),
                    idempotency: keyed ? { keyOf: refKeyOf } : true,
                    retry: { attempts: 2 },
                    clock,
                });
            const find = findByRef(pay, clock);
            const worker = async (): Promise<void> => {
                const found = (await find({
                    query: { ref: payment.ref },
                })) as Charge[];
                if (found.length > 0) return;
                await build()({ body: payment }).safe();
            };
            const both = Promise.all([worker(), worker()]);
            await runOut(clock, 60_000);
            await both;
            return { charges: pay.chargeCount(), keys: pay.distinctKeys() };
        };

        const keyed = await race(true);
        const unkeyed = await race(false);
        checkCharges(
            '(race) two concurrent runs, DERIVED key',
            keyed.charges,
            1,
            1,
        );
        check('(race) distinct keys, derived', keyed.keys, 1);
        checkCharges(
            '(race) two concurrent runs, DEFAULT key',
            unkeyed.charges,
            1,
            2,
        );
        check('(race) distinct keys, default', unkeyed.keys, 2);
        note(
            '(race) the finding',
            'query-first does not close the race — the KEY does. Query-first handles the TTL prune; the key handles concurrency. Both are needed and neither substitutes',
        );
    }

    // ── the seam and the line count ─────────────────────────────────────────────────────────
    {
        note(
            'seam',
            '`idempotency.keyOf` for the key; `.safe()` + a second stitch for the recovery. A hook cannot do the recovery — a hook cannot change the outcome',
        );
        note(
            'user code',
            'the `settleCharge` block between the BEGIN/END markers — 12 statements, of which 4 are the recovery and 2 the query-first guard',
        );
        note(
            'what needed NO code at all',
            'per-attempt key reuse (C1), the retry that recovers a lost response (C1 (b)), not retrying a cached 500 (C4 (a)), not retrying a 409 (C5 (a))',
        );
        note(
            'what the recovery costs',
            'one extra GET per payment, and it only works because the vendor stores a business ref the client can search on — an idempotency key alone is not queryable at most vendors',
        );
    }

    finish(
        'C8',
        'the assembled answer settled all six workloads correctly — 5 charges for 6 intended payments, the sixth a declined card — where the control (`idempotency: true`, no recovery) produced 8 charges with two duplicates; the derived key fixes the restart and the concurrency race in configuration alone, and only a QUERY-FIRST recovery prevents the TTL duplicate, because a recovery that runs after the write cannot un-write it',
    );
}

void main();
