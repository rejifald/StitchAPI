// C1 — the BUILT-IN `retry` against a 200 that reports per-item failure in its body. Two questions,
// both measured against a provider that counts writes PER ITEM:
//
//   1. does `retry` fire at all, when the status is 200?
//   2. when forced to fire, how many times are the items that ALREADY SUCCEEDED written again?
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c1-retry-replays-the-batch.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StatusMatch } from '../../../../packages/core/src/types';
import { FakeDynamo, dynamoBody, unprocessedOf } from './fake-batch';
import { check, finish, heading, note } from './harness';

const URL = 'https://dynamodb.us-east-1.amazonaws.com/batch';
const IDS = ['a', 'b', 'c', 'd', 'e'];

/** A table that lands the first THREE items of whatever it is sent and rejects the rest. */
function table(): { db: FakeDynamo; clock: ReturnType<typeof manualClock> } {
    const clock = manualClock();
    return { db: new FakeDynamo({ clock, accepts: 3 }), clock };
}

async function main(): Promise<void> {
    heading(
        'C1 — does `retry` fire on a 200-with-UnprocessedItems, and what does it cost?',
    );

    // ── (a) the DEFAULT retry set — and the Logstash failure mode, reproduced ──────────────────
    // `retry.on` defaults to [429, 502, 503, 504]. A partial failure is a 200, so nothing matches:
    // one request, no retry, and — worse — the call resolves SUCCESSFULLY with the half-failed
    // envelope as its data. Two of the five rows are simply gone, and nothing said so.
    {
        const { db, clock } = table();
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            retry: { attempts: 5 },
        });
        const r = await call.safe({ body: dynamoBody(IDS) });
        check(
            '(a) requests made (retry.attempts was 5)',
            db.requests.length,
            1,
        );
        check('(a) the call REPORTED SUCCESS on a partial failure', r.ok, true);
        check('(a) items that landed', db.landed.join(','), 'a,b,c');
        check(
            '(a) …items silently left behind',
            unprocessedOf(r.data)
                .map((i) => i.id)
                .join(','),
            'd,e',
        );
        note(
            '(a) → this is elastic/logstash#1631: a 200, and the residue is the caller’s problem',
            '',
        );
    }

    // ── (b) a PREDICATE on `retry.on` — it is handed the STATUS ONLY ───────────────────────────
    // If the predicate saw the response it could read `UnprocessedItems`. It does not: the engine
    // calls it as `retryMatch(res.status)` (engine.ts:743) — one argument, a number.
    {
        const { db, clock } = table();
        const received: unknown[][] = [];
        const on = ((...args: unknown[]): boolean => {
            received.push(args);
            return false;
        }) as StatusMatch;
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            retry: { attempts: 5, on },
        });
        await call.safe({ body: dynamoBody(IDS) });
        check('(b) predicate invoked', received.length > 0, true);
        check('(b) arguments handed to retry.on', received[0]?.length, 1);
        check('(b) argument value', received[0]?.[0], 200);
        note(
            '(b) the body — where the failure lives — is not passed',
            JSON.stringify(received[0] ?? []),
        );
    }

    // ── (c) FORCE it with `retry.on: 200` — and measure the duplicate writes ───────────────────
    // This is the only built-in spelling that makes a retry fire here, and it replays the request
    // byte-for-byte. The three rows that already landed are written again on every attempt.
    {
        const { db, clock } = table();
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 1000 },
            },
        });
        const p = call.safe({ body: dynamoBody(IDS) });
        await clock.advance(60_000);
        await p;
        check('(c) requests made', db.requests.length, 3);
        check(
            '(c) every request carried ALL FIVE items',
            db.requests.every((r) => r.ids.length === 5),
            true,
        );
        check(
            '(c) writes of item `a` (it landed on attempt 1)',
            db.writeCount('a'),
            3,
        );
        check(
            '(c) DUPLICATE WRITES caused by the retry',
            db.duplicateWrites,
            6,
        );
        check(
            '(c) items still not written after 3 attempts',
            5 - db.landed.length,
            2,
        );
        note(
            '(c) → 9 writes to land 3 rows, and the 2 that failed never got a different request',
            '',
        );
    }

    // ── (d) the `onResponse` status-rewrite hack — same replay, invented status ────────────────
    // Rewriting a 200 into a 429 inside `onResponse` (the hook fires at engine.ts:705, before the
    // retry check at :743) does drive the DEFAULT retry set. It changes WHEN the retry fires, never
    // WHAT it sends: the duplicate count is identical, and the caller's error status is now a 429
    // that was never on the wire.
    {
        const { db, clock } = table();
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 1000 } },
            hooks: {
                onResponse: (ctx) => {
                    if (ctx.res && unprocessedOf(ctx.res.body).length > 0)
                        ctx.res.status = 429;
                },
            },
        });
        const p = call.safe({ body: dynamoBody(IDS) });
        await clock.advance(60_000);
        const r = await p;
        check('(d) requests made', db.requests.length, 3);
        check('(d) DUPLICATE WRITES', db.duplicateWrites, 6);
        check('(d) call failed', r.ok, false);
        check(
            '(d) status the caller is handed (never sent by the provider)',
            r.error?.status,
            429,
        );
        note('(d) error message', r.error?.message);
    }

    // ── (e) the cost on a HEALTHY batch: `on: 200` retries SUCCESSES too ───────────────────────
    // The status matcher runs before any body is interpreted, so `on: 200` cannot tell a partial
    // failure from a complete success. A batch that fully succeeded is written three times over.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 99 }); // roomy table: everything lands
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            retry: {
                attempts: 3,
                on: 200,
                backoff: { curve: 'fixed', base: 1000 },
            },
        });
        const p = call.safe({ body: dynamoBody(IDS) });
        await clock.advance(60_000);
        await p;
        check(
            '(e) requests made for a batch that succeeded first time',
            db.requests.length,
            3,
        );
        check('(e) total writes for 5 rows', db.totalWrites, 15);
        check(
            '(e) DUPLICATE WRITES on a fully successful batch',
            db.duplicateWrites,
            10,
        );
    }

    finish(
        'C1',
        'built-in `retry` cannot see a per-item failure (the status is 200 and `retry.on` receives only the status), and the one spelling that forces it to fire — `on: 200` — replays the WHOLE batch: 6 duplicate writes to chase 2 failed rows, and 10 duplicate writes on a batch that never failed at all',
    );
}

void main();
