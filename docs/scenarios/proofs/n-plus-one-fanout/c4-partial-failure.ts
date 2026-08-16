// C4 — one customer was deleted. Do the other 99 survive, and can you tell WHICH one failed?
//
// `Promise.all` rejects on the first failure AND discards the results that already succeeded. That
// is the standard warning, and this scenario is where it costs the most: the 99 good rows were
// fetched, paid for, and thrown away because a hundredth id 404ed.
//
// MEASURED: `.safe()` per call fixes it completely, and the failing id is identifiable four ways —
// but two of the four depend on things outside the config.
//   (a) bare `Promise.all` over throwing calls → 1 rejection, 0 rows kept, and ALL 100 requests
//       still went out. The quota was spent and nothing was retained.
//   (b) `.safe()` per call → 99 rows kept, 1 error, and the array INDEX still lines up with the
//       input, so the failing order row is identifiable with no extra bookkeeping.
//   (c) `Promise.allSettled` over throwing calls is the same outcome with more ceremony.
//   (d) The error is well-furnished: `status: 404`, `attempts: 1`, `body` carrying the vendor's
//       `{ error, id }`, and `url` naming the exact resource.
//   (e) …but `url` is COPIED OFF THE ADAPTER RESPONSE (stitch.ts `rebuildError`), so a transport
//       that does not echo it leaves `error.url` undefined and the error self-identifies only if
//       the vendor's BODY happens to name the id.
//   (f) `all()`'s auto-cancel bought nothing: the losers had already left. 100 requests, 0 rows.
//   (g) `verdict: { accept: [404] }` does not classify the miss — it SUCCEEDS on it, and hands the
//       error envelope back as the customer.
//   (h) A 429 id burns its whole retry budget while the other 99 are long done: 3 requests for the
//       doomed id, and `.safe()` still keeps the 99.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c4-partial-failure.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    SafeResult,
    StitchError,
} from '../../../../packages/core/src/types';
import { type Customer, FakeVendor, idsOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { runOut } from './virtual-time';

const BASE = 'https://api.vendor.test';
const ORDERS = 100;
const HOLD = 50;
/** The customer someone deleted. Position 49 in the list, so "index 49" is a real coordinate. */
const DEAD = 'cust-050';

function context(
    opts: { echoUrl?: boolean; notFound?: readonly string[] } = {},
) {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: ORDERS,
        customers: ORDERS,
        holdMs: HOLD,
        notFound: opts.notFound ?? [DEAD],
        ...(opts.echoUrl === undefined ? {} : { echoUrl: opts.echoUrl }),
    });
    const call = stitch<Customer>({
        name: 'customer',
        url: `${BASE}/customers/{id}`,
        adapter: vendor.adapter(),
        clock,
    });
    return { clock, vendor, call };
}

async function main(): Promise<void> {
    heading(
        `C4 — ${String(ORDERS)} lookups, one of them a deleted customer (${DEAD})`,
    );

    // ── (a) the one-liner everyone writes ──────────────────────────────────────────────────────
    {
        const { clock, vendor, call } = context();
        let kept = 0;
        let failure = '';
        const pending = Promise.all(
            idsOf(vendor.orders).map((id) => call({ params: { id } })),
        ).then(
            (rows) => {
                kept = rows.length;
            },
            (e: Error) => {
                failure = e.message;
            },
        );
        await runOut(clock, 20_000, 1_000);
        await pending;

        check('(a) `Promise.all` rejected with', failure, 'HTTP 404');
        check('(a) rows the caller kept', kept, 0);
        check(
            '(a) requests that still reached the server',
            vendor.customerRequests,
            100,
        );
        check(
            '(a) customers successfully fetched and discarded',
            vendor.customerCalls.filter((c) => c.status === 200).length,
            99,
        );
    }

    // ── (b) `.safe()` per call ─────────────────────────────────────────────────────────────────
    // The whole fix, and it is one method call. `SafeResult` is a discriminated union, so the
    // survivors narrow to `Customer` without a cast.
    {
        const { clock, vendor, call } = context();
        const ids = idsOf(vendor.orders);
        const pending = ids.map((id) => call({ params: { id } }).safe());
        await runOut(clock, 20_000, 1_000);
        const results: SafeResult<Customer>[] = await Promise.all(pending);
        const failedAt = results.flatMap((r, i) => (r.ok ? [] : [i]));

        check('(b) rows kept', results.filter((r) => r.ok).length, 99);
        check(
            '(b) failures',
            results.length - results.filter((r) => r.ok).length,
            1,
        );
        checkSeq('(b) INDEX of the failure', failedAt, [49]);
        check(
            '(b) …which the caller maps back to an id with the input array',
            ids[failedAt[0] ?? -1],
            DEAD,
        );
        check('(b) requests made', vendor.customerRequests, 100);
        note(
            '(b) → order is positional and preserved (see C7)',
            'so `results[i]` belongs to `orders[i]` and no correlation key is needed',
        );
    }

    // ── (c) `Promise.allSettled` over the throwing form ────────────────────────────────────────
    {
        const { clock, vendor, call } = context();
        const pending = Promise.allSettled(
            idsOf(vendor.orders).map((id) => call({ params: { id } })),
        );
        await runOut(clock, 20_000, 1_000);
        const settled = await pending;
        check(
            '(c) fulfilled',
            settled.filter((s) => s.status === 'fulfilled').length,
            99,
        );
        checkSeq(
            '(c) index of the rejection',
            settled.flatMap((s, i) => (s.status === 'rejected' ? [i] : [])),
            [49],
        );
        check(
            '(c) the rejection reason is a StitchError',
            settled
                .flatMap((s) =>
                    s.status === 'rejected' ? [s.reason as Error] : [],
                )
                .map((e) => e.name)
                .join(),
            'StitchError',
        );
        void vendor;
    }

    // ── (d) is the failing id identifiable FROM THE ERROR? ─────────────────────────────────────
    {
        const { clock, vendor, call } = context();
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        const results = await Promise.all(pending);
        const err = results.flatMap((r) =>
            r.ok ? [] : [r.error],
        )[0] as StitchError;

        check('(d) error.status', err.status, 404);
        check('(d) error.attempts', err.attempts, 1);
        check('(d) error.url', err.url, `${BASE}/customers/${DEAD}`);
        check(
            '(d) error.body names the id',
            (err.body as { id?: string }).id,
            DEAD,
        );
        check('(d) error.message', err.message, 'HTTP 404');
        note(
            '(d) → the message alone is useless and everything else is enough',
            '`HTTP 404` is identical for all 100; `url`, `body` and the array index each name the row',
        );
    }

    // ── (e) …but `url` comes from the TRANSPORT, not the engine ───────────────────────────────
    // `rebuildError` copies `url: res.url` off the adapter response. `fetchAdapter` sets it
    // (http-adapter.ts:98,111,145); a hand-written adapter, a mock, or a custom transport may not.
    {
        const { clock, vendor, call } = context({ echoUrl: false });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        const results = await Promise.all(pending);
        const err = results.flatMap((r) =>
            r.ok ? [] : [r.error],
        )[0] as StitchError;

        check(
            '(e) error.url with a transport that omits it',
            err.url,
            undefined,
        );
        check(
            '(e) error.body still names the id (vendor-dependent)',
            (err.body as { id?: string }).id,
            DEAD,
        );
        check('(e) rows still kept', results.filter((r) => r.ok).length, 99);
        void vendor;
        note(
            '(e) → two of the four identifiers are outside your control',
            '`url` needs the ADAPTER to echo it and `body` needs the VENDOR to name the id; the array index is the only one that always works',
        );
    }

    // ── (f) the combinator's auto-cancel does not save the requests ────────────────────────────
    // `all()` aborts the losers on the first failure (pipe.ts:114-117). In a fan-out they have all
    // already left, so the cancel saves nothing and the fail-fast still costs the 99 rows.
    {
        const { clock, vendor } = context();
        const adapter = vendor.adapter();
        const members = idsOf(vendor.orders).map((id) =>
            stitch<Customer>({
                name: `customer:${id}`,
                url: `${BASE}/customers/${id}`,
                adapter,
                clock,
            }),
        );
        let kept = 0;
        let failure = '';
        const { all } = await import('../../../../packages/core/src/pipe');
        const pending = all(members)().then(
            (rows) => {
                kept = (rows as unknown[]).length;
            },
            (e: Error) => {
                failure = e.message;
            },
        );
        await runOut(clock, 20_000, 1_000);
        await pending;
        check('(f) `all()` rejected with', failure, 'HTTP 404');
        check('(f) rows kept', kept, 0);
        check(
            '(f) requests the auto-cancel prevented',
            100 - vendor.customerRequests,
            0,
        );
    }

    // ── (g) the `verdict.accept` trap ──────────────────────────────────────────────────────────
    // The reflex for "a 404 is not really an error here" is `verdict: { accept: [404] }`. It does
    // not classify the miss; it makes it a SUCCESS whose `data` is the vendor's error envelope.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: ORDERS,
            customers: ORDERS,
            holdMs: HOLD,
            notFound: [DEAD],
        });
        const call = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            verdict: { accept: [404] },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        const results = await Promise.all(pending);
        const row = results[49];

        check(
            '(g) calls reported as failures',
            results.filter((r) => !r.ok).length,
            0,
        );
        check('(g) the deleted customer reported as ok', row?.ok, true);
        check(
            '(g) …and its `data` is the vendor error envelope',
            JSON.stringify(row?.ok === true ? row.data : null),
            JSON.stringify({ error: 'customer_not_found', id: DEAD }),
        );
        note(
            '(g) → `customer.name` is now `undefined` and nothing said so',
            'the join writes a row with a missing name rather than a row flagged as missing',
        );
    }

    // ── (h) a rate-limited id burns its retry budget alone ─────────────────────────────────────
    // 429 IS in the default `retry.on` set (engine.ts:612), so one permanently-throttled id costs
    // its full attempt budget while the other 99 finished on their first try. `.safe()` still keeps
    // the 99, which is the point.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: ORDERS,
            customers: ORDERS,
            holdMs: HOLD,
            rateLimited: [DEAD],
        });
        const call = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            retry: { attempts: 3, backoff: { curve: 'fixed', base: '1s' } },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 60_000, 1_000);
        const results = await Promise.all(pending);

        check('(h) rows kept', results.filter((r) => r.ok).length, 99);
        check('(h) requests for the throttled id', vendor.requestsFor(DEAD), 3);
        check(
            '(h) requests for a healthy id',
            vendor.requestsFor('cust-001'),
            1,
        );
        check('(h) total requests', vendor.customerRequests, 102);
        check(
            '(h) attempts on the surfaced error',
            results.flatMap((r) => (r.ok ? [] : [r.error.attempts]))[0],
            3,
        );
    }

    finish(
        'C4',
        "SOLVED, by `.safe()`, and the failing row is identifiable four ways. Bare `Promise.all` behaved exactly as advertised: rejected with `HTTP 404`, kept ZERO rows — and all 100 requests still reached the server, so 99 customers were fetched, paid for and discarded. `.safe()` per call kept 99 rows and 1 error with no other change, and because the results array is positional the failure is at INDEX 49, which maps straight back to the order row. `Promise.allSettled` over the throwing form gives the same outcome with more ceremony (the reason is a real `StitchError`). The error is well-furnished — `status: 404`, `attempts: 1`, `body: { error: 'customer_not_found', id: 'cust-050' }`, `url: .../customers/cust-050` — while the MESSAGE is the useless `HTTP 404`, identical for all hundred. TWO OF THE FOUR IDENTIFIERS ARE NOT THE LIBRARY'S TO GIVE: `url` is copied off the ADAPTER response (`rebuildError`, stitch.ts), so a transport that does not echo it measured `error.url === undefined`, and `body` only names the id because this vendor does. The array index is the only identifier that always holds. Three things worth stating plainly. `all()`'s auto-cancel (pipe.ts:114-117) prevented ZERO requests — the losers had already left — so fail-fast costs the 99 rows and saves nothing. `verdict: { accept: [404] }` does NOT classify the miss: it reported the deleted customer as `ok: true` with the vendor's error envelope as `data`, so the join silently writes a row with no name. And a permanently-429ed id burns its full budget alone (3 requests against 1 for every healthy id, 102 total, `attempts: 3` on the error) while `.safe()` keeps the other 99",
    );
}

void main();
