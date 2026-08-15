// C7 — THE TIMEOUT ITSELF. Can the caller tell "the request never arrived" from "it was processed
// and the response was lost"? What do `attempts`, the thrown error, `.safe()` and the event stream
// actually carry?
//
// The honest answer is that no client library can distinguish these — the information is not on the
// client. So the real question is a narrower one: does StitchAPI carry ENOUGH for the caller to
// start a recovery, and does it carry it without lying?
//
// MEASURED — the ambiguity is total, even though the timeout itself is now legible:
//   (a) The two cases are byte-identical at the caller. A request dropped before processing and a
//       request that CREATED A CHARGE and lost its response produce the same `StitchError`: same
//       `name`, same `status` (undefined), same `message`, same `attempts`, same `body`
//       (undefined). The ledgers differ — 0 charges vs 1 — and the client cannot see the ledger.
//   (b) The error CLASS survives as `cause`, not as the thrown type. The engine throws a
//       `TimeoutError` (resilience.ts:21,228); `errEvt` (engine.ts:378-396) reduces it to a message
//       on the event but PINS the live instance, and `rebuildError` (stitch.ts:545-573) re-attaches
//       it as `cause` on the rebuilt `StitchError`. Measured: `constructor.name === 'StitchError'`
//       at the top, `cause.constructor.name === 'TimeoutError'` underneath. The class is still not
//       exported (and never sets `.name` — it reads `'Error'`), so the structural check is on
//       `cause.constructor.name`, not `instanceof`.
//   (c) `hooks.onError` receives the same live error — `constructor.name === 'TimeoutError'` there
//       too, before the caller sees anything. It still cannot change the outcome.
//   (d) A TRANSPORT failure is retried UNCONDITIONALLY: `retry.on` gates statuses only, and the
//       throw path (engine.ts:675-703) has no status to match. Measured: `retry: { attempts: 3,
//       on: [] }` still made 3 requests. You cannot configure "retry a 503 but not a timeout" —
//       the only way to not retry into the unknown is `retry` off entirely.
//   (e) The EVENT STREAM does not carry the idempotency key. `start` carries `name`/`method`/`url`/
//       `input` and no headers, so a caller who used the default random key can never learn which
//       key their lost request carried — which makes the standard "query by key" recovery
//       impossible by construction. `hooks.onRequest` is the only seam that sees it.
//   (f) `attempts` is truthful and useful in one specific way: with a stable key, `attempts: N`
//       still means AT MOST ONE charge. It bounds the damage; it does not report it.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c7-timeout-ambiguity.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchConfig,
    StitchEvent,
} from '../../../../packages/core/src/types';
import { FakePayments } from './fake-payments';
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
const PAYMENT: Payment = { ref: 'inv-1001', amount: 4999, currency: 'usd' };

/**
 * The caller's whole view of a failed call, reduced to the fields they can branch on.
 *
 * `status` and `body` are rendered as STRINGS rather than left `undefined`, so the side-by-side
 * comparison in (a) is a real one — `JSON.stringify` drops an `undefined` field, and two objects
 * that agree only because both dropped it would compare equal for the wrong reason.
 */
interface CallerView {
    ok: boolean;
    name: string;
    ctor: string;
    /** `constructor.name` of `error.cause` — where the engine's `TimeoutError` now rides. */
    causeCtor: string;
    status: string;
    attempts: number;
    message: string;
    body: string;
}

async function runOnce(
    pay: FakePayments,
    clock: ReturnType<typeof manualClock>,
    extra: Partial<StitchConfig> = {},
): Promise<CallerView> {
    const call = stitch({
        method: 'POST',
        url: URL_CHARGES,
        adapter: pay.adapter(),
        idempotency: { keyOf: refKeyOf },
        timeout: { each: '5s' },
        clock,
        ...extra,
    });
    const pending = call({ body: PAYMENT }).safe();
    await runOut(clock, 120_000);
    const r = await pending;
    return {
        ok: r.ok,
        name: r.error?.name ?? '(none)',
        ctor: r.error?.constructor.name ?? '(none)',
        causeCtor:
            (r.error?.cause as Error | undefined)?.constructor.name ?? '(none)',
        status: String(r.error?.status),
        attempts: r.error?.attempts ?? 0,
        message: r.error?.message ?? '',
        body: String(r.error?.body),
    };
}

async function main(): Promise<void> {
    heading(
        'C7 — "never arrived" vs "processed, response lost": can the caller tell? (the ledgers differ; the errors do not)',
    );

    // ── (a) the two cases, side by side ─────────────────────────────────────────────────────
    let neverArrived: CallerView;
    let processedThenLost: CallerView;
    {
        const clockA = manualClock(T0);
        const payA = new FakePayments({
            clock: clockA,
            dropBeforeProcessingOn: [1],
        });
        neverArrived = await runOnce(payA, clockA);

        const clockB = manualClock(T0);
        const payB = new FakePayments({ clock: clockB, loseResponseOn: [1] });
        processedThenLost = await runOnce(payB, clockB);

        checkCharges('(a) case 1 — never arrived', payA.chargeCount(), 1, 0);
        checkCharges(
            '(a) case 2 — PROCESSED, response lost',
            payB.chargeCount(),
            1,
            1,
        );
        check(
            '(a) the two callers’ views, compared field by field',
            JSON.stringify(neverArrived) === JSON.stringify(processedThenLost),
            true,
        );
        note('(a) that identical view', JSON.stringify(processedThenLost));
        note(
            '(a) the ledgers behind them',
            `${String(payA.chargeCount())} charge vs ${String(payB.chargeCount())} charge — the difference the caller cannot see`,
        );
    }

    // ── (b) the thrown class is still `StitchError`; the timeout's identity rides `cause` ────
    {
        check(
            '(b) `error.constructor.name` on a timeout',
            processedThenLost.ctor,
            'StitchError',
        );
        check('(b) `error.name`', processedThenLost.name, 'StitchError');
        check(
            '(b) `error.status` — nothing to branch on',
            processedThenLost.status,
            'undefined',
        );
        check(
            '(b) the message still names the timeout',
            processedThenLost.message,
            'timed out after 5000ms',
        );
        check(
            '(b) and the live class rides `error.cause`',
            processedThenLost.causeCtor,
            'TimeoutError',
        );
        note(
            '(b) so "is this a timeout?"',
            "is `err.cause?.constructor.name === 'TimeoutError'` — structural, no message match; a transport failure rides `cause` too (the `ECONNRESET`-style error, `.code` intact)",
        );
        note(
            '(b) `TimeoutError`',
            'is declared at resilience.ts:21 and exported from NO public entry point (only `RateLimitError` is, index.ts:86) — and it never sets `.name`, so the check is on `constructor.name`, not `cause.name`',
        );
    }

    // ── (c) `hooks.onError` sees the same live instance, earlier ────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1] });
        const seen: string[] = [];
        await runOnce(pay, clock, {
            hooks: {
                onError: ({ error }) => {
                    const e = error as Error;
                    seen.push(`${e.constructor.name}/${e.name}`);
                },
            },
        });

        checkSeq('(c) what hooks.onError was handed', seen, [
            // The constructor is `TimeoutError`; `.name` is `Error` because the class never sets it.
            'TimeoutError/Error',
        ]);
        note(
            '(c) the seam',
            'the hook is handed the same instance the caller later finds on `error.cause` — earlier, but with no power to change the outcome',
        );
    }

    // ── (d) a transport failure is retried unconditionally ──────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2, 3] });
        const view = await runOnce(pay, clock, {
            retry: {
                attempts: 3,
                on: [],
                backoff: { curve: 'fixed', base: '2s' },
            },
        });

        check(
            '(d) requests, with `retry: { attempts: 3, on: [] }`',
            pay.calls.length,
            3,
        );
        check('(d) attempts reported', view.attempts, 3);
        note(
            '(d) why',
            'the throw path (engine.ts:675-703) retries on `attempt < max` alone — there is no status to match `retry.on` against',
        );
        checkCharges(
            '(d) and the stable key is what keeps it at one',
            pay.chargeCount(),
            1,
            1,
        );
    }

    // ── (e) the event stream does not carry the key ─────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1] });
        const events: StitchEvent[] = [];
        const sentKeys: string[] = [];
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true, // the DEFAULT random key — the case that matters
            retry: { attempts: 1 }, // present only to silence the construction nudge
            timeout: { each: '5s' },
            hooks: {
                onRequest: ({ req }) => {
                    sentKeys.push(
                        req?.headers['Idempotency-Key'] ?? '(absent)',
                    );
                },
            },
            clock,
        });
        const consuming = (async () => {
            for await (const ev of call.stream({ body: PAYMENT }))
                events.push(ev);
        })();
        await runOut(clock, 60_000);
        await consuming;

        checkSeq(
            '(e) event types on a lost write',
            events.map((e) => e.type),
            ['start', 'progress', 'error', 'done'],
        );
        const start = events[0] as Extract<StitchEvent, { type: 'start' }>;
        checkSeq('(e) fields on the `start` event', Object.keys(start).sort(), [
            'at',
            'input',
            'method',
            'name',
            'spanId',
            'traceId',
            'type',
            'url',
        ]);
        check(
            '(e) does ANY event carry the idempotency key?',
            JSON.stringify(events).includes(sentKeys[0] ?? ' '),
            false,
        );
        check(
            '(e) hooks.onRequest saw it',
            (sentKeys[0] ?? '').length,
            36, // a uuid
        );
        checkCharges('(e)', pay.chargeCount(), 1, 1);
        note(
            '(e) the consequence',
            'with the default key, the caller cannot name the key their lost request carried — so "ask the vendor about key X" is not available to them',
        );
    }

    // ── (f) what `attempts` is actually good for ────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2, 3, 4] });
        const view = await runOnce(pay, clock, {
            retry: {
                attempts: 4,
                backoff: { curve: 'fixed', base: '2s' },
            },
        });

        check('(f) attempts', view.attempts, 4);
        check('(f) requests that reached the server', pay.calls.length, 4);
        checkCharges(
            '(f) 4 attempts, all lost, under one stable key',
            pay.chargeCount(),
            1,
            1,
        );
        note(
            '(f) the reading',
            '`attempts: 4` bounds the damage at one charge — it does not tell you whether that charge exists',
        );
    }

    finish(
        'C7',
        'the caller CANNOT distinguish the two cases — a dropped request and a charge whose response was lost produced field-for-field identical `StitchError`s (status undefined, "timed out after 5000ms", and the SAME live `TimeoutError` on `error.cause`) over ledgers of 0 and 1 charges; `cause` now says "this was a timeout" structurally (the class stays unexported — check `cause.constructor.name`) but never which side of the wire it died on; a transport failure is retried even with `retry.on: []`, and NO event carries the idempotency key, so the default random key makes a query-by-key recovery impossible',
    );
}

void main();
