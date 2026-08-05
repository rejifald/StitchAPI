// C7 — does a drifted page interact badly with the two edges scenarios 3 and 4 already measured:
// the ZERO-ITEM BREAK (engine.ts:984, taken before `next` is called) and the NON-ARRAY `items` WRAP
// (engine.ts:969-973)? And the third silent terminus nobody names: the default `pages: 50` cap.
//
// All three fire here. The worst is (a): drift alone produces an empty page in the MIDDLE of a
// collection that still has rows, the run ends successfully, and every reconciliation check agrees
// it is fine.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c7-drift-meets-the-edges.ts
import { stitch } from '../../../../packages/core/src/index';
import {
    LiveCollection,
    idsOf,
    pageSpine,
    rowsUrl,
    seedRows,
    totalOf,
} from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C7 — drift against the zero-item break, the wrap, and the cap');

    // ── (a) drift produces an EMPTY page mid-run, and the run ends OK ─────────────────────────
    // 12 rows. Page 1 returns r01..r04. Eight rows are then deleted, leaving four — r04, r10, r11,
    // r12 — so the client's next window (offset 4, limit 4) lands past the end of a collection that
    // still HAS rows it never saw. Zero items, break at engine.ts:984, success.
    {
        const server = new LiveCollection({ rows: seedRows(12) });
        server.afterRequest(1, () => {
            for (const id of [
                'r01',
                'r02',
                'r03',
                'r05',
                'r06',
                'r07',
                'r08',
                'r09',
            ])
                server.remove(id);
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(a) the run REPORTED SUCCESS', r.ok, true);
        check('(a) there is no error', r.error, null);
        check('(a) pages fetched', server.requests.length, 2);
        checkSeq(
            '(a) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | '],
        );
        checkSeq(
            '(a) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04'],
        );
        checkSeq('(a) SKIPPED ids', a.skipped, ['r10', 'r11', 'r12']);
        check('(a) rows the server still has', server.size, 4);
        check('(a) `total` on the last page', a.finalTotal, 4);
        check('(a) rows collected', collected.length, 4);
        check(
            '(a) …so the reconciler agrees: 4 collected, 4 declared',
            collected.length === a.finalTotal,
            true,
        );
        note(
            '(a) → three surviving rows never fetched, a successful run, and the ONE cheap detection the state of the art recommends confirms it',
            '',
        );
    }

    // ── (b) the same drift with the DEFAULT `items` never breaks ─────────────────────────────
    // Omit `items` and the `{ rows, total }` envelope is wrapped as ONE item per page
    // (engine.ts:969-973), so `items.length` is 1 even for a page with no rows and the zero-item
    // break can never fire. The loop then ends where `next` says — the lazy spelling is the one
    // that does not truncate. It just hands back envelopes instead of rows.
    {
        const server = new LiveCollection({ rows: seedRows(12) });
        server.afterRequest(1, () => {
            for (const id of [
                'r01',
                'r02',
                'r03',
                'r05',
                'r06',
                'r07',
                'r08',
                'r09',
            ])
                server.remove(id);
        });
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            paginate: {
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        });
        const r = await call.safe({ query: { limit: LIMIT, offset: 0 } });
        const agg = r.data as { rows: unknown[]; total: number }[];
        check('(b) the run REPORTED SUCCESS', r.ok, true);
        check('(b) elements in the aggregated array', agg.length, 2);
        checkSeq(
            '(b) …and each is a PAGE ENVELOPE, not a row',
            agg.map((p) => `${p.rows.length} rows/total ${p.total}`),
            ['4 rows/total 12', '0 rows/total 4'],
        );
        check(
            '(b) rows recoverable if you dig them out yourself',
            agg.flatMap((p) => p.rows).length,
            4,
        );
        note(
            '(b) → `data.length` is 2 for a 12-row collection. Any downstream `length` check — including a total reconciliation — is measuring the PAGE COUNT',
            '',
        );
    }

    // ── (c) `pick: "rows"` is the same trap as `items` ────────────────────────────────────────
    // `pick` runs per page at engine.ts:968, before `items`, so picking the array makes the default
    // `items` see it and the empty page breaks again. Both correct spellings truncate; only the
    // one that hands back the wrong shape survives.
    {
        const server = new LiveCollection({ rows: seedRows(12) });
        server.afterRequest(1, () => {
            for (const id of [
                'r01',
                'r02',
                'r03',
                'r05',
                'r06',
                'r07',
                'r08',
                'r09',
            ])
                server.remove(id);
        });
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            pick: 'rows',
            paginate: {
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        });
        const r = await call.safe({ query: { limit: LIMIT, offset: 0 } });
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        check('(c) pages fetched', server.requests.length, 2);
        checkSeq(
            '(c) ids the caller got',
            [idsOf(r.data).join(',')],
            ['r01,r02,r03,r04'],
        );
    }

    // ── (d) the THIRD silent terminus: the default `pages: 50` ────────────────────────────────
    // `paginate.pages` defaults to 50 (types.ts:1420-1421) and the cap shares the same `break` as
    // the zero-item case — before `next`, with no event, no error, and a `result` as if the
    // collection had ended. A sync job over a collection bigger than 50 pages returns a prefix.
    {
        const server = new LiveCollection({ rows: seedRows(220) });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        check('(d) there is no error', r.error, null);
        check(
            '(d) pages fetched (the default cap)',
            server.requests.length,
            50,
        );
        check('(d) rows collected', collected.length, 200);
        check('(d) `total` the server declared', a.finalTotal, 220);
        check('(d) rows SKIPPED', a.skipped.length, 20);
        checkSeq(
            '(d) the first and last skipped ids',
            [a.skipped[0], a.skipped.at(-1)],
            ['r201', 'r220'],
        );
        note(
            '(d) → this one a total reconciliation DOES catch (200 vs 220), and it is the only one of the four in this file that it catches',
            '',
        );
    }

    // ── (e) the cap, plus drift, in the shape a real sync job has ─────────────────────────────
    // Raise the cap and the same collection completes. The point is that the failure mode of the
    // default is a SHORTER LIST, not an error — identical in shape to (a) and to C2.
    {
        const server = new LiveCollection({ rows: seedRows(220) });
        const r = await offsetLoop({
            server,
            limit: LIMIT,
            paginate: { pages: 60 },
        }).run();
        const a = server.audit(idsOf(r.data));
        check('(e) the run REPORTED SUCCESS', r.ok, true);
        check('(e) pages fetched', server.requests.length, 55);
        checkSeq('(e) SKIPPED ids', a.skipped, []);
    }

    finish(
        'C7',
        'CONFIRMED, and the zero-item break is the sharpest of the three. Drift ALONE produced an empty page mid-run: eight deletes after page 1 left a 4-row collection, the client\'s offset-4 window came back empty, `paginated` broke at engine.ts:984 and the run ended ok having SKIPPED ["r10","r11","r12"] — with 4 collected against a declared total of 4, so the reconciler agrees. The default `items` wrap INVERTS the safety: an envelope is always 1 item, so the empty page never breaks the loop — but `data.length` is then 2 for a 12-row collection and every downstream count measures pages. `pick: "rows"` truncates exactly like `items`. And the default `pages: 50` is a third silent terminus at the same `break`: 220 rows returned 200, ok, no error, skipping ["r201".."r220"] — the only one of the four a total check catches',
    );
}

void main();
