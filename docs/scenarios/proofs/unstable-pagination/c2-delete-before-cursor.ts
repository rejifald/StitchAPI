// C2 — a row is DELETED before the cursor between page 1 and page 2. The capture predicts the
// aggregated array contains a record TWICE, and asks whether anything flags it.
//
// Nothing appears twice. A row is LOST — the polarity is backwards here too, and this is the half
// that actually hurts, because a duplicate is at least visible in the data. A delete before the
// cursor pulls every later row to a LOWER index, so the row that was about to be page 2's first
// slides back into page 1's territory, which the client has already passed.
//
// And the count still adds up. That is the finding.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c2-delete-before-cursor.ts
import { LiveCollection, idsOf, pageSpine, seedRows } from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C2 — delete before the cursor, between page 1 and page 2');

    // ── (a) one delete behind the cursor loses exactly one row ────────────────────────────────
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r02'));
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(a) the run REPORTED SUCCESS', r.ok, true);
        check('(a) there is no error', r.error, null);
        check('(a) pages fetched', server.requests.length, 3);
        checkSeq(
            '(a) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | r06,r07,r08,r09 | r10'],
        );
        checkSeq(
            '(a) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04,r06,r07,r08,r09,r10'],
        );
        checkSeq('(a) SKIPPED ids', a.skipped, ['r05']);
        checkSeq('(a) DUPLICATED ids', a.duplicated, []);
        check('(a) rows handed back', collected.length, 9);
        note(
            '(a) → r05 was never deleted, never edited, and was never returned',
            '',
        );
    }

    // ── (b) THE TRAP: the arithmetic still balances ───────────────────────────────────────────
    // The delete removes one row from `total` at the same moment it removes one row from the
    // result, so `collected.length === total`. The single cheapest detection the state of the art
    // recommends — reconcile against the declared total — sees a perfectly consistent run.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r02'));
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(b) rows collected', collected.length, 9);
        check('(b) `total` on the LAST page', a.finalTotal, 9);
        check(
            '(b) length === total, so a reconciler sees nothing',
            collected.length === a.finalTotal,
            true,
        );
        check('(b) distinct ids collected', new Set(collected).size, 9);
        checkSeq('(b) …and yet, SKIPPED ids', a.skipped, ['r05']);
        checkSeq(
            '(b) the result carries a row that no longer exists',
            a.transient,
            ['r02'],
        );
        note(
            '(b) → 9 of 9, no duplicates, one row missing and one tombstone in its place',
            '',
        );
    }

    // ── (c) two deletes behind the cursor lose two rows, and the count STILL balances ─────────
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => {
            server.remove('r02');
            server.remove('r03');
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(c) SKIPPED ids', a.skipped, ['r05', 'r06']);
        checkSeq('(c) DUPLICATED ids', a.duplicated, []);
        check('(c) rows collected', collected.length, 8);
        check('(c) `total` on the LAST page', a.finalTotal, 8);
    }

    // ── (d) a delete AHEAD of the cursor does no damage ───────────────────────────────────────
    // The direction, machine-checked from the other side: only deletes BEHIND the cursor skip.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r09'));
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const a = server.audit(idsOf(r.data));
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(d) SKIPPED ids', a.skipped, []);
        checkSeq('(d) DUPLICATED ids', a.duplicated, []);
        checkSeq('(d) the deleted row is simply absent', a.transient, ['r09']);
    }

    // ── (e) does ANYTHING flag it? ────────────────────────────────────────────────────────────
    // The capture's actual question. Every observable the library offers, on the run from (a).
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r02'));
        const { call } = offsetLoop({ server, limit: LIMIT });
        const evts = [];
        for await (const e of call.stream({
            query: { limit: LIMIT, offset: 0 },
        }))
            evts.push(e);

        check(
            '(e) `error` events',
            evts.filter((e) => e.type === 'error').length,
            0,
        );
        check(
            '(e) `drift` events',
            evts.filter((e) => e.type === 'drift').length,
            0,
        );
        check('(e) `done.ok`', evts.find((e) => e.type === 'done')?.ok, true);
        checkSeq(
            '(e) every `paginate` progress line the run emitted',
            evts
                .filter((e) => e.type === 'progress' && e.phase === 'paginate')
                .map((e) => (e as { detail?: string }).detail),
            [
                'page 1 (+4, total 4)',
                'page 2 (+4, total 8)',
                'page 3 (+1, total 9)',
            ],
        );
        note(
            '(e) → the only per-page number the library reports is a RUNNING COUNT of aggregated items (engine.ts:976-982). It never names an id, never compares to the declared `total`, and reads identically on a clean run',
            '',
        );
    }

    finish(
        'C2',
        'REFUTED IN DIRECTION, AND WORSE THAN PREDICTED. A delete before the cursor does NOT duplicate — it SKIPS: measured skipped ["r05"], duplicated [], 9 rows returned, run ok. The trap is that the arithmetic balances: `total` dropped to 9 at the same moment the row was lost, so length === total === 9 with distinct ids and r05 missing — the cheap reconciliation the state of the art recommends detects NOTHING here. Two deletes skip ["r05","r06"] and still balance at 8 === 8. No error, no drift finding, and the only per-page signal is a running item count',
    );
}

void main();
