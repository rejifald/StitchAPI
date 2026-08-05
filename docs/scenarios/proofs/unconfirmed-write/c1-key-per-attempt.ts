// C1 — is the SAME idempotency key sent on every attempt of one call?
//
// If the key were minted per ATTEMPT rather than per call, `retry` would be a charge multiplier: the
// server would see N unrelated writes and create N charges. This is the property everything else
// rests on, so it is measured across a retry with a real backoff, across a transport failure, and
// across the case the whole scenario is about — a response lost AFTER the charge was created.
//
// MEASURED: one key per logical call, reused by every attempt.
//   (a) 3 attempts against 503s → 3 requests, ONE distinct key, 1 charge for 1 intended.
//   (b) THE GOOD RESULT. The server processes the charge and loses the response; the retry replays
//       the STORED 200. 1 charge for 1 intended, and the caller gets the real charge id — the retry
//       turned "outcome unknown" into "outcome known", which is exactly what the key is for.
//   (c) A TRANSPORT failure is retried too — and `retry.on` cannot stop it (see C7). Same key, so
//       the 3 attempts still cost 1 charge.
//   (d) The mechanism: `applyIdempotency` runs inside `buildRequest` (engine.ts:257), once per
//       logical call, and each attempt gets `cloneReq(baseReq)` (engine.ts:261-264,646) — a fresh
//       header object COPIED from a base that already carries the key. Measured through
//       `hooks.onRequest`, which is the only user-visible seam that sees the header.
//   (e) …which is also the property's boundary: PAGINATION calls `buildRequest` per PAGE
//       (engine.ts:936,940), so a paginated stitch mints a fresh key per page. Measured: 3 pages, 3
//       distinct keys. "Once per logical call" is really "once per request BUILD".
//
//   pnpm exec tsx docs/scenarios/proofs/unconfirmed-write/c1-key-per-attempt.ts
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
import type { Payment } from './keys';
import { runOut } from './virtual-time';

const URL_CHARGES = 'https://api.pay.test/v1/charges';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const PAYMENT: Payment = { ref: 'inv-1001', amount: 4999, currency: 'usd' };
/** Fixed and long enough to be unmistakable in the arrival times; `backoff.max` would clamp a bigger one. */
const BACKOFF = { curve: 'fixed', base: '2s', max: '10s' } as const;

async function main(): Promise<void> {
    heading(
        'C1 — three attempts of one call: one key, or three? (three keys = three charges)',
    );

    // ── (a) a plain retry against a failing host ──────────────────────────────────────────────
    // 503 is in `retry.on`'s default set, so all three attempts run. The server creates a charge
    // only on a request it can process; here it fails them all, so the interesting number is the
    // key count.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, failChargeOn: [1, 2, 3] });
        const sent: string[] = [];
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true,
            retry: { attempts: 3, on: [500, 503], backoff: BACKOFF },
            hooks: {
                onRequest: ({ req }) => {
                    sent.push(req?.headers['Idempotency-Key'] ?? '(absent)');
                },
            },
            clock,
        });

        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 30_000);
        const result = await pending;

        check('(a) requests that reached the wire', pay.calls.length, 3);
        check(
            '(a) DISTINCT keys across those 3 attempts',
            pay.distinctKeys(),
            1,
        );
        checkSeq(
            '(a) key seen by hooks.onRequest, per attempt (uuid elided)',
            sent.map((k) => k.slice(0, 8)),
            [sent[0]?.slice(0, 8), sent[0]?.slice(0, 8), sent[0]?.slice(0, 8)],
        );
        checkSeq(
            '(a) arrival time per attempt (virtual seconds from t0)',
            pay.calls.map((c) => (c.at - T0) / 1000),
            [0, 2, 4],
        );
        checkSeq(
            '(a) replayed? per attempt — attempts 2-3 hit the STORED failure',
            pay.replays(),
            [false, true, true],
        );
        check('(a) result.ok — the call failed', result.ok, false);
        note(
            '(a) note',
            'attempts 2 and 3 were served from the record, not processed — that is C4',
        );
    }

    // ── (b) THE CASE: processed, then the response was lost ──────────────────────────────────
    // Request 1 creates the charge and never answers. The per-attempt timeout fires, the engine
    // retries with the SAME key, and request 2 is served the stored 200. One charge, and the caller
    // learns the charge id it would otherwise never have seen.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, loseResponseOn: [1] });
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true,
            retry: { attempts: 3, backoff: BACKOFF },
            timeout: { perAttempt: '5s' },
            clock,
        });

        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check('(b) requests that reached the wire', pay.calls.length, 2);
        check('(b) DISTINCT keys', pay.distinctKeys(), 1);
        checkSeq('(b) replayed? per request', pay.replays(), [false, true]);
        check('(b) the call SUCCEEDED on the replay', result.ok, true);
        check(
            '(b) the caller got the id of the charge request 1 created',
            (result.data as { id?: string } | null)?.id,
            pay.charges[0]?.id,
        );
        checkCharges('(b)', pay.chargeCount(), 1, 1);
        note(
            '(b) the point',
            'the retry recovered the outcome of a request whose response was lost — no query needed',
        );
    }

    // ── (c) a transport failure (connection dies before processing) ──────────────────────────
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, dropBeforeProcessingOn: [1, 2] });
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true,
            retry: { attempts: 3, backoff: BACKOFF },
            timeout: { perAttempt: '5s' },
            clock,
        });

        const pending = call({ body: PAYMENT }).safe();
        await runOut(clock, 60_000);
        const result = await pending;

        check('(c) requests that reached the wire', pay.calls.length, 3);
        check('(c) DISTINCT keys across 3 attempts', pay.distinctKeys(), 1);
        check('(c) the call SUCCEEDED on attempt 3', result.ok, true);
        checkCharges('(c)', pay.chargeCount(), 1, 1);
    }

    // ── (d) the key is applied ONCE, before the loop — and re-applied per attempt is not needed ──
    // A caller-supplied `headers['idempotency-key']` wins (case-insensitively) and is likewise
    // reused by every attempt. That is the seam a job runner that owns its own key ids would use.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock, failChargeOn: [1, 2] });
        const call = stitch({
            method: 'POST',
            url: URL_CHARGES,
            adapter: pay.adapter(),
            idempotency: true,
            retry: { attempts: 2, on: [500], backoff: BACKOFF },
            clock,
        });

        const pending = call({
            body: PAYMENT,
            headers: { 'idempotency-key': 'job-7f3a-attempt-owned' },
        }).safe();
        await runOut(clock, 30_000);
        await pending;

        checkSeq('(d) keys on the wire', pay.keys(), [
            'job-7f3a-attempt-owned',
            'job-7f3a-attempt-owned',
        ]);
        note(
            '(d) mechanism',
            'applyIdempotency skips when a header of that name is already present (engine.ts:165-170)',
        );
    }

    // ── (e) the boundary of "once per call": PAGINATION mints a key per PAGE ─────────────────
    // `buildRequest` is called once per page (engine.ts:936,940), so `applyIdempotency` runs again
    // each time. Harmless for a read; a paginated WRITE surface would be dedupe-free after page 1.
    // Included here because it is the exact edge of the property (a)-(d) establish.
    {
        const clock = manualClock(T0);
        const pay = new FakePayments({ clock });
        let page = 0;
        const call = stitch({
            method: 'POST',
            url: 'https://api.pay.test/v1/charges/search',
            // The fake treats every non-GET as a charge attempt, so these page requests land in
            // its ledger; only the KEYS are read here, which is the whole point of the case.
            adapter: async (req) => {
                page++;
                await pay.adapter()(req);
                return {
                    status: 200,
                    headers: {},
                    body: { items: [page], next: page < 3 ? page : null },
                };
            },
            idempotency: true,
            retry: { attempts: 2 },
            paginate: {
                items: (v: unknown) => (v as { items: unknown[] }).items,
                next: (prev: unknown) => {
                    const p = (prev as { next: number | null }).next;
                    return p === null ? undefined : { query: { p } };
                },
            },
            clock,
        });
        await call({ body: PAYMENT }).safe();

        check('(e) pages fetched', pay.calls.length, 3);
        check('(e) DISTINCT keys across those 3 pages', pay.distinctKeys(), 3);
        note(
            '(e) reading it',
            'the "once per logical call" guarantee is once per REQUEST BUILD, and pagination builds one per page',
        );
    }

    finish(
        'C1',
        'the key is minted ONCE per logical call and every attempt carries it — 3 attempts, 1 distinct key, 1 charge; a response lost after processing was RECOVERED by the retry (stored 200 replayed), and a caller-supplied header wins and is likewise reused. The boundary: pagination builds a request per page, so 3 pages minted 3 distinct keys',
    );
}

void main();
