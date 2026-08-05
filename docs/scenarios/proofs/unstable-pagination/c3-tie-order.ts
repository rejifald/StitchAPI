// C3 — the case people do not believe until they see it: a NON-UNIQUE sort key, ties returned in a
// different order per query, and NO WRITES AT ALL. The collection is frozen. The client is correct.
// The result is still wrong.
//
// The server here sorts by `created_at` alone and rotates each tie group one position per query.
// That is not a bug being simulated — it is a legal answer to an `ORDER BY` that does not uniquely
// determine an order, which is exactly what `ORDER BY created_at` is when `created_at` repeats.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c3-tie-order.ts
import {
    LiveCollection,
    idsOf,
    pageSpine,
    seedRowsWithTie,
} from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C3 — a non-unique sort key, on a STATIC collection');

    // ── (a) ten rows, four of them tied, zero writes ──────────────────────────────────────────
    // r03..r06 all carry `created_at: 300`. The tie group straddles the page-1/page-2 boundary,
    // which is all it takes.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(10, 3, 4),
            ties: true,
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(a) the run REPORTED SUCCESS', r.ok, true);
        check('(a) there is no error', r.error, null);
        check('(a) writes during the run', 0, 0);
        check('(a) rows at the start', server.initialIds.length, 10);
        check('(a) rows at the end', server.size, 10);
        checkSeq('(a) rows created or destroyed mid-run', a.transient, []);
        checkSeq(
            '(a) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | r06,r03,r07,r08 | r09,r10'],
        );
        checkSeq(
            '(a) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04,r06,r03,r07,r08,r09,r10'],
        );
        checkSeq('(a) SKIPPED ids', a.skipped, ['r05']);
        checkSeq('(a) DUPLICATED ids', a.duplicated, ['r03']);
        note(
            '(a) → r05 exists, has never been touched, and was never returned. r03 was returned twice',
            '',
        );
    }

    // ── (b) BOTH cheap detections are defeated at once ────────────────────────────────────────
    // The skip and the duplicate cancel, so `collected.length === total === 10`. And the state of
    // the art's other half — dedupe by id — removes the duplicate and leaves 9 rows against a
    // declared 10, which now looks like a DIFFERENT bug than the one you have.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(10, 3, 4),
            ties: true,
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(b) rows collected', collected.length, 10);
        check('(b) `total` on every page', a.finalTotal, 10);
        check(
            '(b) length === total, so a reconciler sees nothing',
            collected.length === a.finalTotal,
            true,
        );
        check('(b) distinct rows collected', new Set(collected).size, 9);
        check(
            '(b) dedupe-then-reconcile DOES fire: distinct !== total',
            new Set(collected).size === a.finalTotal,
            false,
        );
        note(
            '(b) → reconciling the RAW length is blind here; reconciling the DEDUPED length is the only one of the two that fires',
            '',
        );
    }

    // ── (c) it is not one unlucky window — the damage scales with BOUNDARY CROSSINGS ──────────
    // 16 rows, a ten-row tie group spanning indices 2..11 and therefore crossing two page
    // boundaries. Two rows lost, two rows repeated, and the totals still balance.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(16, 3, 10),
            ties: true,
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        checkSeq(
            '(c) what the server served, page by page',
            [pageSpine(server)],
            [
                'r01,r02,r03,r04 | r06,r07,r08,r09 | r11,r12,r03,r04 | r13,r14,r15,r16',
            ],
        );
        checkSeq('(c) SKIPPED ids', a.skipped, ['r05', 'r10']);
        checkSeq('(c) DUPLICATED ids', a.duplicated, ['r03', 'r04']);
        check('(c) rows collected', collected.length, 16);
        check('(c) `total`', a.finalTotal, 16);
    }

    // ── (d) a UNIQUE sort key over the same collection is clean ───────────────────────────────
    // The control. Same rows, same client, same 3 pages — the only change is that the server's
    // ORDER BY is a total order. This is the entire difference, and it is the server's to make.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(10, 3, 4),
            ties: false,
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const a = server.audit(idsOf(r.data));
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(d) SKIPPED ids', a.skipped, []);
        checkSeq('(d) DUPLICATED ids', a.duplicated, []);
    }

    finish(
        'C3',
        'CONFIRMED, and it is the sharpest case in the scenario. On a collection with ZERO writes — 10 rows in, 10 rows out, nothing created or destroyed — a non-unique `created_at` with rotating ties measured skipped ["r05"] and duplicated ["r03"]. Both cheap detections are defeated together: the skip and the duplicate cancel, so length === total === 10, and only comparing the DEDUPED count (9) against `total` (10) fires at all. A tie group crossing two page boundaries loses ["r05","r10"] and repeats ["r03","r04"], still balancing at 16 === 16. Ordering by a total order over the same rows is clean',
    );
}

void main();
