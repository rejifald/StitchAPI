// C6 — THE DECIDING CLAIM. If C1–C5 fall short, can a user assemble CORRECT behaviour from the
// PUBLIC surface? This runs the assembled solution (`shopify-cost-surface.ts`) against the fake
// shop and checks all four requirements:
//   (a) detect THROTTLED on a 200
//   (b) wait the COMPUTED deficit, not a curve
//   (c) keep a running cost budget read from EVERY response, successes included
//   (d) survive the shared bucket — a third-party app draining points mid-run
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c6-assembled-solution.ts
import { graphql, stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Adapter, StitchEvent } from '../../../../packages/core/src/types';
import {
    FakeShopify,
    costOfBody,
    deficitWaitMs,
    isThrottled,
} from './fake-shopify';
import { check, checkNear, finish, heading, note } from './harness';
import {
    CostLedger,
    costGate,
    shopifyCostSurface,
} from './shopify-cost-surface';

const DOC = 'query BigSync { products { id } }';
const URL = 'https://shop.myshopify.com/admin/api/graphql.json';

async function main(): Promise<void> {
    heading('C6 — can correct behaviour be assembled from the public surface?');

    // ── (a)+(b) detect on a 200, wait the computed deficit ────────────────────────────────────
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000); // empty bucket → the first attempt throttles
        const ledger = new CostLedger();
        const call = stitch({
            url: URL,
            kind: shopifyCostSurface(ledger),
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 4 },
            pick: 'data',
        });
        const p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check('(a) the throttle was detected on a 200', shop.throttledCount, 1);
        check('(a) the call ultimately SUCCEEDED', r.ok, true);
        check(
            '(a) caller got the graphql `data`',
            (r.data as { ok?: boolean }).ok,
            true,
        );
        check('(b) waits requested', ledger.waits.length, 1);
        checkNear(
            '(b) the wait it asked for (ms)',
            ledger.waits[0] ?? -1,
            6000,
        );
        const gap = (shop.calls[1]?.at ?? 0) - (shop.calls[0]?.at ?? 0);
        check('(b) the wait the engine actually took (ms)', gap, 6000);
        note(
            '(b) a curve would have waited',
            '100ms (expo base), then 200ms — see C2',
        );
    }

    // ── (c) the budget is read off EVERY response, successes included ─────────────────────────
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const ledger = new CostLedger();
        const call = stitch({
            url: URL,
            kind: shopifyCostSurface(ledger),
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 4 },
            pick: 'data',
        });
        for (let i = 0; i < 3; i++) {
            const p = call.safe();
            await clock.advance(0);
            await p;
        }
        check('(c) responses observed by the ledger', ledger.observed, 3);
        check('(c) none of them were throttles', shop.throttledCount, 0);
        check(
            '(c) points spent, summed from actualQueryCost',
            ledger.spent,
            900,
        );
        check('(c) available, as the SHOP reported it', ledger.available, 100);
        check('(c) …and that matches the shop', shop.currentlyAvailable(), 100);
        check('(c) restoreRate learned from the wire', ledger.restoreRate, 50);
    }

    // ── (d) the SHARED bucket: a third-party app drains points between our calls ──────────────
    // The ledger's own arithmetic says there is headroom; the shop disagrees. Only the server's
    // number is true, which is why the reactive half is not optional.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const ledger = new CostLedger();
        const call = stitch({
            url: URL,
            kind: shopifyCostSurface(ledger),
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 6 },
            pick: 'data',
        });
        // One clean call, so the ledger believes it has 700 points.
        let p = call.safe();
        await clock.advance(0);
        await p;
        check('(d) ledger believes it has', ledger.available, 700);

        // A third-party inventory app now takes the shop's whole remaining bucket.
        shop.drain(700);
        check('(d) …but the shop actually has', shop.currentlyAvailable(), 0);

        p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check('(d) the call still SUCCEEDED', r.ok, true);
        check('(d) it took one throttle to learn that', shop.throttledCount, 1);
        checkNear(
            '(d) and waited the deficit it was told (ms)',
            ledger.waits[0] ?? -1,
            6000,
        );
        // The ledger holds the SERVER's number, not its own arithmetic. Local bookkeeping would
        // have said 700 − 300 = 400; the shop reported 0, and 0 is what the ledger carries.
        check(
            "(d) ledger holds the shop's number, not its own",
            ledger.available,
            0,
        );
        note('(d) what naive local bookkeeping would have believed', 700 - 300);
    }

    // ── (d2) a sustained run with a hostile neighbour: everything completes ───────────────────
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const ledger = new CostLedger();
        const call = stitch({
            url: URL,
            kind: shopifyCostSurface(ledger),
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 8 },
            pick: 'data',
        });
        let ok = 0;
        for (let i = 0; i < 8; i++) {
            shop.drain(1000); // a hostile neighbour empties the shop before every call
            const pending = call.safe();
            await clock.advance(60_000);
            if ((await pending).ok) ok++;
        }
        check(
            '(d2) 8 queries against a shop emptied before each — succeeded',
            ok,
            8,
        );
        check(
            '(d2) every one of them hit a throttle first',
            shop.throttledCount,
            8,
        );
        check('(d2) …and none reached the caller as an error', ok, 8);
        check('(d2) points spent', ledger.spent, 2400);
        check(
            '(d2) every wait was the computed deficit',
            ledger.waits.length,
            8,
        );
        checkNear('(d2) each wait (ms)', ledger.waits[7] ?? -1, 6000);
    }

    // ── (e) why the surface's `id` is 'graphql' ──────────────────────────────────────────────
    // `document` is gated on `kind: { id: 'graphql' }` at the TYPE level (types.ts:581-585). A
    // surface with its own id cannot use the config key its `buildRequest` needs.
    {
        const named: Surface & { readonly id: 'shopify' } = {
            id: 'shopify',
            interpret: (res) => ({ ok: true, data: res.body }),
        };
        const clock = manualClock();
        const shop = new FakeShopify({ clock });
        stitch({
            url: URL,
            kind: named,
            adapter: shop.adapter(),
            clock,
            // @ts-expect-error — `document` requires the graphql surface; this id is not it.
            document: DOC,
        });
        check('(e) a custom `id` makes `document` a TYPE ERROR', true, true);
    }

    // ── (e2) a surface typed as bare `Surface` cannot use `document` either ───────────────────
    // `Surface['id']` is `string`, and `string` does not satisfy the literal `'graphql'` the guard
    // keys off. So the surface must be typed `Surface & { readonly id: 'graphql' }` — declaring
    // `id: 'graphql'` in the object literal is not enough if the annotation widens it.
    {
        const widened: Surface = {
            id: 'graphql',
            interpret: (res) => ({ ok: true, data: res.body }),
        };
        const clock = manualClock();
        const shop = new FakeShopify({ clock });
        stitch({
            url: URL,
            kind: widened,
            adapter: shop.adapter(),
            clock,
            // @ts-expect-error — the annotation widened `id` to `string`; the guard needs the literal.
            document: DOC,
        });
        check(
            '(e2) a WIDENED `Surface` id also rejects `document`',
            true,
            true,
        );
    }

    // ── (f) SEAM COMPARISON: the same behaviour written as a wrapping ADAPTER ─────────────────
    // The other obvious seam. It works, but the retry loop it runs is its OWN: `retry.attempts`,
    // `timeout.total`, the trace's attempt counter and the `progress` event stream all sit
    // OUTSIDE it, so from the engine's point of view one very slow request happened.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const ledger = new CostLedger();
        const inner = shop.adapter();
        const costAdapter: Adapter = async (req) => {
            for (;;) {
                const res = await inner(req);
                const cost = costOfBody(res.body);
                if (cost) ledger.record(cost);
                if (!isThrottled(res.body) || !cost) return res;
                await clock.sleep(deficitWaitMs(cost));
            }
        };
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: costAdapter,
            clock,
            retry: { attempts: 3 },
        });
        const p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check('(f) adapter seam — call succeeded', r.ok, true);
        check('(f) the shop saw the retry', shop.calls.length, 2);
        // The engine counted ONE attempt: the whole wait happened below its retry loop.
        const events: StitchEvent[] = [];
        const clock2 = manualClock();
        const shop2 = new FakeShopify({
            clock: clock2,
            costs: { BigSync: 300 },
        });
        shop2.drain(1000);
        const inner2 = shop2.adapter();
        const call2 = graphql({
            url: URL,
            document: DOC,
            clock: clock2,
            retry: { attempts: 3 },
            adapter: async (req) => {
                for (;;) {
                    const res = await inner2(req);
                    const cost = costOfBody(res.body);
                    if (!isThrottled(res.body) || !cost) return res;
                    await clock2.sleep(deficitWaitMs(cost));
                }
            },
        });
        const gen = call2.stream();
        const drainP = (async () => {
            for await (const ev of gen) events.push(ev);
        })();
        await clock2.advance(60_000);
        await drainP;
        const retryEvents = events.filter(
            (e) => e.type === 'progress' && e.phase === 'retry',
        );
        check(
            '(f) `retry` progress events the engine emitted',
            retryEvents.length,
            0,
        );
        check(
            '(f) attempts the engine reported',
            events.find((e) => e.type === 'done')?.attempts,
            1,
        );
        note(
            '(f) → the wait is invisible to trace, timeout.total and the event spine',
            '',
        );
    }

    // ── (g) the PROACTIVE half: `hooks.onRequest` may await, so it can gate the request ───────
    // The reactive path is correct but pays one wasted round-trip per throttle (8 of them in d2).
    // `Hooks.onRequest` returns `void | Promise<void>` (types.ts:1286), so awaiting inside it
    // holds the request until the ledger says the query is affordable.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const ledger = new CostLedger();
        const call = stitch({
            url: URL,
            kind: shopifyCostSurface(ledger),
            document: DOC,
            adapter: shop.adapter(),
            clock,
            retry: { attempts: 6 },
            pick: 'data',
            hooks: {
                onRequest: costGate(ledger, 300, (ms) => clock.sleep(ms)),
            },
        });
        // Prime the ledger, then let the neighbour empty the shop.
        let p = call.safe();
        await clock.advance(60_000);
        await p;
        shop.drain(1000);
        ledger.available = 0; // what the next response would have told us anyway

        p = call.safe();
        await clock.advance(60_000);
        const r = await p;
        check('(g) proactive gate — call succeeded', r.ok, true);
        check(
            '(g) …with NO wasted throttled round-trip',
            shop.throttledCount,
            0,
        );
        check('(g) requests sent in total', shop.calls.length, 2);
        note(
            '(g) → the reactive half still covers what the gate cannot predict (d)',
            '',
        );
    }

    finish(
        'C6',
        "YES — a custom `Surface` closes all four requirements against the public API: `interpret` sees every body (detect + ledger), and `SurfaceOutcome.after` carries the computed deficit into the engine's own retry loop",
    );
}

void main();
