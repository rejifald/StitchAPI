// C8 — the best available answer, run end to end, against the same job written by hand.
//
// 100 orders over 30 customers, one of them deleted, one of them permanently rate-limited. Both
// implementations run over the SAME fake vendor and the SAME `manualClock`, so the comparison is
// of the code, not of the wire.
//
// MEASURED: the two agree on every outcome, and StitchAPI is shorter by roughly the pool, the
// retry loop and the dedupe map — the three things the capture says you would otherwise reach for
// `p-limit` and a hand-written backoff for.
//   (a) The StitchAPI answer: 1 list request, 30 customer requests for 100 orders, peak in-flight
//       8, 100 rows joined in input order, the 2 bad ids flagged and identifiable, 1 trace tree.
//   (b) The hand-rolled control: the same numbers, from ~1.9x the executable lines.
//   (c) THE ONE PLACE THE LIBRARY IS WORSE, and it is the failure path: a coalesced FAILURE is not
//       shared (C2 e), so the deleted customer costs one request per ORDER that references it. The
//       hand-rolled dedupe map shares the rejection and asks ONCE.
//   (d) The control for the whole exercise: `Promise.all` with no `.safe()`, no pool and no cache
//       — 0 rows, unbounded peak, and the quota spent anyway.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c8-assembled.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import {
    type Customer,
    FakeVendor,
    type OrderWithCustomer,
    idsOf,
} from './fake-vendor';
import { ordersWithCustomers } from './fanout';
import { handRolledOrdersWithCustomers } from './hand-rolled';
import {
    check,
    checkPeak,
    checkRequests,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { recordingSink } from './trace-probe';
import { runOut } from './virtual-time';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.vendor.test';
const ORDERS = 100;
const CUSTOMERS = 30;
const HOLD = 50;
const BOUND = 8;
/** Deleted: 4 of the 100 orders reference it (ids round-robin, so 001-010 appear 4 times). */
const DEAD = 'cust-005';
/** Permanently throttled: also referenced 4 times. */
const THROTTLED = 'cust-007';

/**
 * Executable lines — imports (however they wrap), blanks and comment-only lines removed on BOTH
 * sides, so the number is the code someone actually writes and maintains.
 */
function executableLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '')
        .replace(/^export interface[\s\S]*?^}$/gm, '') // the options type, identical on both sides
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

function context() {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: ORDERS,
        customers: CUSTOMERS,
        holdMs: HOLD,
        notFound: [DEAD],
        rateLimited: [THROTTLED],
    });
    return { clock, vendor };
}

/** How many rows carry a problem, and which ids they belong to. */
const flagged = (rows: readonly OrderWithCustomer[]): string[] => [
    ...new Set(rows.filter((r) => r.problem !== null).map((r) => r.customerId)),
];

async function main(): Promise<void> {
    heading(
        `C8 — ${String(ORDERS)} orders over ${String(CUSTOMERS)} customers, one deleted (${DEAD}), one throttled (${THROTTLED})`,
    );

    // ── (a) the StitchAPI answer ───────────────────────────────────────────────────────────────
    {
        const { clock, vendor } = context();
        const trace = recordingSink();
        const done = ordersWithCustomers({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            concurrency: BOUND,
            ttl: '60s',
            attempts: 3,
            trace,
        });
        await runOut(clock, 120_000, 1_000);
        const rows = await done;

        check('(a) list requests', vendor.listCalls, 1);
        check('(a) rows joined', rows.length, ORDERS);
        checkPeak('(a) peak in-flight', vendor.peakInFlight, BOUND, BOUND);
        check(
            '(a) requests for a HEALTHY duplicated id (4 orders reference it)',
            vendor.requestsFor('cust-001'),
            1,
        );
        checkSeq('(a) ids flagged as a problem', flagged(rows).sort(), [
            DEAD,
            THROTTLED,
        ]);
        check(
            '(a) rows flagged',
            rows.filter((r) => r.problem !== null).length,
            8, // 4 orders for the deleted id + 4 for the throttled one
        );
        check(
            '(a) rows joined successfully',
            rows.filter((r) => r.problem === null).length,
            92,
        );
        checkSeq(
            '(a) row order === order order',
            rows.slice(0, 3).map((r) => r.orderId),
            ['ord-0001', 'ord-0002', 'ord-0003'],
        );
        check(
            '(a) the deleted customer is identifiable',
            rows.find((r) => r.customerId === DEAD)?.problem,
            '404: HTTP 404',
        );
        check('(a) DISTINCT trace trees', trace.traceIds().length, 1);
        checkRequests(
            '(a) total customer requests',
            vendor.customerRequests,
            vendor.distinctIds,
            44,
        );
        checkSeq(
            '(a) requests for [healthy, deleted, throttled]',
            [
                vendor.requestsFor('cust-001'),
                vendor.requestsFor(DEAD),
                vendor.requestsFor(THROTTLED),
            ],
            [1, 4, 12],
        );
        note(
            '(a) → 28 healthy ids cost 1 request each; the 2 bad ones cost 16',
            'the coalescer collapses duplicates on the SUCCESS path only (C2 e), so each of the 4 orders naming a broken id runs its own attempts — and the throttled one runs 3 of them',
        );
    }

    // ── (b) the hand-rolled control ────────────────────────────────────────────────────────────
    {
        const { clock, vendor } = context();
        const done = handRolledOrdersWithCustomers({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            concurrency: BOUND,
            attempts: 3,
        });
        await runOut(clock, 120_000, 1_000);
        const rows = await done;

        check('(b) rows joined', rows.length, ORDERS);
        checkPeak('(b) peak in-flight', vendor.peakInFlight, BOUND, BOUND);
        check(
            '(b) requests for a HEALTHY duplicated id',
            vendor.requestsFor('cust-001'),
            1,
        );
        checkSeq('(b) ids flagged as a problem', flagged(rows).sort(), [
            DEAD,
            THROTTLED,
        ]);
        check(
            '(b) rows joined successfully',
            rows.filter((r) => r.problem === null).length,
            92,
        );
        checkSeq(
            '(b) row order === order order',
            rows.slice(0, 3).map((r) => r.orderId),
            ['ord-0001', 'ord-0002', 'ord-0003'],
        );
        checkRequests(
            '(b) total customer requests',
            vendor.customerRequests,
            vendor.distinctIds,
            32,
        );
        checkSeq(
            '(b) requests for [healthy, deleted, throttled]',
            [
                vendor.requestsFor('cust-001'),
                vendor.requestsFor(DEAD),
                vendor.requestsFor(THROTTLED),
            ],
            [1, 1, 3],
        );
    }

    // ── (c) where the two DIVERGE: the failure path ────────────────────────────────────────────
    // The only behavioural difference between the two implementations, and it goes against the
    // library. A `Map<id, Promise>` shares the rejection with every joiner; the engine's coalescer
    // releases them to re-run (engine.ts:1646-1659).
    {
        const stitched = context();
        const stitchedDone = ordersWithCustomers({
            baseUrl: BASE,
            adapter: stitched.vendor.adapter(),
            clock: stitched.clock,
            concurrency: BOUND,
            ttl: '60s',
            attempts: 1, // no retry, so the count is purely about coalescing
        });
        await runOut(stitched.clock, 120_000, 1_000);
        await stitchedDone;

        const rolled = context();
        const rolledDone = handRolledOrdersWithCustomers({
            baseUrl: BASE,
            adapter: rolled.vendor.adapter(),
            clock: rolled.clock,
            concurrency: BOUND,
            attempts: 1,
        });
        await runOut(rolled.clock, 120_000, 1_000);
        await rolledDone;

        check(
            '(c) StitchAPI — requests for the DELETED id (4 orders reference it)',
            stitched.vendor.requestsFor(DEAD),
            4,
        );
        check(
            '(c) hand-rolled — requests for the same id',
            rolled.vendor.requestsFor(DEAD),
            1,
        );
        check(
            '(c) StitchAPI — total customer requests',
            stitched.vendor.customerRequests,
            36,
        );
        check(
            '(c) hand-rolled — total customer requests',
            rolled.vendor.customerRequests,
            30,
        );
        note(
            '(c) → 6 extra requests here; at scale it is one per duplicate REFERENCE',
            'a list where 40 of 100 orders name one deleted customer costs 40 requests for that id under coalescing and 1 under a Map',
        );
    }

    // ── (d) the naive baseline, for the size of the gap ────────────────────────────────────────
    {
        const { clock, vendor } = context();
        const call = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            clock,
        });
        let rows = 0;
        let failure = '';
        const pending = Promise.all(
            idsOf(vendor.orders).map((id) => call({ params: { id } })),
        ).then(
            (v) => {
                rows = v.length;
            },
            (e: Error) => {
                failure = e.message;
            },
        );
        await runOut(clock, 120_000, 1_000);
        await pending;
        check('(d) `Promise.all(ids.map(call))` — rows joined', rows, 0);
        check('(d) …rejected with', failure, 'HTTP 404');
        checkRequests(
            '(d) …requests spent anyway',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        checkPeak('(d) …peak in-flight', vendor.peakInFlight, undefined, 100);
    }

    // ── (e) the line count ─────────────────────────────────────────────────────────────────────
    {
        const mine = executableLines('fanout.ts');
        const theirs = executableLines('hand-rolled.ts');
        check(
            '(e) StitchAPI answer (`fanout.ts`) — executable lines',
            mine,
            45,
        );
        check(
            '(e) hand-rolled (`hand-rolled.ts`) — executable lines',
            theirs,
            87,
        );
        note(
            '(e) → what became configuration',
            'the FIFO pool (~14 lines), the retry-with-jitter loop (~9), the retryable-status set, the non-2xx throw and the URL assembly',
        );
        note(
            '(e) → what did NOT shrink',
            'the per-row `problem` branch and the positional join are the same on both sides — partial failure is user code either way',
        );
    }

    finish(
        'C8',
        'ACHIEVABLE WITH USER CODE, and the user code is the partial-failure branch. Both implementations settle the same job identically over the same fake vendor and the same virtual clock: 1 list request, 100 rows joined in input order, peak in-flight 8 against a declared 8, ONE request for each healthy id even though four orders reference it, 92 rows joined and 8 flagged, and both bad ids identifiable (`404: HTTP 404` on the deleted one). The StitchAPI answer buys concurrency, duplicate collapsing, jittered retry and a single trace tree in four config fields, in 45 EXECUTABLE LINES against the control`s 87 — the difference is exactly the FIFO pool, the retry-with-jitter loop, the retryable-status set, the non-2xx throw and the URL assembly, all of which became configuration. What did NOT shrink is the per-row `problem` branch and the positional join: partial failure is user code on both sides. THE ONE PLACE IT LOSES IS THE FAILURE PATH. Full run: 44 customer requests against the hand-rolled 32, split [healthy 1, deleted 4, throttled 12] against [1, 1, 3]. With retry off so the count is purely about coalescing: 36 against 30, and the deleted customer cost FOUR requests against ONE. A failed leader releases its joiners to re-run (engine.ts:1646-1659) where a `Map<id, Promise>` shares the rejection, so the library spends one wasted request per duplicate REFERENCE to a broken id — exactly the shape a dead foreign key takes. The naive baseline is the size of the whole gap: `Promise.all(ids.map(call))` joined ZERO rows, spent all 100 requests anyway, and ran at peak 100 in flight',
    );
}

void main();
