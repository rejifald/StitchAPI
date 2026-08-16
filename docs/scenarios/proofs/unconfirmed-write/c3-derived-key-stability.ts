// C3 — is a `keyOf`-derived key restart-stable, and is it stable against BODY RE-SERIALISATION?
//
// C2 established that a derived key survives a restart. This claim asks the harder half: the second
// process rebuilds the body from a database row, or a decimal library, or a struct with an optional
// field — the PARAMETERS are identical and the OBJECT is not. A key derived from that object moves
// with it, and a key that moves is a second charge.
//
// MEASURED, and it splits by what the derivation reads:
//   (a) `JSON.stringify(input.body)` — the obvious implementation — is NOT stable. Key ORDER alone
//       produced a different key and A SECOND CHARGE. Note what did NOT happen: no 409. The server
//       never got to compare parameters, because it never saw the same key twice. A body-derived key
//       fails by SILENTLY charging twice, which is worse than the error the capture expected.
//   (b) Two re-serialisations that DON'T move the key: `1` vs `1.0` (JS has one number type, so
//       `4999.0` and `4999` are the same value), and a present-but-`undefined` optional field
//       (`JSON.stringify` drops it). Both are stable. The capture listed number formatting as a
//       risk; in JavaScript it is not one.
//   (c) `refKeyOf` — the business fact alone — is stable across all three variants: 1 key, 1 charge.
//   (d) `canonicalKeyOf` — a sha256 over sorted-key JSON — is likewise stable across all three, and
//       still moves when the AMOUNT changes, which is the property you actually want.
//   (e) An `input.body` SCHEMA now saves you too: `validateInput` (engine.ts:415-447) returns the
//       parsed value and the engine runs the rest of the call on it (engine.ts:1768-1773) —
//       `applyIdempotency` included — so a canonicalising schema held the naive key at 1 key /
//       1 charge across all three variants. This audit measured the opposite and filed it as
//       #648; #663 closed it. (e) is the regression pin.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c3-derived-key-stability.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { ManualClock } from '../../../../packages/core/src/testing';
import type { StitchInput } from '../../../../packages/core/src/types';
import type { Validator } from '../../../../packages/core/src/validator';
import { FakePayments } from './fake-payments';
import {
    check,
    checkCharges,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { bodyVariants, canonicalKeyOf, naiveKeyOf, refKeyOf } from './keys';
import type { Payment } from './keys';

const URL_CHARGES = 'https://api.pay.test/v1/charges';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const PAYMENT: Payment = { ref: 'inv-1001', amount: 4999, currency: 'usd' };

/**
 * Drive the SAME logical payment once per body variant, each from a freshly constructed stitch (a
 * fresh process). The vendor persists, so the charge ledger accumulates across all three.
 */
async function driveVariants(
    keyOf: (input: StitchInput) => string,
    clock: ManualClock,
    pay: FakePayments,
): Promise<void> {
    for (const variant of bodyVariants(PAYMENT)) {
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: { keyOf },
            retry: { attempts: 2 },
            clock,
        });
        await call({ body: variant.body }).safe();
    }
}

async function main(): Promise<void> {
    heading(
        'C3 — the same payment, three ways of building the body: does the key move? (moving = extra charges)',
    );

    note(
        'the three bodies',
        JSON.stringify(bodyVariants(PAYMENT).map((v) => v.label)),
    );

    // ── (a) `JSON.stringify(body)` — the obvious derivation ──────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        await driveVariants(naiveKeyOf, clock, pay);

        checkSeq('(a) keys on the wire', pay.keys(), [
            'chg-{"ref":"inv-1001","amount":4999,"currency":"usd"}',
            'chg-{"currency":"usd","amount":4999,"ref":"inv-1001"}',
            'chg-{"ref":"inv-1001","amount":4999,"currency":"usd"}',
        ]);
        check('(a) DISTINCT keys for one payment', pay.distinctKeys(), 2);
        checkCharges('(a) `JSON.stringify(body)`', pay.chargeCount(), 1, 2);
        checkSeq(
            '(a) status per request — note there is NO 409',
            pay.statuses(),
            [200, 200, 200],
        );
        note(
            '(a) which variant broke it',
            'key re-ordering. `1.0` and a present-but-undefined field did NOT move the key — variant 3 matched variant 1',
        );
        note(
            '(a) the failure shape',
            'a silent second charge, not the error the capture expected — the server never saw a repeated key',
        );
    }

    // ── (b) the two re-serialisations that are harmless in JavaScript ────────────────────────
    // Worth isolating, because the capture named number formatting as a risk and it is not one here:
    // JS has a single number type, so `4999.0 === 4999` and both serialise to `4999`.
    {
        check(
            '(b) `4999.0` and `4999` serialise the same',
            JSON.stringify({ amount: 4999.0 }),
            JSON.stringify({ amount: 4999 }),
        );
        check(
            '(b) a present-but-undefined optional field is dropped by JSON.stringify',
            JSON.stringify({ ref: 'x', description: undefined }),
            JSON.stringify({ ref: 'x' }),
        );
        note(
            '(b) what remains',
            'key ORDER — the one difference `JSON.stringify` preserves and the vendor does not care about',
        );
    }

    // ── (c) the business fact alone ─────────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        await driveVariants(refKeyOf, clock, pay);

        checkSeq('(c) keys on the wire', pay.keys(), [
            'chg-inv-1001',
            'chg-inv-1001',
            'chg-inv-1001',
        ]);
        checkCharges('(c) `refKeyOf`', pay.chargeCount(), 1, 1);
        checkSeq('(c) replayed? per request', pay.replays(), [
            false,
            true,
            true,
        ]);
    }

    // ── (d) a canonical hash of the whole parameter set ──────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        await driveVariants(canonicalKeyOf, clock, pay);

        check('(d) DISTINCT keys across the 3 variants', pay.distinctKeys(), 1);
        checkCharges('(d) `canonicalKeyOf`', pay.chargeCount(), 1, 1);

        // …and it still separates two genuinely different payments, which `refKeyOf` would too but
        // a constant would not. This is the property that makes a derived key safe rather than just
        // stable: it must be unique across distinct writes.
        const changed = canonicalKeyOf({
            body: { ...PAYMENT, amount: 5999 },
        });
        check(
            '(d) a different AMOUNT produces a different key',
            changed !== canonicalKeyOf({ body: PAYMENT }),
            true,
        );
    }

    // ── (e) an input SCHEMA canonicalises the body for `keyOf` — the regression pin ──────────
    // `validateInput` (engine.ts:415-447) returns the parsed input and the engine runs everything
    // downstream on it (engine.ts:1768-1773), so `buildRequest` → `applyIdempotency` derives the
    // key from the VALIDATED body. It used to discard the parsed value — measured here as 2 keys /
    // 2 charges and filed as #648, closed by #663 — so this section pins the fix.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        // A validator that returns a CONSTANT canonical value. `keyOf` sees the validated value,
        // so every key is identical — ONE distinct key is the direct measurement that the parsed
        // result replaces the raw body. (`Validator.validate` is async, hence the `Promise.resolve`.)
        const canonicalising: Validator = {
            validate: () =>
                Promise.resolve({
                    ok: true as const,
                    value: { ref: 'inv-1001', amount: 4999, currency: 'usd' },
                }),
        };
        for (const variant of bodyVariants(PAYMENT)) {
            const call = stitch({
                method: 'POST',
                url: URL_CHARGES,
                adapter: pay.adapter(),
                input: { body: canonicalising },
                idempotency: { keyOf: naiveKeyOf },
                retry: { attempts: 2 },
                clock,
            });
            await call({ body: variant.body }).safe();
        }

        check(
            '(e) DISTINCT keys with a canonicalising body schema in place',
            pay.distinctKeys(),
            1,
        );
        checkCharges(
            '(e) schema + `JSON.stringify(body)`',
            pay.chargeCount(),
            1,
            1,
        );
        note(
            '(e) why',
            '`validateInput` returns the parsed input (#663, closing #648) — `keyOf` gets the canonical value, not the caller’s raw object',
        );
    }

    finish(
        'C3',
        'a derived key is restart-stable but only as stable as what it reads: `JSON.stringify(body)` moved on KEY ORDER alone and produced 2 charges for 1 payment with NO 409, while `refKeyOf` and a canonical sha256 held at 1 key / 1 charge across all three variants; number formatting and undefined fields are harmless in JS, and since #663 a canonicalising input SCHEMA tames even the naive key — `keyOf` reads the validated body (1 key, 1 charge)',
    );
}

void main();
