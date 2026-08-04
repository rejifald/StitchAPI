// C4 — can a custom `Surface` rewrite the OUTGOING REQUEST BODY between attempts? Scenario 2's
// answer to a body-carried failure was `SurfaceOutcome.retry` + `after`, which re-enters the attempt
// loop. This measures what that re-attempt actually SENDS, and then walks every other surface hook
// (`buildRequest`, `execute`) and the `onRequest` hook to find one that can change it.
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c4-surface-rewrite.ts
import { stitch } from '../../../../packages/core/src/index';
import type {
    Surface,
    SurfaceOutcome,
} from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    AdapterResponse,
    StitchEvent,
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

/** A surface that reads the residue off the 200 body and asks for another attempt. */
const retryingSurface = (afterMs: number): Surface => ({
    id: 'dynamo-batch',
    interpret: (res: AdapterResponse): SurfaceOutcome => {
        const residue = unprocessedOf(res.body);
        return residue.length > 0
            ? {
                  ok: false,
                  retry: true,
                  message: `${residue.length} unprocessed`,
                  after: afterMs,
              }
            : { ok: true, data: res.body };
    },
});

async function main(): Promise<void> {
    heading('C4 — can a surface rewrite the request body between attempts?');

    // ── (a) `SurfaceOutcome.retry` re-sends the SAME request ──────────────────────────────────
    // The attempt loop clones ONE `baseReq` per attempt (engine.ts:646) — it is built once, before
    // the loop (`runOnce`, engine.ts:1527). The surface's verdict re-enters that loop; it does not
    // rebuild the request.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: retryingSurface(500),
            adapter: db.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const p = call.safe({ body: dynamoBody(SIX) });
        await clock.advance(60_000);
        const r = await p;

        check('(a) attempts made', db.requests.length, 3);
        check(
            '(a) the wait between attempts was honoured (ms)',
            db.requests[1]?.at,
            500,
        );
        check(
            '(a) what each attempt SENT',
            db.requests.map((q) => q.ids.join('')).join(' → '),
            'abcdef → abcdef → abcdef',
        );
        check('(a) items already landed, written again', db.writeCount('a'), 3);
        check('(a) DUPLICATE WRITES', db.duplicateWrites, 4);
        check('(a) items never written', 6 - db.landed.length, 4);
        check('(a) call failed after the budget', r.ok, false);
        note('(a) error message', r.error?.message);
    }

    // ── (a2) `interpret` is not even told which attempt it is on ───────────────────────────────
    // Its signature is `(res, cfg)` (surface.ts:61-64). A surface cannot tell a first attempt from
    // a last one, so it cannot decide "this is the final round, hand back what is left".
    {
        const threeArg: Surface = {
            id: 'x',
            // @ts-expect-error — `interpret` takes (res, cfg); there is no attempt argument.
            interpret: (
                res: AdapterResponse,
                _cfg: unknown,
                _attempt: number,
            ) => ({
                ok: true as const,
                data: res.body,
            }),
        };
        void threeArg;
        note(
            '(a2) Surface.interpret signature',
            '(res, cfg) => SurfaceOutcome',
        );
    }

    // ── (b) `buildRequest` runs ONCE per call on the retry path ───────────────────────────────
    // So the other surface hook that touches the request cannot rewrite it between attempts either.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        let builds = 0;
        const counted: Surface = {
            ...retryingSurface(0),
            buildRequest: (_cfg, _input, base) => {
                builds++;
                return base;
            },
        };
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: counted,
            adapter: db.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const p = call.safe({ body: dynamoBody(SIX) });
        await clock.advance(60_000);
        await p;
        check('(b) requests sent', db.requests.length, 3);
        check('(b) times `buildRequest` ran', builds, 1);
    }

    // ── (b2) on the PAGINATE path it runs once per page — but only on `next`'s input ───────────
    // `paginated` rebuilds the request each round (engine.ts:940), so `buildRequest` does see the
    // new body. It is downstream of `paginate.next`, not an independent rewrite seam.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        let builds = 0;
        const bodies: string[] = [];
        const counted: Surface = {
            id: 'dynamo-batch',
            buildRequest: (_cfg, _input, base) => {
                builds++;
                bodies.push(
                    (
                        (base.body as { RequestItems?: { id: string }[] })
                            ?.RequestItems ?? []
                    )
                        .map((i) => i.id)
                        .join(''),
                );
                return base;
            },
        };
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: counted,
            adapter: db.adapter(),
            clock,
            paginate: {
                next: (prev) => {
                    const residue = unprocessedOf(prev);
                    return residue.length
                        ? { body: { RequestItems: residue } }
                        : undefined;
                },
                items: (v) => processedOf(v),
            },
        });
        await call.safe({ body: dynamoBody(SIX) });
        check('(b2) pages fetched', db.requests.length, 3);
        // One extra build: `paginated` builds the request once for the `start` event (engine.ts:936)
        // and again at the head of each round (:940).
        check('(b2) times `buildRequest` ran', builds, 4);
        check('(b2) bodies it saw', bodies.join(','), 'abcdef,abcdef,cdef,ef');
    }

    // ── (c) the `onRequest` HOOK can rewrite the body, and does it inside the chain ────────────
    // `onRequest` is awaited on the per-attempt clone, before the transport runs (engine.ts:646-670).
    // Assigning `ctx.req.body` there changes what attempt N+1 sends. This is the seam C7 is built on.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        let residue: { id: string }[] | null = null;
        const evts: StitchEvent[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: retryingSurface(500),
            adapter: db.adapter(),
            clock,
            retry: { attempts: 4 },
            hooks: {
                onRequest: (ctx) => {
                    if (ctx.req && residue)
                        ctx.req.body = { RequestItems: residue };
                },
                onResponse: (ctx) => {
                    const left = unprocessedOf(ctx.res?.body);
                    residue = left.length > 0 ? left : null;
                },
            },
        });
        const consume = (async (): Promise<void> => {
            for await (const e of call.stream({ body: dynamoBody(SIX) }))
                evts.push(e);
        })();
        await clock.advance(60_000);
        await consume;

        check('(c) attempts made', db.requests.length, 3);
        check(
            '(c) what each attempt SENT',
            db.requests.map((q) => q.ids.join('')).join(' → '),
            'abcdef → cdef → ef',
        );
        check('(c) DUPLICATE WRITES', db.duplicateWrites, 0);
        check('(c) every item landed', db.landed.join(''), 'abcdef');
        check(
            '(c) the engine counted the rounds as retry attempts',
            evts.filter((e) => e.type === 'progress' && e.phase === 'retry')
                .length,
            2,
        );
        const result = evts.find((e) => e.type === 'result');
        check(
            '(c) attempts reported on the result',
            result && 'attempts' in result ? result.attempts : undefined,
            3,
        );
    }

    // ── (c2) …but the rewrite must ASSIGN, never mutate in place ──────────────────────────────
    // `cloneReq` copies the request and its headers, and shares `body` by reference
    // (engine.ts:261-264) — and that reference is the CALLER'S object. Editing `ctx.req.body` in
    // place therefore reaches back into the array the caller passed in.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const callerBody = dynamoBody(SIX);
        let residue: { id: string }[] | null = null;
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: retryingSurface(0),
            adapter: db.adapter(),
            clock,
            retry: { attempts: 4 },
            hooks: {
                onRequest: (ctx) => {
                    const body = ctx.req?.body as
                        { RequestItems: { id: string }[] } | undefined;
                    // The in-place spelling — the one that looks equivalent.
                    if (body && residue) body.RequestItems = residue;
                },
                onResponse: (ctx) => {
                    const left = unprocessedOf(ctx.res?.body);
                    residue = left.length > 0 ? left : null;
                },
            },
        });
        const p = call.safe({ body: callerBody });
        await clock.advance(60_000);
        await p;
        check('(c2) the loop still worked', db.landed.join(''), 'abcdef');
        check(
            '(c2) the CALLER’S body object after the call',
            callerBody.RequestItems.map((i) => i.id).join(''),
            'ef',
        );
        note(
            '(c2) → the caller handed in 6 items and got their array rewritten to the last residue',
            '',
        );
    }

    // ── (d) `kind.execute` can loop freely — BELOW the resilience chain ────────────────────────
    // A surface may replace the transport (surface.ts:109-118). A loop written there can do
    // anything, but the engine sees ONE call: one attempt, no retry events, and the rounds it made
    // are invisible to the run report.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const transport = db.adapter();
        const looping: Surface = {
            id: 'dynamo-batch-execute',
            execute: async (req) => {
                let body = req.body as { RequestItems: { id: string }[] };
                let res = await transport({ ...req, body });
                for (let i = 0; i < 5 && unprocessedOf(res.body).length; i++) {
                    await clock.sleep(100 * 2 ** i);
                    body = { RequestItems: unprocessedOf(res.body) };
                    res = await transport({ ...req, body });
                }
                return res;
            },
        };
        const evts: StitchEvent[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            kind: looping,
            clock,
            retry: { attempts: 4 },
        });
        const consume = (async (): Promise<void> => {
            for await (const e of call.stream({ body: dynamoBody(SIX) }))
                evts.push(e);
        })();
        await clock.advance(60_000);
        await consume;

        check(
            '(d) requests the provider really received',
            db.requests.length,
            3,
        );
        check('(d) DUPLICATE WRITES', db.duplicateWrites, 0);
        const result = evts.find((e) => e.type === 'result');
        check(
            '(d) attempts the engine reported',
            result && 'attempts' in result ? result.attempts : undefined,
            1,
        );
        check(
            '(d) `retry` progress events',
            evts.filter((e) => e.type === 'progress' && e.phase === 'retry')
                .length,
            0,
        );
        check(
            '(d) `request` progress events (one per real round?)',
            evts.filter((e) => e.type === 'progress' && e.phase === 'request')
                .length,
            1,
        );
        note(
            '(d) → the loop works and the observability is gone; same trade as a hand-rolled while',
            '',
        );
    }

    finish(
        'C4',
        'a surface CANNOT rewrite the request between attempts — `SurfaceOutcome.retry` resends the identical body (3 attempts × the same 6 items, 4 duplicate writes) and `buildRequest` runs once per call — but the `onRequest` HOOK can: assigning `ctx.req.body` there turns the same retry budget into a shrinking-subset loop with ZERO duplicate writes, still inside the resilience chain',
    );
}

void main();
