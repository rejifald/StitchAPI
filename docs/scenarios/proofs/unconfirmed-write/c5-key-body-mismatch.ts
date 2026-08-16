// C5 — the KEY/BODY MISMATCH: the same idempotency key arrives with different parameters, and the
// vendor answers `409 idempotency_error`. Is it retried (it must not be)? Does the caller get
// something they can act on?
//
// This is the failure `stripe-ruby#431` is about. It is also, measured here, the LEAST dangerous of
// the failures in this scenario — because a 409 means the vendor REFUSED, so nothing was charged
// twice. The dangerous version of a re-serialised body is C3's: a key that moves with the body never
// produces a 409 at all, it produces a second charge.
//
// MEASURED:
//   (a) NOT retried. 409 is not in `retry.on`'s default set, so one request, one failure. Right by
//       default, and `retry: { attempts: 4 }` changed nothing.
//   (b) The caller gets a `StitchError` with `status: 409` and the vendor's error payload on
//       `.body` — `idempotency_key_in_use` is legible and actionable. `.message` is the generic
//       `HTTP 409`, so the actionable part is `.body`, not the message.
//   (c) The ledger says the refusal was real: 1 charge, for the FIRST body. The second body was
//       never applied — which is the correct outcome and not an obvious one.
//   (d) THE FOOTGUN. `verdict: { accept: [409], flag: 'ok' }` — the pure-config classification a
//       reader might reach for — SWALLOWS the error: the call reports `ok: true` and hands the
//       caller the `idempotency_error` payload AS ITS DATA. The caller believes a charge for the
//       NEW amount succeeded. It did not; the vendor refused, and the charge that exists is for the
//       old amount. (`expiring-signatures` C6 measured the same trap on an AWS skew 403; the shape
//       generalises to any vendor whose error envelope has no `ok` field.)
//   (e) Whether a re-serialised body reaches a 409 at all depends on the VENDOR's comparison. Under
//       Stripe's canonical parameter comparison, a re-ordered body with a STABLE key is not a
//       mismatch: 1 charge, no 409. Under a byte-comparing vendor it is: measured, a 409 and 1
//       charge. Either way the money is safe; only the error is different.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c5-key-body-mismatch.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakePayments } from './fake-payments';
import {
    check,
    checkCharges,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { bodyVariants, refKeyOf } from './keys';
import type { Payment } from './keys';
import { runOut } from './virtual-time';

const URL_CHARGES = 'https://api.pay.test/v1/charges';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const PAYMENT: Payment = { ref: 'inv-1001', amount: 4999, currency: 'usd' };
/** The same ref — so the same `refKeyOf` key — with an amount that changed between processes. */
const AMENDED: Payment = { ...PAYMENT, amount: 5999 };

async function main(): Promise<void> {
    heading(
        'C5 — the same key, a different body: a 409. Retried? Actionable? Or swallowed?',
    );

    // ── (a) + (b) + (c) the default handling ────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        const build = (): ReturnType<typeof stitch> =>
            stitch({
                method: 'POST',
                url: URL_CHARGES,
                adapter: pay.adapter(),
                idempotency: { keyOf: refKeyOf },
                retry: {
                    attempts: 4,
                    backoff: { curve: 'fixed', base: '2s', max: '10s' },
                },
                clock,
            });

        await build()({ body: PAYMENT }).safe(); // the charge that ran
        const pending = build()({ body: AMENDED }).safe(); // the re-drive with an amended amount
        await runOut(clock, 60_000);
        const result = await pending;

        check(
            '(a) requests for the amended body, with `retry: { attempts: 4 }`',
            pay.calls.length - 1,
            1,
        );
        checkSeq('(a) status per request', pay.statuses(), [200, 409]);
        note(
            '(a) why',
            '`retry.on` defaults to [429,502,503,504] (engine.ts:612); 409 is not in it',
        );

        check('(b) status on the StitchError', result.error?.status, 409);
        check(
            '(b) message on the StitchError',
            result.error?.message,
            'HTTP 409',
        );
        check(
            '(b) the vendor’s error code, off `error.body`',
            (result.error?.body as { error?: { code?: string } } | undefined)
                ?.error?.code,
            'idempotency_key_in_use',
        );

        checkCharges('(c) the 409 refused the write', pay.chargeCount(), 1, 1);
        check(
            '(c) the amount actually charged is the FIRST body’s',
            pay.charges[0]?.amount,
            4999,
        );
    }

    // ── (d) THE FOOTGUN: `verdict.accept` swallows it ───────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        const build = (): ReturnType<typeof stitch> =>
            stitch({
                method: 'POST',
                url: URL_CHARGES,
                adapter: pay.adapter(),
                idempotency: { keyOf: refKeyOf },
                // The pure-config classification: "a 409 is a normal outcome, tell me about it via
                // the body's `ok` flag". The vendor's error envelope has no `ok` field, so the flag
                // is ABSENT — which `verdict` treats as "no signal" (surface.ts:180-190) — and
                // `accept` alone succeeds on the 409.
                verdict: { accept: [409], flag: 'ok' },
                clock,
            });

        await build()({ body: PAYMENT }).safe();
        const result = await build()({ body: AMENDED }).safe();

        check('(d) result.ok on the 409', result.ok, true);
        check(
            '(d) what the caller was handed AS DATA',
            (result.data as { error?: { type?: string } } | null)?.error?.type,
            'idempotency_error',
        );
        check('(d) result.error', result.error, null);
        checkCharges(
            '(d) what the caller now believes is a 5999 charge',
            pay.chargeCount(),
            1,
            1,
        );
        check(
            '(d) the amount that actually exists',
            pay.charges[0]?.amount,
            4999,
        );
        note(
            '(d) the damage',
            'the caller records a successful 5999 charge; the vendor holds one 4999 charge and refused the amendment',
        );
    }

    // ── (e) does a RE-SERIALISED body reach a 409 at all? ───────────────────────────────────
    // Only if the vendor compares bytes. Stripe compares parameters, so re-ordering is invisible to
    // it — which is why C3's body-derived key fails by charging twice rather than by erroring.
    {
        const clock = manualClock(T0);
        const canonical = new FakePayments({ clock, compare: 'canonical' });
        const strict = new FakePayments({ clock, compare: 'bytes' });
        const variants = bodyVariants(PAYMENT);

        for (const pay of [canonical, strict]) {
            for (const v of variants) {
                const call = stitch({
                    method: 'POST',
                    url: URL_CHARGES,
                    adapter: pay.adapter(),
                    idempotency: { keyOf: refKeyOf },
                    clock,
                });
                await call({ body: v.body }).safe();
            }
        }

        checkSeq(
            '(e) canonical vendor — status per request across the 3 body variants',
            canonical.statuses(),
            [200, 200, 200],
        );
        checkCharges('(e) canonical vendor', canonical.chargeCount(), 1, 1);
        checkSeq(
            '(e) byte-comparing vendor — status per request',
            strict.statuses(),
            [200, 409, 200],
        );
        checkCharges('(e) byte-comparing vendor', strict.chargeCount(), 1, 1);
        note(
            '(e) reading it',
            'variant 3 re-serialises identically to variant 1, so even the strict vendor replays it — only the re-ordering trips',
        );
    }

    finish(
        'C5',
        'a 409 is NOT retried (1 request under `retry: { attempts: 4 }`) and reaches the caller as `status: 409` with `idempotency_key_in_use` on `error.body`, while the ledger shows the refusal was real (1 charge, the FIRST body’s amount) — but `verdict: { accept: [409], flag: "ok" }` SWALLOWS it, reporting `ok: true` and handing the error payload back as data',
    );
}

void main();
