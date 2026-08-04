// C3 — DECIDING CLAIM. AWS is explicit that retrying `UnprocessedItems` without waiting simply
// throttles again, so a residue loop that cannot back off is not a solution. Four questions, all
// measured on an injected `manualClock()`, so every gap below is exact virtual time:
//
//   (a) is there ANY per-iteration wait in `paginate`?
//   (b) can `throttle` stand in, and can its spacing GROW?
//   (c) is growth reachable anywhere else on the public API?
//   (d) what does a fixed spacing cost against a table that really is out of write capacity?
//   (e) does the throttle that paces the loop also pace unrelated traffic?
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c3-backoff-between-pages.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    PaginateOptions,
    StitchEvent,
    ThrottleOptions,
} from '../../../../packages/core/src/types';
import {
    FakeDynamo,
    dynamoBody,
    processedOf,
    unprocessedOf,
} from './fake-batch';
import { check, finish, heading, note } from './harness';

const URL = 'https://dynamodb.us-east-1.amazonaws.com/batch';
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

const residueLoop: PaginateOptions = {
    next: (prevBody: unknown) => {
        const residue = unprocessedOf(prevBody);
        return residue.length > 0
            ? { body: { RequestItems: residue } }
            : undefined;
    },
    items: (value: unknown) => processedOf(value),
};

/** Run the residue loop and return the virtual arrival time of every request. */
async function gaps(opts: {
    ids?: string[];
    accepts?: number;
    writeUnitsPerSec?: number;
    burst?: number;
    throttle?: string;
    /** A per-round wait implemented in user code, in the async `onRequest` hook. */
    hookWait?: (round: number) => number;
}): Promise<{ at: number[]; db: FakeDynamo; ok: boolean }> {
    const clock = manualClock();
    const db = new FakeDynamo({
        clock,
        ...(opts.accepts === undefined ? {} : { accepts: opts.accepts }),
        ...(opts.writeUnitsPerSec === undefined
            ? {}
            : { writeUnitsPerSec: opts.writeUnitsPerSec }),
        ...(opts.burst === undefined ? {} : { burst: opts.burst }),
    });
    let round = 0;
    const call = stitch({
        url: URL,
        method: 'POST',
        adapter: db.adapter(),
        clock,
        paginate: residueLoop,
        ...(opts.throttle === undefined ? {} : { throttle: opts.throttle }),
        ...(opts.hookWait === undefined
            ? {}
            : {
                  hooks: {
                      onRequest: async (): Promise<void> => {
                          const ms = opts.hookWait!(round++);
                          if (ms > 0) await clock.sleep(ms);
                      },
                  },
              }),
    });
    const p = call.safe({ body: dynamoBody(opts.ids ?? SIX) });
    await clock.advance(600_000);
    const r = await p;
    return { at: db.requests.map((q) => q.at), db, ok: r.ok };
}

async function main(): Promise<void> {
    heading('C3 — can any backoff be introduced between residue rounds?');

    // ── (a) NO. `PaginateOptions` is three fields and the loop never sleeps ────────────────────
    // engine.ts:939-988 is `for (;;) { request; aggregate; next }` — there is no sleep site in it.
    // Six rounds land on the same virtual millisecond.
    {
        const { at } = await gaps({ accepts: 1 });
        check(
            '(a) arrival time of every round (ms)',
            at.join(','),
            '0,0,0,0,0,0',
        );
        check('(a) rounds fired', at.length, 6);

        // The type has no slot to put one in. A `@ts-expect-error` that is NOT an error fails
        // `tsc`, so these two lines are the machine-checked half of the claim.
        const withDelay: PaginateOptions = {
            ...residueLoop,
            // @ts-expect-error — `delay` is not a `PaginateOptions` field (types.ts:1412-1422).
            delay: 1000,
        };
        const withBackoff: PaginateOptions = {
            ...residueLoop,
            // @ts-expect-error — neither is `backoff`. The three fields are next / items / pages.
            backoff: { curve: 'expo', base: 100 },
        };
        void withDelay;
        void withBackoff;
        note(
            '(a) PaginateOptions fields',
            Object.keys(residueLoop).concat('pages').join(', '),
        );
    }

    // ── (b) `throttle` DOES pace the rounds — with a FIXED spacing that cannot grow ────────────
    // Each page is a full request, so it takes the rate gate (engine.ts:628-644). The gaps are
    // equal by construction: `rate` is one ratio parsed once, and `ThrottleOptions` has no curve.
    {
        const { at } = await gaps({ accepts: 1, throttle: '1/s' });
        check(
            '(b) arrival times under throttle "1/s"',
            at.join(','),
            '0,1000,2000,3000,4000,5000',
        );
        const deltas = at.slice(1).map((t, i) => t - at[i]!);
        check('(b) distinct gaps between rounds', new Set(deltas).size, 1);

        const growing: ThrottleOptions = {
            // @ts-expect-error — no curve/base/max on `throttle`; `rate` is a `<count>/<duration>`
            // string and nothing else (types.ts:1005-1032).
            backoff: { curve: 'expo', base: 100 },
        };
        void growing;
        note(
            '(b) ThrottleOptions fields',
            'rate, concurrency, pool, delegate, on',
        );
    }

    // ── (c) growth is reachable, but only as USER CODE inside an async hook ────────────────────
    // `onRequest` is awaited before every attempt (engine.ts:652), so sleeping in it delays the
    // next round. That is the whole mechanism — there is no configuration involved.
    {
        const { at } = await gaps({
            accepts: 1,
            hookWait: (round) => (round === 0 ? 0 : 100 * 2 ** (round - 1)),
        });
        check(
            '(c) arrival times with an expo wait in `onRequest`',
            at.join(','),
            '0,100,300,700,1500,3100',
        );
        const deltas = at.slice(1).map((t, i) => t - at[i]!);
        check(
            '(c) the gap grows every round',
            deltas.join(','),
            '100,200,400,800,1600',
        );
    }

    // ── (c2) …and the engine does not know it happened ────────────────────────────────────────
    // A `throttle` wait is reported as a `throttled` progress event carrying `waited`. A sleep in
    // the hook is invisible: no event, no `waited`, nothing in a trace of the run.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const evts: StitchEvent[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            paginate: residueLoop,
            hooks: {
                onRequest: async (ctx): Promise<void> => {
                    if (ctx.attempt >= 0 && db.requests.length > 0)
                        await clock.sleep(500);
                },
            },
        });
        const consume = (async (): Promise<void> => {
            for await (const e of call.stream({ body: dynamoBody(SIX) }))
                evts.push(e);
        })();
        await clock.advance(600_000);
        await consume;
        const throttled = evts.filter(
            (e) => e.type === 'progress' && e.phase === 'throttled',
        );
        check(
            '(c2) rounds that really waited 500ms',
            db.requests.length - 1,
            5,
        );
        check(
            '(c2) `throttled` events the engine emitted',
            throttled.length,
            0,
        );
        check(
            '(c2) total virtual time spent waiting',
            db.requests[5]?.at,
            2500,
        );
        note(
            '(c2) → the wait is real and the run report says the call never waited',
            '',
        );
    }

    // ── (d) what a fixed spacing buys, and what it costs ───────────────────────────────────────
    // The table now has a real write-capacity bucket: 2 units at t=0, refilling 1/s. This is the
    // AWS case — `UnprocessedItems` because there is no capacity, so the wait IS the fix.
    {
        const none = await gaps({ writeUnitsPerSec: 1, burst: 2 });
        check('(d) no wait — rounds fired', none.at.length, 2);
        check('(d) no wait — items landed', none.db.landed.length, 2);
        check(
            '(d) no wait — items LOST (loop broke on a zero-item page)',
            6 - none.db.landed.length,
            4,
        );
        check('(d) no wait — the call still reported success', none.ok, true);

        const fixed = await gaps({
            writeUnitsPerSec: 1,
            burst: 2,
            throttle: '1/s',
        });
        check('(d) throttle "1/s" — rounds fired', fixed.at.length, 5);
        check('(d) throttle "1/s" — items landed', fixed.db.landed.length, 6);
        check(
            '(d) throttle "1/s" — duplicate writes',
            fixed.db.duplicateWrites,
            0,
        );
        check(
            '(d) throttle "1/s" — finished at (ms)',
            fixed.at[fixed.at.length - 1],
            4000,
        );

        // An exponential curve that starts BELOW the refill period under-waits on its first step,
        // lands zero items, and hits the same zero-page break. On this seam, a curve that starts
        // small is indistinguishable from no backoff at all.
        const expo = await gaps({
            writeUnitsPerSec: 1,
            burst: 2,
            hookWait: (round) => (round === 0 ? 0 : 100 * 2 ** (round - 1)),
        });
        check('(d) expo(base 100) — rounds fired', expo.at.length, 2);
        check('(d) expo(base 100) — items LOST', 6 - expo.db.landed.length, 4);
        note(
            '(d) → correctness here comes from waiting LONG ENOUGH, not from the curve',
            '',
        );
    }

    // ── (d2) the cost of sizing that spacing for the worst case ────────────────────────────────
    // The same stitch against a HEALTHY table (2 items per request, no capacity limit). The
    // spacing that saved (d) now paces work the table would have taken instantly.
    {
        const twenty = Array.from({ length: 20 }, (_, i) => `i${i}`);
        const free = await gaps({ ids: twenty, accepts: 2 });
        const paced = await gaps({ ids: twenty, accepts: 2, throttle: '1/4s' });
        check(
            '(d2) healthy table, no throttle — finished at (ms)',
            free.at[free.at.length - 1],
            0,
        );
        check(
            '(d2) healthy table, throttle "1/4s" — rounds',
            paced.at.length,
            10,
        );
        check(
            '(d2) healthy table, throttle "1/4s" — finished at (ms)',
            paced.at[paced.at.length - 1],
            36_000,
        );
        note(
            '(d2) → 36s of pacing for work the table took in one virtual millisecond',
            '',
        );
    }

    // ── (e) blast radius: the spacing paces every call through that stitch ─────────────────────
    // (i) default pool `'stitch'`: two concurrent batches through the SAME stitch share one
    //     limiter, so the second batch's rounds interleave with the first's.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 1 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            throttle: '1/s',
            paginate: residueLoop,
        });
        const p = Promise.all([
            call.safe({ body: dynamoBody(['a', 'b', 'c']) }),
            call.safe({ body: dynamoBody(['x', 'y', 'z']) }),
        ]);
        await clock.advance(600_000);
        await p;
        const second = db.requests.filter(
            (q) =>
                q.ids[0]?.startsWith('x') ||
                q.ids[0] === 'y' ||
                q.ids[0] === 'z',
        );
        check('(e) rounds fired in total', db.requests.length, 6);
        check(
            '(e) the SECOND batch finished at (ms)',
            second[second.length - 1]?.at,
            5000,
        );
        note(
            '(e) alone it would have finished at 2000ms — it waits behind the first batch’s residue rounds',
            '',
        );
    }
    // (ii) pool 'host': an unrelated stitch on the same host is paced by the batch loop too.
    {
        const clock = manualClock();
        const hits: { who: string; at: number }[] = [];
        const db = new FakeDynamo({ clock, accepts: 1 });
        const batch = stitch({
            url: URL,
            method: 'POST',
            adapter: async (req) => {
                hits.push({ who: 'batch', at: clock.now() });
                return db.adapter()(req);
            },
            clock,
            throttle: { rate: '1/s', pool: 'host' },
            paginate: residueLoop,
        });
        const reader = stitch({
            url: 'https://dynamodb.us-east-1.amazonaws.com/get',
            method: 'POST',
            adapter: async () => {
                hits.push({ who: 'reader', at: clock.now() });
                return { status: 200, headers: {}, body: { Item: {} } };
            },
            clock,
            throttle: { rate: '1/s', pool: 'host' },
        });
        const p = Promise.all([
            batch.safe({ body: dynamoBody(['a', 'b', 'c']) }),
            reader.safe({ body: {} }),
        ]);
        await clock.advance(600_000);
        await p;
        check(
            '(e2) pool "host" — an unrelated read waits for the batch loop (ms)',
            hits.find((h) => h.who === 'reader')?.at,
            1000,
        );
        note('(e2) arrivals', hits.map((h) => `${h.who}@${h.at}`).join(' '));
    }

    finish(
        'C3',
        'there is NO per-iteration wait in `paginate` (six rounds at t=0) and no field to declare one; `throttle` paces the rounds but only as a FIXED spacing (one ratio, no curve) that also paces every other call through the stitch — and every growing curve measured here is user code sleeping in an async `onRequest` hook, which the engine never reports',
    );
}

void main();
