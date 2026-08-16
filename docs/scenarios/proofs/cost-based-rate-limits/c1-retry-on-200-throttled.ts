// C1 — can the BUILT-IN `retry` fire on an HTTP 200 carrying `errors[].extensions.code ===
// 'THROTTLED'`? Every spelling on the public surface is tried here, and each one is measured by
// counting the requests the fake shop actually received.
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c1-retry-on-200-throttled.ts
import { graphql, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StatusMatch } from '../../../../packages/core/src/types';
import { FakeShopify } from './fake-shopify';
import { check, finish, heading, note } from './harness';

const DOC = 'query BigSync { products { id } }';

// A shop whose bucket is already empty, so the very first call is THROTTLED.
function emptyShop(): {
    shop: FakeShopify;
    clock: ReturnType<typeof manualClock>;
} {
    const clock = manualClock();
    const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
    shop.drain(1000); // another app took the whole bucket
    return { shop, clock };
}

async function main(): Promise<void> {
    heading('C1 — can `retry` fire on a 200-with-THROTTLED?');

    // ── (a) the DEFAULT retry set: [429, 502, 503, 504] ────────────────────────────────────────
    {
        const { shop, clock } = emptyShop();
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 5 },
        });
        const r = await call.safe();
        check('(a) default retry.on — requests made', shop.calls.length, 1);
        check('(a) call failed', r.ok, false);
        note('(a) error message', r.error?.message);
    }

    // ── (b) a PREDICATE on `retry.on` — what does it actually receive? ─────────────────────────
    // If the predicate were handed the response it could read `errors[]`. It is not: `acceptsStatus`
    // (resilience.ts:25-32) returns the authored function unchanged and the engine calls it as
    // `retryMatch(res.status)` (engine.ts:743) — one argument, a number.
    {
        const { shop, clock } = emptyShop();
        const received: unknown[][] = [];
        const on = ((...args: unknown[]): boolean => {
            received.push(args);
            return false;
        }) as StatusMatch;
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 5, on },
        });
        await call.safe();
        check('(b) predicate invoked', received.length > 0, true);
        check('(b) arguments handed to retry.on', received[0]?.length, 1);
        check('(b) argument type', typeof received[0]?.[0], 'number');
        check('(b) argument value', received[0]?.[0], 200);
        note('(b) the body was NOT passed', JSON.stringify(received[0] ?? []));
    }

    // ── (c) `retry.on: 200` — it DOES retry, and that is the footgun ───────────────────────────
    // The status matcher runs BEFORE the surface interprets the body (engine.ts:743 vs :775), so
    // `on: 200` cannot distinguish a THROTTLED 200 from a SUCCESSFUL one. It retries BOTH.
    {
        const { shop, clock } = emptyShop();
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 1000 },
            },
        });
        const p = call.safe();
        await clock.advance(10_000);
        await p;
        check('(c) retry.on:200 — requests made', shop.calls.length, 3);
        note('(c) it retried, but only because EVERY 200 matches', 'see (d)');
    }

    // ── (d) the same config against a HEALTHY shop: successes are retried too ──────────────────
    // This is the cost of (c): a call that succeeded on attempt 1 is fired 3 times and the shop is
    // charged 3× the points. Nothing in the config can express "retry only the throttled 200".
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 1000 },
            },
        });
        const p = call.safe();
        await clock.advance(10_000);
        const r = await p;
        check('(d) healthy shop — requests made', shop.calls.length, 3);
        check('(d) all three succeeded', shop.throttledCount, 0);
        check('(d) call ok', r.ok, true);
        check(
            '(d) points the shop was charged for ONE logical call',
            shop.pointsCharged,
            900, // 300 × 3 — the retry charged the shop three times for one result
        );
    }

    // ── (e) `verdict.flag` — a BODY path, and it SILENTLY PASSES A THROTTLE THROUGH ────────────
    // `verdict.flag` is the one built-in that reads the body to decide a verdict, so it is the
    // natural thing to reach for. On Shopify's throttled body it is INERT: the payload has no
    // `data` key at all, and an ABSENT path is "no signal" (surface.ts:181-189), so the status
    // verdict (200) stands. The caller is handed the THROTTLED envelope as a successful result.
    {
        const { shop, clock } = emptyShop();
        const call = stitch({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            method: 'POST',
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 5 },
            verdict: { flag: 'data.ok' },
        });
        const r = await call.safe();
        check('(e) verdict.flag — requests made', shop.calls.length, 1);
        check('(e) the call REPORTED SUCCESS on a throttle', r.ok, true);
        check(
            '(e) …and handed the caller the THROTTLED envelope as data',
            (r.data as { errors?: { message?: string }[] })?.errors?.[0]
                ?.message,
            'Throttled',
        );
    }

    // ── (e2) even when the flag IS present and falsy, it never retries ─────────────────────────
    // A separate minimal body, because Shopify's throttled payload has no falsy flag to point at.
    // `verdictOf` returns `{ ok: false, message, status }` — no `retry` arm (surface.ts:174-191) —
    // so the 5-attempt budget is untouched.
    {
        const clock = manualClock();
        let hits = 0;
        const call = stitch({
            url: 'https://api.example.com/a',
            adapter: async () => {
                hits++;
                return { status: 200, headers: {}, body: { ok: false } };
            },
            clock,
            retry: { attempts: 5 },
            verdict: { flag: 'ok' },
        });
        const r = await call.safe();
        check('(e2) flag present + falsy — call failed', r.ok, false);
        check('(e2) requests made (retry.attempts was 5)', hits, 1);
        note('(e2) message', r.error?.message);
    }

    // ── (f) can an `onResponse` HOOK force a retry by mutating the status? ─────────────────────
    // The hook fires at engine.ts:705, BEFORE the retry check at :743, and receives the live `res`.
    // Mutating `res.status` there does reach the matcher — measured below — but it also rewrites
    // what every later stage sees. This is a hack, not a supported seam; C6 measures the real one.
    {
        const { shop, clock } = emptyShop();
        let hookSawExtensions = false;
        const call = graphql({
            url: 'https://shop.myshopify.com/admin/api/graphql.json',
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 1000 } },
            hooks: {
                onResponse: (ctx) => {
                    const body = ctx.res?.body as
                        { extensions?: unknown } | undefined;
                    if (body?.extensions !== undefined)
                        hookSawExtensions = true;
                    // Rewrite a THROTTLED 200 into a 429 so the DEFAULT retry set matches it.
                    const errs = (
                        ctx.res?.body as
                            | { errors?: { extensions?: { code?: string } }[] }
                            | undefined
                    )?.errors;
                    if (
                        ctx.res &&
                        errs?.some((e) => e.extensions?.code === 'THROTTLED')
                    )
                        ctx.res.status = 429;
                },
            },
        });
        const p = call.safe();
        await clock.advance(10_000);
        const r = await p;
        check(
            '(f) hook saw extensions on the response',
            hookSawExtensions,
            true,
        );
        check(
            '(f) status rewrite DID drive retry — requests',
            shop.calls.length,
            3,
        );
        check('(f) final call still failed', r.ok, false);
        note(
            '(f) final error status (rewritten, not the wire status)',
            r.error?.status,
        );
    }

    finish(
        'C1',
        'no built-in `retry` spelling fires on a 200-with-THROTTLED: `retry.on` is handed the STATUS ONLY (1 arg), `on: 200` cannot tell a throttled 200 from a good one, and `verdict.flag` fails without retrying',
    );
}

void main();
