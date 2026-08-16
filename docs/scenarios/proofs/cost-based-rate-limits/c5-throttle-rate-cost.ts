// C5 — can `throttle.rate` express a COST budget (1000 points, refilling 50/s) rather than a
// request rate? Its own doc comment says it is *"a minimum spacing between successive calls …
// not a token bucket"* (types.ts:1006-1019). This measures what that costs you in throughput
// when you try to approximate a bucket with a spacing.
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c5-throttle-rate-cost.ts
import { graphql } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { ThrottleOptions } from '../../../../packages/core/src/types';
import { FakeShopify } from './fake-shopify';
import { check, finish, heading, note } from './harness';

const URL = 'https://shop.myshopify.com/admin/api/graphql.json';

/** Fire `n` calls concurrently, advance virtual time, and return their arrival times (ms). */
async function fire(
    shop: FakeShopify,
    clock: ReturnType<typeof manualClock>,
    n: number,
    throttle: string | ThrottleOptions,
    document: string,
): Promise<number[]> {
    const call = graphql({
        url: URL,
        document,
        adapter: shop.adapter(),
        clock,
        throttle: throttle as string,
    });
    const p = Promise.all(Array.from({ length: n }, () => call.safe()));
    await clock.advance(600_000);
    await p;
    return shop.calls.map((c) => c.at);
}

async function main(): Promise<void> {
    heading('C5 — can throttle.rate express a cost budget?');

    // ── (a) the unit is REQUESTS, and it is a string grammar with no room for points ───────────
    {
        // @ts-expect-error — a bare number is rejected outright (types.ts:1021-1025).
        const asNumber: ThrottleOptions = { rate: 1000 };
        void asNumber;
        // `rate` is a plain `string`, so a points-denominated token TYPECHECKS — and then throws
        // at construction, because `parseRate` fails loud rather than falling back to "no limit"
        // (types.ts:1026-1030). There is no cost form; the grammar is `<count>/<duration>`.
        const asPoints: ThrottleOptions = { rate: '1000points/50s' };
        let threw: string | undefined;
        try {
            graphql({
                url: URL,
                document: 'query Q { a }',
                adapter: new FakeShopify({ clock: manualClock() }).adapter(),
                throttle: asPoints as { rate: string },
            });
        } catch (e) {
            threw = (e as Error).message;
        }
        check(
            '(a) a points-denominated rate THROWS at construction',
            threw !== undefined,
            true,
        );
        note('(a) the error', threw);
    }

    // ── (b) it reads only the RATIO — window length is not a burst allowance ───────────────────
    // A bucket's defining feature is that it can spend 1000 points AT ONCE. `'10/10s'` looks like
    // it should permit 10 immediately; it does not — it is a 1000ms spacing, same as `'1/s'`.
    {
        const clockA = manualClock();
        const shopA = new FakeShopify({ clock: clockA, defaultCost: 100 });
        const a = await fire(shopA, clockA, 4, '10/10s', 'query Q { a }');

        const clockB = manualClock();
        const shopB = new FakeShopify({ clock: clockB, defaultCost: 100 });
        const b = await fire(shopB, clockB, 4, '1/s', 'query Q { a }');

        check('(b) "10/10s" arrival times', a.join(','), '0,1000,2000,3000');
        check('(b) "1/s"    arrival times', b.join(','), a.join(','));
        note(
            '(b) → a 10-call burst the bucket would have allowed is spread over 3s',
            '',
        );
    }

    // ── (c) the throughput a spacing costs you ────────────────────────────────────────────────
    // Cost 100/query, bucket 1000, restore 50/s. The BUCKET permits 10 queries at t=0. The
    // safest spacing that never outruns the refill is 100 points / 50 per sec = one call per 2s.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, defaultCost: 100 });
        const times = await fire(shop, clock, 10, '1/2s', 'query Q { a }');
        check('(c) 10 calls, none throttled', shop.throttledCount, 0);
        check(
            '(c) last arrival under `1/2s` (ms)',
            times[times.length - 1],
            18_000,
        );

        // The same 10 calls with NO throttle: the bucket absorbs them instantly.
        const clock2 = manualClock();
        const shop2 = new FakeShopify({ clock: clock2, defaultCost: 100 });
        const call2 = graphql({
            url: URL,
            document: 'query Q { a }',
            adapter: shop2.adapter(),
            clock: clock2,
        });
        const p2 = Promise.all(Array.from({ length: 10 }, () => call2.safe()));
        await clock2.advance(0);
        await p2;
        check(
            '(c) …the bucket alone would have taken all 10 at once',
            shop2.throttledCount,
            0,
        );
        check('(c) last arrival with NO throttle (ms)', shop2.calls[9]?.at, 0);
        note(
            '(c) cost of approximating a bucket with a spacing',
            '18s vs 0s for the same work',
        );
    }

    // ── (d) with MIXED costs there is no single correct spacing ───────────────────────────────
    // Size it for the expensive query (900 pts → one per 18s) and cheap queries crawl.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, defaultCost: 11 }); // cheap queries
        const times = await fire(shop, clock, 5, '1/18s', 'query Cheap { a }');
        check(
            '(d) 5 cheap (11-pt) calls sized for the 900-pt query — last arrival (ms)',
            times[4],
            72_000,
        );
        check('(d) points actually spent', shop.pointsCharged, 55);
        note('(d) → 55 points spread over 72s; the bucket holds 1000', '');
    }

    // ── (d2) size it for the AVERAGE cost instead, and the expensive queries throttle ──────────
    // The mixed workload averages (11 + 900) / 2 ≈ 455 points, so the "fair" spacing is
    // 455 / 50 ≈ one call per 9s. A run of 900-point queries at that spacing spends 100 pts/s
    // against a 50 pts/s refill: the bucket drains and the throttle the pacing existed to
    // prevent happens anyway.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, defaultCost: 900 });
        const times = await fire(shop, clock, 4, '1/9s', 'query Big { a }');
        // t=0 accept (1000→100) · t=9s refill 450 → 550 < 900 THROTTLE · t=18s refill to the
        // 1000 cap → accept · t=27s → 550 THROTTLE. Half the calls fail, on a limiter that was
        // paced precisely to prevent that.
        check(
            '(d2) 4 expensive calls paced at the AVERAGE — throttled',
            shop.throttledCount,
            2,
        );
        check('(d2) …got through', shop.calls.length - shop.throttledCount, 2);
        note('(d2) arrival times (ms)', times.join(','));
        note(
            '(d2) → pacing for the average under-waits; pacing for the worst case is (d)',
            'no single spacing is correct for both',
        );
    }

    finish(
        'C5',
        '`throttle.rate` cannot express a cost budget: the unit is requests, the grammar is a string with no points form, and it is a minimum SPACING with no burst — approximating the 1000-point bucket costs 18s for work the bucket takes instantly, and with mixed costs no single spacing is correct',
    );
}

void main();
