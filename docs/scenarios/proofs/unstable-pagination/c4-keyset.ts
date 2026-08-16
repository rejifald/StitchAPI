// C4 — is KEYSET pagination expressible through `next(prevBody)`? This is the one thing the library
// should do well, and the capture says so. Run the SAME insert/delete workloads C1 and C2 measured
// damage on, against a seek endpoint, and check the result is correct, complete and duplicate-free.
//
// It is. And the honest caveat is at (e): keyset is a property of the SERVER'S SORT, not of the
// cursor the client sends — a vendor that accepts `(after_ts, after_id)` and still orders by
// `created_at` alone breaks it again, and no client can fix that either.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c4-keyset.ts
import {
    LiveCollection,
    idsOf,
    pageSpine,
    seedRows,
    seedRowsWithTie,
} from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { keysetLoop } from './keyset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C4 — keyset/seek through `paginate.next`');

    // ── (a) the clean case: it terminates, and it is correct ──────────────────────────────────
    // Note the extra request: seek has no `total` to compare against, so the loop runs until a
    // page comes back EMPTY — which is exactly the `items.length === 0` break at engine.ts:984,
    // used here for the one thing it is right for.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        const r = await keysetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(a) the run REPORTED SUCCESS', r.ok, true);
        check('(a) pages fetched', server.requests.length, 4);
        checkSeq(
            '(a) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | r05,r06,r07,r08 | r09,r10 | '],
        );
        checkSeq('(a) SKIPPED ids', a.skipped, []);
        checkSeq('(a) DUPLICATED ids', a.duplicated, []);
        check('(a) rows collected', collected.length, 10);
        checkSeq(
            '(a) the cursor each request carried',
            server.requests.map((q) => `${q.afterTs}/${q.afterId}`),
            ['0/', '400/r04', '800/r08', '1000/r10'],
        );
    }

    // ── (b) C1's workload — insert before the cursor ──────────────────────────────────────────
    // The cursor is a VALUE, not a position, so an insert behind it is simply behind it. C1
    // measured duplicated ["r04"] on the same write.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () =>
            server.insert({ id: 'x1', created_at: 250, name: 'inserted' }),
        );
        const r = await keysetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(b) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(b) SKIPPED ids', a.skipped, []);
        checkSeq('(b) DUPLICATED ids', a.duplicated, []);
        checkSeq(
            '(b) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04,r05,r06,r07,r08,r09,r10'],
        );
        note(
            '(b) → the inserted row x1 sorts behind the cursor and is correctly NOT returned; every stable row arrives exactly once',
            '',
        );
    }

    // ── (c) C2's workload — delete before the cursor ──────────────────────────────────────────
    // C2 measured skipped ["r05"] on this write, invisibly. Here r05 arrives.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r02'));
        const r = await keysetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(c) SKIPPED ids', a.skipped, []);
        checkSeq('(c) DUPLICATED ids', a.duplicated, []);
        check('(c) r05 arrived', collected.includes('r05'), true);
    }

    // ── (d) C3's workload — the tie case, still with no writes ────────────────────────────────
    // A seek endpoint orders by the composite key it takes a cursor on, so the tie group has a
    // total order and the rotation has nothing to rotate. C3 measured skipped ["r05"] +
    // duplicated ["r03"] on these exact rows.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(10, 3, 4),
            ties: true,
        });
        const r = await keysetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(d) SKIPPED ids', a.skipped, []);
        checkSeq('(d) DUPLICATED ids', a.duplicated, []);
        checkSeq(
            '(d) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04,r05,r06,r07,r08,r09,r10'],
        );
    }

    // ── (e) THE CAVEAT: a cursor the server does not sort by ──────────────────────────────────
    // Same client code, same composite cursor. The vendor accepts `after_ts`/`after_id` and its
    // ORDER BY is still `created_at` alone, so the tie group comes back rotated and the cursor is
    // taken from whatever row happened to land last. Rows the rotation left BEHIND that cursor are
    // then excluded by the very `>` that makes seek correct.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(10, 3, 4),
            ties: true,
            brokenSeek: true,
        });
        const r = await keysetLoop({ server, limit: 2 }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(e) the run REPORTED SUCCESS', r.ok, true);
        checkSeq(
            '(e) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02 | r04,r05 | r06,r07 | r08,r09 | r10 | '],
        );
        checkSeq('(e) SKIPPED ids', a.skipped, ['r03']);
        checkSeq('(e) DUPLICATED ids', a.duplicated, []);
        note(
            '(e) → an unbroken keyset loop, a correct composite cursor, zero writes, and r03 is gone. Keyset is a SERVER capability; the client half of it is four lines and it is not the half that decides',
            '',
        );
    }

    // ── (f) …and the same broken vendor duplicates too ────────────────────────────────────────
    // When the rotation ends a page on a LOWER tie member than one it already returned, the cursor
    // moves backwards inside the group and the rows above it come back a second time.
    {
        const server = new LiveCollection({
            rows: seedRowsWithTie(16, 10, 4),
            ties: true,
            brokenSeek: true,
        });
        const r = await keysetLoop({ server, limit: 3 }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(f) the run REPORTED SUCCESS', r.ok, true);
        checkSeq(
            '(f) what the server served, page by page',
            [pageSpine(server)],
            [
                'r01,r02,r03 | r04,r05,r06 | r07,r08,r09 | r13,r10,r11 | r12,r13,r14 | r15,r16 | ',
            ],
        );
        checkSeq('(f) SKIPPED ids', a.skipped, []);
        checkSeq('(f) DUPLICATED ids', a.duplicated, ['r13']);
        check('(f) rows collected for 16 rows', collected.length, 17);
    }

    finish(
        'C4',
        'CONFIRMED — this is the thing the library does well. `next` is handed the previous page\'s RAW body, so a composite `(created_at, id)` cursor is FOUR lines, and against a real seek endpoint it measured skipped [] / duplicated [] on every workload that broke offset: C1\'s insert (which cost duplicated ["r04"]), C2\'s delete (skipped ["r05"]) and C3\'s ties (skipped ["r05"] + duplicated ["r03"]) all came back complete and clean, 10 rows in cursor order. The loop terminates on the zero-item break at engine.ts:984, which is the one thing that break is right for. The caveat is measured at (e)/(f): the SAME four lines against a vendor that takes a composite cursor but does not ORDER BY it lost ["r03"] on one collection and duplicated ["r13"] on another, with no writes in either. The client half of keyset is four lines and it is not the half that decides',
    );
}

void main();
