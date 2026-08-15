// C2 — THE DECIDING CLAIM. Is the DEFAULT idempotency key stable across a PROCESS RESTART?
//
// A key that survives a retry protects against the failure you can see. A key that survives a
// RESTART protects against the one that costs money: a worker dies mid-charge, the queue re-drives
// the job, and the second run is a second charge. Every claim in this file builds the stitch FRESH
// before each run — a new `stitch({...})` from the same declaration and the same input — which is
// what a re-driven job actually does. The vendor persists across; only the client is new.
//
// MEASURED, and the capture's central worry is CONFIRMED:
//   (a) The default key is `randomUUID()` (engine.ts:172), evaluated per logical call. Two runs of
//       the same declaration with the same input produced TWO DISTINCT keys and TWO CHARGES for one
//       intended payment. The configuration is `idempotency: true` + `retry` — the exact shape the
//       docs recommend — and it double-charges.
//   (b) It is not even stable within ONE process: two calls of the SAME stitch instance also mint
//       two keys. So this is not about restarts at all; the key is per-CALL, and a restart is just
//       the most likely way two calls happen.
//   (c) `keyOf` fixes it: same declaration, same input, fresh process → ONE key, ONE charge.
//   (d) THE FOOTGUN. `keyOf` is function sugar and is STRIPPED from the public `__config`
//       (stitch.ts:936-940). A stitch rebuilt from `__config` — a JSON round-trip through a
//       registry, `serve`, MCP, a config file — keeps `idempotency` and SILENTLY LOSES `keyOf`,
//       falling back to the random default. Measured: `__config.idempotency` is `{}`, the rebuilt
//       stitch charged twice, and nothing warned.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c2-restart-stability.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { ManualClock } from '../../../../packages/core/src/testing';
import type { StitchConfig } from '../../../../packages/core/src/types';
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
 * One run of the job, in a fresh "process": build the stitch from the declaration, call it once with
 * the payment, return. The vendor (`pay`) is the only thing that persists.
 *
 * This is the whole experiment. Everything a real queue re-drive does that matters is here: the
 * module-level `stitch({...})` is evaluated again, and the input is rebuilt from the same durable
 * record.
 */
async function driveJob(
    pay: FakePayments,
    clock: ManualClock,
    extra: Partial<StitchConfig>,
    body: unknown = PAYMENT,
): Promise<void> {
    const call = stitch({
        method: 'POST',
        url: URL_CHARGES,
        adapter: pay.adapter(),
        retry: { attempts: 3, backoff: { curve: 'fixed', base: '2s' } },
        timeout: { each: '5s' },
        clock,
        ...extra,
    });
    const pending = call({ body }).safe();
    await runOut(clock, 60_000);
    await pending;
}

async function main(): Promise<void> {
    heading(
        'C2 — the same job, re-driven after a crash: one key or two? (two keys = two charges)',
    );

    // ── (a) THE DECIDING MEASUREMENT ─────────────────────────────────────────────────────────
    // Run 1 creates the charge and loses the response — the worker dies knowing nothing. The queue
    // re-drives the job. Run 2 is a fresh process with the same declaration and the same input.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2, 3] });

        await driveJob(pay, clock, { idempotency: true }); // the worker that died
        await driveJob(pay, clock, { idempotency: true }); // the queue's re-drive

        note(
            '(a) keys seen by the vendor',
            JSON.stringify(pay.keys().map((k) => k?.slice(0, 8))),
        );
        check(
            '(a) DISTINCT keys across the two runs',
            pay.distinctKeys(),
            // 3 attempts in run 1 (all lost) share one key; run 2's 3 attempts share another.
            2,
        );
        checkCharges('(a) `idempotency: true`', pay.chargeCount(), 1, 2);
        checkSeq(
            '(a) the two charges the vendor now holds',
            pay.charges.map((c) => `${c.id}:${c.ref}:${String(c.amount)}`),
            ['ch_0001:inv-1001:4999', 'ch_0002:inv-1001:4999'],
        );
        note(
            '(a) the configuration that did this',
            "idempotency: true + retry — the shape the idempotency guide's first example uses",
        );
    }

    // ── (b) it is per-CALL, not per-process ──────────────────────────────────────────────────
    // The same stitch INSTANCE, called twice. No restart involved. Two keys, two charges. The
    // restart in (a) was not the cause; it was just the reason two calls happened.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true,
            retry: { attempts: 2 },
            clock,
        });

        await call({ body: PAYMENT }).safe();
        await call({ body: PAYMENT }).safe();

        check(
            '(b) DISTINCT keys from ONE stitch instance called twice',
            pay.distinctKeys(),
            2,
        );
        checkCharges('(b) same instance, twice', pay.chargeCount(), 1, 2);
        note(
            '(b) mechanism',
            '`applyIdempotency` runs inside `buildRequest` (engine.ts:257), and `buildRequest` runs per call',
        );
    }

    // ── (c) `keyOf` is restart-stable ────────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1, 2, 3] });

        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });
        await driveJob(pay, clock, { idempotency: { keyOf: refKeyOf } });

        checkSeq(
            '(c) DISTINCT keys across the two runs',
            [pay.distinctKeys(), ...new Set(pay.keys())],
            [1, 'chg-inv-1001'],
        );
        checkCharges('(c) `keyOf: refKeyOf`', pay.chargeCount(), 1, 1);
        checkSeq(
            '(c) replayed? per request — run 1 is requests 1-3, the re-drive is request 4',
            pay.replays(),
            // Request 1 creates the charge and is lost; 2 and 3 are served from the record and are
            // ALSO lost (so run 1 fails outright); the re-drive's first request is served from the
            // record and comes back, because only requests 1-3 were configured lost.
            [false, true, true, true],
        );
        note(
            '(c) the re-driven job',
            'was handed the ORIGINAL charge id, not a new charge',
        );
    }

    // ── (d) THE FOOTGUN: a config round-trip silently drops `keyOf` ──────────────────────────
    // `keyOf` is function sugar. `redactConfig` strips every function-valued field so `__config`
    // round-trips as JSON (stitch.ts:936-940). The `idempotency` SLOT survives — as `{}` — so the
    // rebuilt stitch still has idempotency ON, with the random default. Everything reads correct.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        const declared = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: { keyOf: refKeyOf },
            retry: { attempts: 2 },
            clock,
        });
        const published = JSON.parse(
            JSON.stringify(
                (declared as unknown as { __config: unknown }).__config,
            ),
        ) as Partial<StitchConfig>;

        check(
            '(d) `__config.idempotency` after the round-trip',
            JSON.stringify(published.idempotency),
            '{}',
        );
        check(
            '(d) does the slot still LOOK configured?',
            published.idempotency !== undefined,
            true,
        );

        const rebuilt = stitch({
            ...published,
            adapter: pay.adapter(),
            clock,
        }) as Stitch;
        await rebuilt({ body: PAYMENT }).safe();
        await rebuilt({ body: PAYMENT }).safe();

        check(
            '(d) DISTINCT keys from the rebuilt stitch, called twice',
            pay.distinctKeys(),
            2,
        );
        checkCharges('(d) rebuilt from `__config`', pay.chargeCount(), 1, 2);
        note(
            '(d) what warned',
            'nothing — the construction nudge only fires for a random key with NO `retry`, and `retry` survived the round-trip',
        );
    }

    finish(
        'C2',
        'the DEFAULT key is NOT restart-stable and not even call-stable — it is `randomUUID()` per call, so a re-driven job created 2 charges for 1 intended payment under `idempotency: true` + `retry`; `keyOf` fixes it (1 key, 1 charge) but is STRIPPED by a `__config` JSON round-trip, which silently restores the double charge',
    );
}

void main();
