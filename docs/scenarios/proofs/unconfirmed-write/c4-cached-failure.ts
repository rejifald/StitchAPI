// C4 — the CACHED FAILURE. The vendor stored the outcome of the first request for a key, that
// outcome was a 500, and every later request with that key gets the same 500 forever. Does `retry`
// burn its whole budget against a recording? Can a cached failure be told apart from a fresh one?
//
// MEASURED, and the first half goes the library's way:
//   (a) NOT retried by default. `retry.on` defaults to `[429, 502, 503, 504]` (engine.ts:612) and
//       500 is not in it, so `retry: { attempts: 4 }` produced ONE request. The capture guessed the
//       default might include 500; it does not.
//   (b) But adding 500 to `retry.on` — the natural thing to do, since a 500 usually IS transient —
//       burns every attempt against the recording. 4 attempts, 4 requests, 3 of them served from
//       the record, all four identical. Nothing changed and nothing could have.
//   (c) The replay IS distinguishable on the wire: the vendor sets `Idempotent-Replayed: true`, and
//       `hooks.onResponse` sees it. But `StitchError` carries `status`/`attempts`/`body`/`url` and
//       NO HEADERS, so by the time the failure reaches the caller the marker is gone. A replay
//       marker in the BODY survives; one in a HEADER does not.
//   (d) `Surface.interpret` CANNOT veto a status-driven retry. The retry check (engine.ts:743) sits
//       ABOVE the terminal verdict (engine.ts:775), so `interpret` is not consulted until the last
//       attempt: 4 requests, and only then the message. `retry.on`'s predicate form is no help
//       either — it is handed the STATUS and nothing else (measured: `[[500],[500],[500]]`).
//   (e) What DOES work, in 3 lines: `hooks.onResponse` runs at engine.ts:705, BEFORE the retry
//       check, and it is handed the live `res`. Rewriting `res.status` there when the replay marker
//       is present takes the response out of `retry.on`. Measured: 2 requests instead of 4 — the
//       floor, since a failure cannot be known to be cached until it has been seen twice. It works
//       and it is a hack: the status the caller is then told (409) is the one the hook invented,
//       and only `error.body` still says `card_declined`.
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c4-cached-failure.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
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
const BACKOFF = { curve: 'fixed', base: '2s', max: '10s' } as const;
/** The declined card is stored on request 1; every later request for that key replays it. */
const DECLINED = { failChargeOn: [1], failStatus: 500 } as const;

async function main(): Promise<void> {
    heading(
        'C4 — the vendor replays a stored 500: does `retry` burn its budget against a recording?',
    );

    const rig = (
        extra: Partial<StitchConfig>,
    ): {
        pay: FakePayments;
        call: ReturnType<typeof stitch>;
        clock: ReturnType<typeof manualClock>;
    } => {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, ...DECLINED });
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: { keyOf: refKeyOf },
            clock,
            ...extra,
        });
        return { pay, call, clock };
    };

    // ── (a) is a 500 retried by default? ────────────────────────────────────────────────────
    {
        const { pay, call, clock } = rig({ retry: { attempts: 4 } });
        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check(
            '(a) requests that reached the wire, with `retry: { attempts: 4 }`',
            pay.calls.length,
            1,
        );
        check('(a) status the caller was given', result.error?.status, 500);
        note(
            '(a) why',
            '`retry.on` defaults to [429,502,503,504] (engine.ts:612); 500 is not in it',
        );
        checkCharges(
            '(a) the card was DECLINED, so 0 is the correct outcome',
            pay.chargeCount(),
            1,
            0,
        );
    }

    // ── (b) and if 500 is added to `retry.on`? ──────────────────────────────────────────────
    {
        const { pay, call, clock } = rig({
            retry: {
                attempts: 4,
                on: [429, 500, 502, 503, 504],
                backoff: BACKOFF,
            },
        });
        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check('(b) requests that reached the wire', pay.calls.length, 4);
        checkSeq(
            '(b) status per request',
            pay.statuses(),
            [500, 500, 500, 500],
        );
        checkSeq(
            '(b) replayed? per request — 3 of the 4 were a recording',
            pay.replays(),
            [false, true, true, true],
        );
        check(
            '(b) DISTINCT keys — every attempt hit the same record',
            pay.distinctKeys(),
            1,
        );
        check('(b) attempts reported to the caller', result.error?.attempts, 4);
        note(
            '(b) what the extra 3 attempts changed',
            'nothing — the response was byte-identical each time, by construction',
        );
    }

    // ── (c) can the caller SEE that it was a replay? ────────────────────────────────────────
    {
        const seenHeaders: (string | undefined)[] = [];
        const { call, clock } = rig({
            retry: { attempts: 2, on: [500], backoff: BACKOFF },
            hooks: {
                onResponse: ({ res }) => {
                    seenHeaders.push(res?.headers['idempotent-replayed']);
                },
            },
        });
        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        checkSeq(
            '(c) `Idempotent-Replayed` per response, as hooks.onResponse sees it',
            seenHeaders.map((h) => h ?? '(absent)'),
            ['(absent)', 'true'],
        );
        checkSeq(
            '(c) fields on the StitchError the caller got',
            Object.keys(result.error ?? {}).sort(),
            ['attempts', 'body', 'name', 'status', 'url'],
        );
        check(
            '(c) can the caller read the replay header off the error?',
            'headers' in (result.error ?? {}),
            false,
        );
        check(
            '(c) the BODY does survive to the caller',
            (result.error?.body as { error?: { code?: string } } | undefined)
                ?.error?.code,
            'card_declined',
        );
        note(
            '(c) the rule',
            'a replay marker in a header needs a hook or a custom surface to capture it; one in the body rides `StitchError.body` for free',
        );
    }

    // ── (d) can `Surface.interpret` or a `retry.on` predicate stop the burn? ────────────────
    {
        const replayAware: Surface = {
            id: 'http+replay',
            interpret: (res, cfg) => {
                if (res.headers['idempotent-replayed'] === 'true')
                    return {
                        ok: false,
                        message: 'cached failure replayed — do not retry',
                        status: res.status,
                    };
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const { pay, call, clock } = rig({
            kind: replayAware,
            retry: { attempts: 4, on: [500], backoff: BACKOFF },
        });
        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check(
            '(d) requests, with an `interpret` that rejects every replay',
            pay.calls.length,
            4,
        );
        check(
            '(d) the message DID reach the caller — on the last attempt',
            result.error?.message,
            'cached failure replayed — do not retry',
        );
        note(
            '(d) why it cannot veto',
            'engine.ts:743 (retry on status) runs before engine.ts:775 (the terminal verdict)',
        );

        // …and the predicate form of `retry.on` is handed the status alone.
        const predicateArgs: unknown[][] = [];
        const {
            pay: pay2,
            call: call2,
            clock: clock2,
        } = rig({
            retry: {
                attempts: 3,
                // Typed as the widest thing `retry.on` accepts, then spread with the extra args
                // captured — the point of the measurement is exactly HOW MANY it is handed.
                on: ((...args: unknown[]) => {
                    predicateArgs.push(args);
                    return true;
                }) as (status: number) => boolean,
                backoff: BACKOFF,
            },
        });
        const pending2 = call2({ body: PAYMENT }).safe();
        await runOut(clock2, 60_000);
        await pending2;

        checkSeq(
            '(d) arguments `retry.on`’s predicate receives per call',
            predicateArgs,
            [[500], [500], [500]],
        );
        check('(d) requests under that predicate', pay2.calls.length, 3);
        note(
            '(d) the consequence',
            'no predicate can say “retry a 500 unless it is a replay” — the response is not in scope',
        );
    }

    // ── (e) the seam that DOES work: rewrite the status in `hooks.onResponse` ───────────────
    // Three lines. `onResponse` runs at engine.ts:705, before the retry check, and receives the live
    // response object — so a status it writes there is the status `retry.on` matches against.
    {
        const { pay, call, clock } = rig({
            retry: { attempts: 4, on: [500], backoff: BACKOFF },
            hooks: {
                onResponse: ({ res }) => {
                    if (res?.headers['idempotent-replayed'] === 'true')
                        (res as { status: number }).status = 409;
                },
            },
        });
        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check(
            '(e) requests, with the replay taken out of `retry.on` by the hook (was 4)',
            pay.calls.length,
            // Attempt 1's 500 is genuinely fresh, so it is retried once — correctly. Attempt 2 is
            // the replay, the hook rewrites it, and the loop stops there. The burn is bounded at
            // ONE wasted attempt, which is the least any client-side rule could achieve: you cannot
            // know a failure is cached until you have seen it twice.
            2,
        );
        checkSeq('(e) replayed? per request', pay.replays(), [false, true]);
        check(
            '(e) status the caller was told',
            result.error?.status,
            // The invented one. The real outcome was a 500 (card declined); the caller is handed
            // the hook's 409, and only `error.body` still says `card_declined`.
            409,
        );
        check(
            '(e) `error.body` still carries the truth',
            (result.error?.body as { error?: { code?: string } } | undefined)
                ?.error?.code,
            'card_declined',
        );
        note(
            '(e) the cost',
            'a hook that rewrites `res.status` is lying to every other reader of the response — the trace, the circuit, and the caller, who is told 409 for a declined card',
        );
        checkCharges(
            '(e) declined card, 0 is correct',
            pay.chargeCount(),
            1,
            0,
        );
    }

    finish(
        'C4',
        'a cached 500 is NOT retried by default (1 request under `retry: { attempts: 4 }`) — the capture’s worry does not hold for the default `retry.on`; adding 500 to `retry.on` burns all 4 attempts against the recording, and NOTHING declarative can stop it: `interpret` runs after the retry check (4 requests) and `retry.on`’s predicate sees only the status. The replay marker is visible to `hooks.onResponse` and absent from `StitchError`, which carries no headers',
    );
}

void main();
