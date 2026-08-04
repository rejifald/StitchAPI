// C4 — does `throttle: { delegate: true }` trip on a 200-with-THROTTLED, or is it status-keyed
// too? `throttle.rate`'s own doc comment (types.ts:1018-1019) points here — *"Where a real quota
// needs spending the way the vendor accounts for it, hand the backoff to an outer gate with
// `delegate`"* — so this is the DOCUMENTED escape hatch for exactly this scenario.
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c4-delegate-on-200.ts
import { RateLimitError, graphql } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeShopify, costOfBody } from './fake-shopify';
import { check, finish, heading, note } from './harness';

const DOC = 'query BigSync { products { id } }';
const URL = 'https://shop.myshopify.com/admin/api/graphql.json';

async function main(): Promise<void> {
    heading('C4 — does throttle.delegate trip on a 200-with-THROTTLED?');

    // ── (a) the DEFAULT `on: [429]` — a 200 does not trip it ───────────────────────────────────
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            throttle: { delegate: true },
        });
        const r = await call.safe();
        check('(a) call failed', r.ok, false);
        check(
            '(a) a RateLimitError surfaced',
            r.error instanceof RateLimitError,
            false,
        );
        check(
            '(a) what surfaced instead',
            r.error?.message,
            'GraphQL: Throttled',
        );
        note(
            '(a) → the documented escape hatch does not reach a body-reported quota',
            'delegate is keyed on `rlMatch(res.status)` (engine.ts:731)',
        );
    }

    // ── (b) `on: 200` DOES trip it — and the THROWING path carries the body ────────────────────
    // `RateLimitError` lifts `body`/`url` off the response at construction (resilience.ts:297-298)
    // and keeps the whole `response`. So this IS a route to `extensions.cost` on the failure path.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            throttle: { delegate: true, on: 200 },
        });
        let thrown: unknown;
        try {
            await call();
        } catch (e) {
            thrown = e;
        }
        check(
            '(b) await → a real RateLimitError',
            thrown instanceof RateLimitError,
            true,
        );
        const rle = thrown as RateLimitError;
        check('(b) RateLimitError.status', rle.status, 200);
        const cost = costOfBody(rle.body);
        check(
            '(b) RateLimitError.body carries extensions.cost',
            cost !== undefined,
            true,
        );
        check('(b) …requestedQueryCost', cost?.requestedQueryCost, 300);
        check(
            '(b) …currentlyAvailable',
            cost?.throttleStatus.currentlyAvailable,
            0,
        );
        // No `Retry-After` header exists, so the structured hint the outer gate is meant to use
        // is empty — the number it needs is in the BODY, which the gate must parse itself.
        check('(b) RateLimitError.retryAfter', rle.retryAfter, undefined);
    }

    // ── (b2) …but `.safe()` DOWNGRADES it: the class and the body are both gone ────────────────
    // `consumeSafe` coerces every terminal through `asStitchError` (stitch.ts:738-745), which
    // copies `message` + `status` + `cause` and NOT `body`. `SafeResult.error` is a StitchError by
    // contract, so the RateLimitError survives only as `.cause` — the payload an outer gate needs
    // is one undocumented hop away, and `error.body` reads as "there was no body".
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            throttle: { delegate: true, on: 200 },
        });
        const r = await call.safe();
        check(
            '(b2) safe() → instanceof RateLimitError',
            r.error instanceof RateLimitError,
            false,
        );
        check('(b2) safe() error class', r.error?.name, 'StitchError');
        check('(b2) safe() error.body', r.error?.body, undefined);
        check('(b2) safe() error.status survives', r.error?.status, 200);
        // It is recoverable — but only by reaching through `.cause`.
        const cause = r.error?.cause;
        check(
            '(b2) error.cause IS the RateLimitError',
            cause instanceof RateLimitError,
            true,
        );
        check(
            '(b2) …and error.cause.body has extensions.cost',
            costOfBody((cause as RateLimitError | undefined)?.body)
                ?.requestedQueryCost,
            300,
        );
    }

    // ── (c) …but `on: 200` fires on SUCCESSFUL responses too ───────────────────────────────────
    // `on` is a `StatusMatch` (types.ts:1048), so it cannot see `errors[]`. A perfectly good
    // query is reported to the host as a rate limit, and its `data` is thrown away.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } }); // FULL bucket
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            throttle: { delegate: true, on: 200 },
        });
        let thrown: unknown;
        try {
            await call();
        } catch (e) {
            thrown = e;
        }
        check('(c) the shop accepted the query', shop.throttledCount, 0);
        check(
            '(c) …and the caller still got a RateLimitError',
            thrown instanceof RateLimitError,
            true,
        );
        check(
            '(c) the successful data was discarded',
            (thrown as RateLimitError).body !== undefined &&
                costOfBody((thrown as RateLimitError).body)?.actualQueryCost,
            300, // a perfectly good, fully-paid-for response, reported as a rate limit
        );
        note(
            '(c) the "rate limit" it reported',
            JSON.stringify((thrown as RateLimitError | undefined)?.body),
        );
    }

    // ── (d) delegate also DISABLES self-pacing, as documented ──────────────────────────────────
    // `delegate` skips the acquire entirely (engine.ts:626-628), so a `rate` set alongside it is
    // inert. You cannot keep in-process pacing AND delegate the backoff.
    {
        const clock = manualClock();
        const shop = new FakeShopify({
            clock,
            costs: { Cheap: 1 },
            defaultCost: 1,
        });
        const call = graphql({
            url: URL,
            document: 'query Cheap { shop { id } }',
            adapter: shop.adapter(),
            clock,
            throttle: { delegate: true, rate: '1/s' },
        });
        const p = Promise.all([call.safe(), call.safe(), call.safe()]);
        await clock.advance(0);
        await p;
        const times = shop.calls.map((c) => c.at);
        check('(d) 3 calls at rate 1/s — requests made', shop.calls.length, 3);
        check(
            '(d) all dispatched at the same instant',
            times.join(','),
            '0,0,0',
        );
        note('(d) → `rate` is inert under `delegate`', 'engine.ts:626-628');
    }

    finish(
        'C4',
        'delegate is status-keyed (`on?: StatusMatch`, default [429]) so a 200-THROTTLED never trips it; forcing `on: 200` DOES surface a RateLimitError carrying extensions.cost, but it fires on every successful 200 too and discards the data',
    );
}

void main();
