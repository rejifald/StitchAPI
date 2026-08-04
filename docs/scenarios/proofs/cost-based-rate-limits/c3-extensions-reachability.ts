// C3 — is `extensions.cost.throttleStatus` reachable AT ALL on a `graphql()` stitch?
//
// Two paths matter, because a cost ledger needs BOTH: the budget must be re-read from every
// response, successes included (the shop's bucket is shared, so only the server's number is true).
//   (a) on SUCCESS, where the graphql helper pins `pick: 'data'` (stitch.ts:1263)
//   (b) on the THROTTLED failure, where the surface rejects a 200
//
//   pnpm exec tsx docs/scenarios/proofs/cost-based-rate-limits/c3-extensions-reachability.ts
import { graphql } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StitchEvent } from '../../../../packages/core/src/types';
import { FakeShopify, costOfBody } from './fake-shopify';
import { check, finish, heading, note } from './harness';

const DOC = 'query BigSync { products { id } }';
const URL = 'https://shop.myshopify.com/admin/api/graphql.json';

async function main(): Promise<void> {
    heading('C3 — is extensions.cost reachable on a graphql() stitch?');

    // ── (a) SUCCESS: the caller gets `data`, and `extensions` is gone ──────────────────────────
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        let hookBody: unknown;
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            hooks: {
                onResponse: (ctx) => {
                    hookBody = ctx.res?.body;
                },
            },
        });
        const r = await call.safe();
        check('(a) call succeeded', r.ok, true);
        check(
            '(a) caller sees `extensions`',
            costOfBody(r.data) !== undefined,
            false,
        );
        note('(a) what the caller got', JSON.stringify(r.data));
        // The HOOK, however, sees the WHOLE body — `onResponse` is handed the live AdapterResponse
        // (types.ts:1282, engine.ts:705), before `pick` runs (engine.ts:968).
        const hookCost = costOfBody(hookBody);
        check(
            '(a) onResponse hook sees extensions.cost',
            hookCost !== undefined,
            true,
        );
        check(
            '(a) …currentlyAvailable it read',
            hookCost?.throttleStatus.currentlyAvailable,
            700,
        );
        check('(a) …actualQueryCost it read', hookCost?.actualQueryCost, 300);
    }

    // ── (a2) `.inspect().raw` does NOT reach it — `raw` is pre-VALIDATION, not pre-PICK ────────
    // The natural second guess after the hook. `raw` is the body the drift findings are diffed
    // against, which is taken AFTER `pick` has already unwrapped `data`.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
        });
        const ins = await call.inspect();
        check(
            '(a2) inspect().raw carries extensions.cost',
            costOfBody(ins.raw) !== undefined,
            false,
        );
        note('(a2) what inspect().raw actually is', JSON.stringify(ins.raw));
        note('(a2) inspect().source', ins.source);
    }

    // ── (b) THROTTLED: the thrown StitchError does NOT carry the body ──────────────────────────
    // graphql's `interpret` rejects the 200 (surface.ts:310-323). A body verdict is returned, not
    // thrown, so the engine builds the terminal event with `surfaceErrEvt` (engine.ts:1143-1158) —
    // which sets only `message` / `status` / `attempts` and attaches NO `ERROR_SOURCE`. The
    // `StitchError` rebuilt in stitch.ts:509-515 therefore has no `body`.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
        });
        const r = await call.safe();
        check('(b) call failed', r.ok, false);
        check('(b) error message', r.error?.message, 'GraphQL: Throttled');
        check(
            '(b) StitchError.body is present',
            r.error?.body !== undefined,
            false,
        );
        check(
            '(b) → extensions.cost off the error',
            costOfBody(r.error?.body),
            undefined,
        );
        // The status DOES survive (graphql's outcome carries `status: res.status`,
        // surface.ts:321) — and it is `200`, which is the whole trap in one number.
        check('(b) StitchError.status', r.error?.status, 200);
    }

    // ── (b2) the EVENT STREAM on a throttle: no body either ────────────────────────────────────
    // The `error` event's own type (types.ts:1343-1354) has `message`/`status`/`retryAfter`/
    // `attempts` — there is no field a body could ride on.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
        });
        const events: StitchEvent[] = [];
        for await (const ev of call.stream()) events.push(ev);
        const errEv = events.find((e) => e.type === 'error');
        check('(b2) an error event was emitted', errEv !== undefined, true);
        note(
            '(b2) error event keys',
            Object.keys(errEv ?? {})
                .sort()
                .join(','),
        );
        check(
            '(b2) any event carrying extensions.cost',
            events.some(
                (e) => costOfBody((e as { body?: unknown }).body) !== undefined,
            ),
            false,
        );
    }

    // ── (b3) but a HOOK still sees it on the throttled response ────────────────────────────────
    // This is the seam that survives: `onResponse` fires for every attempt, throttled or not.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        let hookBody: unknown;
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            hooks: {
                onResponse: (ctx) => {
                    hookBody = ctx.res?.body;
                },
            },
        });
        await call.safe();
        const cost = costOfBody(hookBody);
        check(
            '(b3) hook saw extensions.cost on the THROTTLE',
            cost !== undefined,
            true,
        );
        check('(b3) …requestedQueryCost', cost?.requestedQueryCost, 300);
        check(
            '(b3) …currentlyAvailable',
            cost?.throttleStatus.currentlyAvailable,
            0,
        );
        check('(b3) …restoreRate', cost?.throttleStatus.restoreRate, 50);
    }

    // ── (b4) `.inspect()` on the throttle: `raw` is NULL ───────────────────────────────────────
    // `source` is `'live'` (a real request ran and a real body came back), yet `raw` is null: the
    // surface rejected the response before the raw body was retained. So `.inspect()` is not a
    // route to the throttled payload either.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        shop.drain(1000);
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
        });
        const ins = await call.inspect();
        check('(b4) inspect().error set', ins.error !== null, true);
        check('(b4) inspect().source', ins.source, 'live');
        check('(b4) inspect().raw', ins.raw, null);
    }

    // ── (c) can `pick` be re-aimed at extensions? Yes — and it costs you `data` ────────────────
    // `graphql()` pins `pick: config.pick ?? 'data'` (stitch.ts:1263), so `pick` IS overridable.
    // But `pick` is one path: aim it at the cost and the payload is gone.
    {
        const clock = manualClock();
        const shop = new FakeShopify({ clock, costs: { BigSync: 300 } });
        const call = graphql({
            url: URL,
            document: DOC,
            adapter: shop.adapter(),
            clock,
            pick: 'extensions.cost',
        });
        const r = await call.safe();
        check('(c) pick:"extensions.cost" — call ok', r.ok, true);
        check(
            '(c) caller now sees currentlyAvailable',
            (r.data as { throttleStatus?: { currentlyAvailable?: number } })
                ?.throttleStatus?.currentlyAvailable,
            700,
        );
        check(
            '(c) …but the GraphQL `data` payload is gone',
            (r.data as { ok?: boolean }).ok,
            undefined,
        );
    }

    finish(
        'C3',
        'extensions.cost is reachable on both paths through EXACTLY ONE seam — hooks.onResponse. The success RESULT is pick-stripped to data, .inspect().raw is post-pick (success) or null (throttle), and the StitchError and error EVENT carry no body at all',
    );
}

void main();
