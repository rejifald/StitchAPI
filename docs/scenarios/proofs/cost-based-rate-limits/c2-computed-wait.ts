// C2 — can the retry WAIT be computed from the response body, i.e. Shopify's own
// `(requestedQueryCost - currentlyAvailable) / restoreRate`, instead of a backoff curve?
//
// Arrival times are measured in VIRTUAL ms off `manualClock()`, so the gaps below are exact.
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c2-computed-wait.ts
import { graphql, stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { RetryOptions } from '../../../../packages/core/src/types';
import { FakeShopify, costOfBody, deficitWaitMs } from './fake-shopify';
import { check, checkNear, finish, heading, note } from './harness';

const DOC = 'query BigSync { products { id } }';

function emptyShop(cost: number): {
    shop: FakeShopify;
    clock: ReturnType<typeof manualClock>;
} {
    const clock = manualClock();
    const shop = new FakeShopify({ clock, costs: { BigSync: cost } });
    shop.drain(1000);
    return { shop, clock };
}

/** Gaps (ms) between successive requests, in virtual time. */
const gaps = (shop: FakeShopify): number[] =>
    shop.calls.slice(1).map((c, i) => c.at - (shop.calls[i]?.at ?? 0));

async function main(): Promise<void> {
    heading('C2 — can the retry wait be COMPUTED from the body?');

    // ── (a) is there a function form of `backoff` anywhere? ────────────────────────────────────
    // `backoff?: BackoffCurve | AtLeastOne<BackoffOptions>` (types.ts:991) — `BackoffOptions` is
    // `{ curve, base, max }` (types.ts:967-974). No arm of that union is callable. The
    // `@ts-expect-error` below is the PROOF: this file typechecks only if the line IS an error.
    {
        // @ts-expect-error — a delay function is not assignable to `backoff`; there is no such form.
        const rejected: RetryOptions = { attempts: 2, backoff: () => 6000 };
        void rejected;
        check('(a) `backoff: () => ms` is a TYPE ERROR', true, true);
    }

    // ── (a2) and if you cast past it, construction THROWS ──────────────────────────────────────
    // The shorthand fold in `stitch()` normalises `backoff` onto `{ curve }`, so a cast-through
    // function lands on `curve`, matches no valid curve, and dies with `Error: bad backoff`
    // before any request exists (stitch.ts:234-257). That is #666, filed from this audit as
    // #651 §3: it used to construct clean and silently degrade to the default `expo-jitter`/100ms
    // curve, the function never called — measured then as gaps of ~100, ~200ms where the config
    // asked for 6000, with no throw and no warning.
    {
        const { shop, clock } = emptyShop(300);
        let invoked = 0;
        const sneaky = (): number => {
            invoked++;
            return 6000;
        };
        let died: unknown;
        try {
            graphql({
                url: 'https://shop.myshopify.com/admin/api/graphql.json',
                document: DOC,
                adapter: shop.adapter(),
                clock,
                // The cast is the point: this is what "I got past the type error" looks like.
                retry: { attempts: 3, on: 200, backoff: sneaky } as unknown as {
                    attempts: number;
                    on: number;
                    backoff: 'fixed';
                },
            });
        } catch (e) {
            died = e;
        }
        check(
            '(a2) construction threw',
            died instanceof Error ? died.message : String(died),
            'bad backoff',
        );
        check('(a2) requests made before it threw', shop.calls.length, 0);
        check('(a2) the delay function was invoked', invoked, 0);
    }

    // ── (b) what the curve waits vs. what Shopify said to wait ────────────────────────────────
    // Cost 300, bucket 0, restore 50/s → the server's own arithmetic says 6000ms. `fixed`/100ms
    // waits 100ms, so every retry throttles again.
    {
        const { shop, clock } = emptyShop(300);
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 100 },
            },
        });
        const p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check('(b) attempts made', shop.calls.length, 3);
        check('(b) ALL of them throttled', shop.throttledCount, 3);
        check('(b) curve gap (ms)', gaps(shop).join(','), '100,100');
        const cost = costOfBody((r.error?.body ?? null) as unknown);
        note('(b) error body carried extensions.cost', cost !== undefined);
        checkNear(
            '(b) the wait Shopify prescribed (ms)',
            deficitWaitMs({
                requestedQueryCost: 300,
                actualQueryCost: null,
                throttleStatus: {
                    maximumAvailable: 1000,
                    currentlyAvailable: 0,
                    restoreRate: 50,
                },
            }),
            6000,
        );
    }

    // ── (c) a HAND-COMPUTED constant works — for exactly one query cost ────────────────────────
    // `fixed`/6000 succeeds on attempt 2 when the cost is 300. Change the cost to 900 and the same
    // config throttles again: a constant cannot track a per-query deficit.
    {
        const { shop, clock } = emptyShop(300);
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 6000, max: 60_000 },
            },
        });
        const p = call.safe();
        await clock.advance(60_000);
        await p;
        check(
            '(c) cost 300 + fixed 6000 — throttled once',
            shop.throttledCount,
            1,
        );
        // …and then it KEEPS GOING. `on: 200` matches the successful response too, so the loop
        // runs the full 3 attempts and the shop is charged twice for one logical result.
        check('(c) requests made (attempts: 3)', shop.calls.length, 3);
        check('(c) points charged for ONE result', shop.pointsCharged, 600);
    }
    {
        const { shop, clock } = emptyShop(900); // a pricier query, same config
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 6000, max: 60_000 },
            },
        });
        const p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check(
            '(c2) cost 900 + the SAME fixed 6000 — all throttled',
            shop.throttledCount,
            3,
        );
        check('(c2) call failed', r.ok, false);
        note('(c2) correct wait would have been (ms)', ((900 - 0) / 50) * 1000);
    }

    // ── (d) `retry.respect` — Shopify sends no Retry-After header, so it is inert ──────────────
    {
        const { shop, clock } = emptyShop(300);
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 2,
                on: 200,
                respect: true,
                backoff: { curve: 'fixed', base: 100 },
            },
        });
        const p = call.safe();
        await clock.advance(60_000);
        await p;
        // Probe the throttled response's headers on a SEPARATE shop, so this measurement does not
        // pollute the arrival-time recording above.
        const probe = emptyShop(300);
        const throttledRes = await probe.shop.adapter()({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            method: 'POST',
            headers: {},
            body: { operationName: 'BigSync' },
        });
        check(
            '(d) Retry-After present on the throttled response',
            Object.keys(throttledRes.headers).includes('retry-after'),
            false,
        );
        check(
            '(d) respect:true still waited the curve (ms)',
            gaps(shop).join(','),
            '100',
        );
    }

    // ── (e) THE ONE DOOR: a surface's `SurfaceOutcome.after` IS a computed wait ────────────────
    // `interpret` runs inside the attempt loop (engine.ts:775) and its retry arm honours
    // `after` via `parseDuration(outcome.after)` (engine.ts:798). A surface author can therefore
    // return the number the body dictates. This is the seam C6 builds on.
    {
        const { shop, clock } = emptyShop(300);
        const waits: number[] = [];
        // The `id` must be a LITERAL type, not widened to `string`: the config guards key off
        // `kind: { id: '…' }`, and a widened `string` matches every one of them (see C6 (e2)).
        const costSurface: Surface & { readonly id: 'shopify-cost' } = {
            id: 'shopify-cost',
            interpret: (res) => {
                const cost = costOfBody(res.body);
                if (cost && cost.actualQueryCost === null) {
                    const after = deficitWaitMs(cost);
                    waits.push(after);
                    return {
                        ok: false,
                        retry: true,
                        message: 'THROTTLED',
                        after,
                    };
                }
                return { ok: true, data: res.body };
            },
        };
        const call = stitch({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            method: 'POST',
            kind: costSurface,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const p = call.safe({ body: { operationName: 'BigSync' } });
        await clock.advance(60_000);
        const r = await p;
        check('(e) surface asked for a computed wait', waits.length, 1);
        checkNear('(e) the wait it asked for (ms)', waits[0] ?? -1, 6000);
        check(
            '(e) the engine HONOURED it — gap (ms)',
            gaps(shop).join(','),
            '6000',
        );
        check('(e) succeeded on attempt 2', r.ok, true);
        check('(e) requests made', shop.calls.length, 2);
    }

    finish(
        'C2',
        '`backoff` has NO function form (type error; a cast past it throws `bad backoff` at construction since #666, filed from this audit as #651 §3) and `retry.respect` reads a HEADER Shopify never sends — but `SurfaceOutcome.after` on a custom surface IS honoured as a computed wait',
    );
}

void main();
