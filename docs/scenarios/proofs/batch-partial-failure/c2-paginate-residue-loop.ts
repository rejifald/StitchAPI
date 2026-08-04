// C2 — can `paginate.next(prevBody, pagesFetched)` express "resend ONLY the residue"? It returns
// the input merged over the original, or `undefined` to stop (types.ts:1412-1422), which is
// structurally the loop this scenario needs. This measures the loop it builds: requests, DUPLICATE
// WRITES (the number that must be zero), and whether every item eventually lands.
//
//   pnpm exec tsx docs/scenarios/proofs/batch-partial-failure/c2-paginate-residue-loop.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { AdapterRequest } from '../../../../packages/core/src/types';
import {
    FakeDynamo,
    dynamoBody,
    processedOf,
    unprocessedOf,
} from './fake-batch';
import { check, finish, heading, note } from './harness';

const URL = 'https://dynamodb.us-east-1.amazonaws.com/batch';
const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** The residue loop, spelled on `paginate`. This is the whole of the user's code. */
const residueLoop = (pages?: number) => ({
    // `UnprocessedItems` comes back in the same shape `RequestItems` went out in, so the next
    // request body IS the residue — no transformation, exactly as AWS documents.
    next: (prevBody: unknown) => {
        const residue = unprocessedOf(prevBody);
        return residue.length > 0
            ? { body: { RequestItems: residue } }
            : undefined;
    },
    items: (value: unknown) => processedOf(value),
    ...(pages === undefined ? {} : { pages }),
});

async function main(): Promise<void> {
    heading('C2 — `paginate.next` as a residue-resend loop');

    // ── (a) the loop, against a table that lands 2 items per request ───────────────────────────
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            paginate: residueLoop(),
        });
        const r = await call.safe({ body: dynamoBody(IDS) });

        check('(a) call ok', r.ok, true);
        check(
            '(a) requests made for 6 items at 2/request',
            db.requests.length,
            3,
        );
        check(
            '(a) what each request carried',
            db.requests.map((q) => q.ids.join('')).join(' → '),
            'abcdef → cdef → ef',
        );
        check('(a) DUPLICATE WRITES', db.duplicateWrites, 0);
        check('(a) every item landed exactly once', db.totalWrites, 6);
        check('(a) items landed', db.landed.join(''), 'abcdef');
        check(
            '(a) aggregated successes handed back',
            (r.data as { id: string }[]).map((i) => i.id).join(''),
            'abcdef',
        );
    }

    // ── (b) it stops when the residue empties, not when a page cap is hit ──────────────────────
    // `next` returning `undefined` is the terminating condition; `pages` (default 50) is only the
    // safety cap. Measured by giving it a cap it must not need.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            paginate: residueLoop(50),
        });
        await call.safe({ body: dynamoBody(IDS) });
        check('(b) requests made under a 50-page cap', db.requests.length, 3);
    }

    // ── (c) the rest of the request is preserved across rounds ─────────────────────────────────
    // `next` returns a PARTIAL input merged over the original (engine.ts:901-915), so headers,
    // query and method ride every round; only `body` is rewritten.
    {
        const clock = manualClock();
        const db = new FakeDynamo({ clock, accepts: 2 });
        const seen: AdapterRequest[] = [];
        const call = stitch({
            url: URL,
            method: 'POST',
            headers: { 'x-amz-target': 'DynamoDB_20120810.BatchWriteItem' },
            adapter: async (req) => {
                seen.push(req);
                return db.adapter()(req);
            },
            clock,
            paginate: residueLoop(),
        });
        await call.safe({
            body: dynamoBody(IDS),
            headers: { 'x-request-id': 'r-1' },
        });
        check('(c) requests made', seen.length, 3);
        check(
            '(c) static header on the LAST round',
            seen[2]?.headers['x-amz-target'],
            'DynamoDB_20120810.BatchWriteItem',
        );
        check(
            '(c) per-call header on the LAST round',
            seen[2]?.headers['x-request-id'],
            'r-1',
        );
        check('(c) method on the LAST round', seen[2]?.method, 'POST');
    }

    // ── (d) THE HOLE: a round that lands NOTHING silently ends the loop ────────────────────────
    // `paginated` breaks on `items.length === 0` BEFORE it calls `next` (engine.ts:984). A batch
    // endpoint answers exactly that way whenever the table has no capacity left — which is the
    // normal case AWS tells you to back off from. The call then resolves ok, with the residue gone.
    {
        const clock = manualClock();
        // A real write-capacity bucket: 2 units at t=0, refilling 1/s. With no wait between rounds
        // the second request arrives at t=0 with nothing left, so it lands zero items.
        const db = new FakeDynamo({ clock, writeUnitsPerSec: 1, burst: 2 });
        const call = stitch({
            url: URL,
            method: 'POST',
            adapter: db.adapter(),
            clock,
            paginate: residueLoop(),
        });
        const p = call.safe({ body: dynamoBody(IDS) });
        await clock.advance(60_000);
        const r = await p;

        check(
            '(d) requests made before the loop gave up',
            db.requests.length,
            2,
        );
        check(
            '(d) the second request landed nothing',
            db.requests[1]?.accepted.length,
            0,
        );
        check('(d) the call REPORTED SUCCESS', r.ok, true);
        check('(d) there is no error', r.error, null);
        check('(d) items that landed', db.landed.join(''), 'ab');
        check(
            '(d) items the caller believes were written',
            (r.data as { id: string }[]).map((i) => i.id).join(''),
            'ab',
        );
        note(
            '(d) → 4 of 6 rows are gone, the loop stopped early, and nothing failed',
            '',
        );
    }

    finish(
        'C2',
        '`paginate.next` DOES express the residue resend — 3 requests for 6 items, ZERO duplicate writes, every item landed — but the loop terminates on a page that aggregates zero items (engine.ts:984), so a round in which nothing lands ends the run SUCCESSFULLY with the residue dropped',
    );
}

void main();
