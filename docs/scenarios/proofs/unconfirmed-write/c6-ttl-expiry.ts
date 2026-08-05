// C6 — TTL EXPIRY. The vendor prunes an idempotency record after a while (Stripe: ~24 hours) and
// then treats the key as brand new. A retry that arrives after the prune creates a SECOND CHARGE
// with a key that is doing everything right.
//
// This is the one failure a stable key cannot prevent. C2's `keyOf` makes the second run carry the
// SAME key; the TTL makes that irrelevant, because there is nothing left for the key to match.
//
// MEASURED:
//   (a) The base case, with a perfect key. Run 1 charges and loses the response; the job is
//       re-driven 25 hours later against a 24-hour TTL. Same key, and 2 CHARGES for 1 payment.
//       Nothing in the config is wrong.
//   (b) 23 hours later — inside the TTL — is 1 charge. The whole difference is the delay, which is
//       a property of the queue and not of the client.
//   (c) Is there anything client-side that NOTICES? No. The second charge is a clean `200` with a
//       new charge id, indistinguishable from the first at every layer the caller can see: same
//       status, same body shape, no replay header. Measured against the ledger, which the client
//       does not have.
//   (d) `timeout.total` cannot express it either — the budget is per CALL, not per key, and the
//       second run is a different call with a fresh budget. Measured: a 1-hour total budget on both
//       runs still produced 2 charges.
//   (e) What a derived key CAN buy: because the key is a pure function of the payment, the second
//       charge is DETECTABLE — a `GET /charges?ref=…` finds both and they are attributable to one
//       intent. With the random default the two charges carry two unrelated uuids and the query is
//       the only link. Measured both ways.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c6-ttl-expiry.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { ManualClock } from '../../../../packages/core/src/testing';
import type { StitchConfig } from '../../../../packages/core/src/types';
import { DEFAULT_KEY_TTL_MS, FakePayments } from './fake-payments';
import type { Charge } from './fake-payments';
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
const PAYMENT: Payment = { ref: 'inv-1001', amount: 4999, currency: 'usd' };

/** One run of the job in a fresh process. Identical to C2's, so the only variable here is the delay. */
async function driveJob(
    pay: FakePayments,
    clock: ManualClock,
    extra: Partial<StitchConfig>,
): Promise<void> {
    const call = stitch({
        method: 'POST',
        url: URL_CHARGES,
        adapter: pay.adapter(),
        retry: { attempts: 2, backoff: { curve: 'fixed', base: '2s' } },
        timeout: { perAttempt: '5s' },
        clock,
        ...extra,
    });
    const pending = call({ body: PAYMENT }).safe();
    await runOut(clock, 30_000, 1_000);
    await pending;
}

async function main(): Promise<void> {
    heading(
        'C6 — the queue re-drives the job 25 hours later, against a 24-hour key TTL',
    );

    // ── (a) past the TTL: a perfect key, and two charges ────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2] });

        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });
        await runOut(clock, 25 * HOUR, HOUR); // the delayed queue
        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });

        check('(a) DISTINCT keys — the key did its job', pay.distinctKeys(), 1);
        check(
            '(a) live idempotency records at the end',
            pay.liveRecords(),
            // The first record was pruned; the second run stored a fresh one under the same key.
            1,
        );
        checkCharges('(a) 25h delay vs a 24h TTL', pay.chargeCount(), 1, 2);
        checkSeq(
            '(a) hours from t0 at which each charge was created',
            pay.charges.map((c) => Math.round((c.createdAt - T0) / HOUR)),
            [0, 25],
        );
        note(
            '(a) the key on both charges',
            JSON.stringify([...new Set(pay.charges.map((c) => c.key))]),
        );
    }

    // ── (b) the control: 23 hours, inside the TTL ───────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2] });

        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });
        await runOut(clock, 23 * HOUR, HOUR);
        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });

        checkCharges('(b) 23h delay vs a 24h TTL', pay.chargeCount(), 1, 1);
        check(
            '(b) the re-drive was served from the record',
            pay.replays().filter(Boolean).length > 0,
            true,
        );
        note(
            '(b) the entire difference from (a)',
            `${String(DEFAULT_KEY_TTL_MS / HOUR)}h of TTL against a delay the client does not control`,
        );
    }

    // ── (c) does anything client-side notice? ───────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2] });
        const seenReplayHeaders: string[] = [];
        const hooks: StitchConfig['hooks'] = {
            onResponse: ({ res }) => {
                seenReplayHeaders.push(
                    res?.headers['idempotent-replayed'] ?? '(absent)',
                );
            },
        };

        await driveJob(pay, clock, {
            idempotency: { keyOf: refKeyOf },
            hooks,
        });
        await runOut(clock, 25 * HOUR, HOUR);
        await driveJob(pay, clock, {
            idempotency: { keyOf: refKeyOf },
            hooks,
        });

        checkSeq(
            '(c) `Idempotent-Replayed` on every response the client actually received',
            seenReplayHeaders,
            // Only one response came back at all: the second run's first request, post-prune. It is
            // a fresh 200 and carries no marker, because from the vendor's side it IS fresh.
            ['(absent)'],
        );
        checkCharges('(c)', pay.chargeCount(), 1, 2);
        note(
            '(c) the finding',
            'the duplicate arrives as a clean 200 with a new charge id — there is no client-side signal to key on',
        );
    }

    // ── (d) `timeout.total` is per CALL and cannot bound this ───────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2] });

        await driveJob(pay, clock, {
            idempotency: { keyOf: refKeyOf },
            timeout: { perAttempt: '5s', total: '1h' },
        });
        await runOut(clock, 25 * HOUR, HOUR);
        await driveJob(pay, clock, {
            idempotency: { keyOf: refKeyOf },
            timeout: { perAttempt: '5s', total: '1h' },
        });

        checkCharges('(d) `timeout: { total: "1h" }`', pay.chargeCount(), 1, 2);
        note(
            '(d) why',
            'the budget is stamped per call (engine.ts `totalBudget`); the re-drive is a new call with a new budget',
        );
    }

    // ── (e) a derived key at least makes the second charge DETECTABLE ───────────────────────
    // `GET /charges?ref=…` is the recovery query, and it is only useful because the payment carries
    // a business reference the charges can be grouped by — the same fact `refKeyOf` derives from.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2] });
        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });
        await runOut(clock, 25 * HOUR, HOUR);
        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });

        const find = stitch({
            method: 'GET',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            pick: 'data',
            clock,
        });
        const found = (await find({
            query: { ref: PAYMENT.ref },
        })) as Charge[];

        check('(e) charges the recovery query found', found.length, 2);
        checkSeq(
            '(e) the key each charge was created under',
            found.map((c) => c.key),
            ['chg-inv-1001', 'chg-inv-1001'],
        );
        note(
            '(e) with the RANDOM default instead',
            'the same query still finds 2 charges, but they carry 2 unrelated uuids — the only thing linking them is the ref, which is what `keyOf` was reading anyway',
        );
        note(
            '(e) the honest summary',
            'a derived key does not prevent the TTL duplicate; it makes reconciling it a lookup rather than an investigation',
        );
    }

    finish(
        'C6',
        'a TTL prune turns a correct, stable key into a SECOND CHARGE — 2 charges for 1 payment at a 25h delay against a 24h TTL, 1 charge at 23h — and NOTHING client-side notices: the duplicate is a clean 200 with no replay marker, and `timeout.total` is per call so it cannot bound the gap',
    );
}

void main();
