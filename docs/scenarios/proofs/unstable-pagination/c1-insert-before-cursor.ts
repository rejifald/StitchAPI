// C1 — a row is INSERTED before the cursor between page 1 and page 2. The capture predicts the
// aggregated array MISSES a record and asks which id is lost.
//
// Nothing is lost. The measured damage is a DUPLICATE, and the capture has the polarity of the
// whole failure mode backwards. An insert before the cursor shifts every later row to a HIGHER
// index, so the fixed offset the client sends next lands on a row it has ALREADY read.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c1-insert-before-cursor.ts
import { LiveCollection, idsOf, pageSpine, seedRows } from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C1 — insert before the cursor, between page 1 and page 2');

    // ── (a) the insert lands INSIDE the region page 1 already returned ────────────────────────
    // 10 rows, 4 per page. Page 1 answers r01..r04 and the row `x1` (created_at 250) is inserted
    // between r02 and r03 — squarely behind the cursor. The client then asks for offset 4.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () =>
            server.insert({ id: 'x1', created_at: 250, name: 'inserted' }),
        );
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);

        check('(a) the run REPORTED SUCCESS', r.ok, true);
        check('(a) there is no error', r.error, null);
        check('(a) pages fetched', server.requests.length, 3);
        checkSeq(
            '(a) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | r04,r05,r06,r07 | r08,r09,r10'],
        );
        checkSeq(
            '(a) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04,r04,r05,r06,r07,r08,r09,r10'],
        );
        checkSeq('(a) SKIPPED ids', a.skipped, []);
        checkSeq('(a) DUPLICATED ids', a.duplicated, ['r04']);
        check('(a) duplicate returns', a.duplicateCount, 1);
        check('(a) rows handed back', collected.length, 11);
        check('(a) distinct rows handed back', new Set(collected).size, 10);
        check('(a) rows the server has now', server.size, 11);
        note(
            '(a) → the capture predicted a LOST row. The measured damage is r04 delivered TWICE',
            '',
        );
    }

    // ── (b) the strongest form: the insert lands at the HEAD of the collection ────────────────
    // "Newest first, and a new row arrives" is the same shape — anything inserted into the region
    // already paged over shifts the window by one. Same duplicate, same id.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () =>
            server.insert({ id: 'x0', created_at: 50, name: 'head insert' }),
        );
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const a = server.audit(idsOf(r.data));
        check('(b) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(b) SKIPPED ids', a.skipped, []);
        checkSeq('(b) DUPLICATED ids', a.duplicated, ['r04']);
    }

    // ── (c) TWO inserts behind the cursor shift the window TWICE ──────────────────────────────
    // The damage scales with the write rate: n rows inserted behind the cursor re-deliver n rows.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => {
            server.insert({ id: 'x1', created_at: 150, name: 'i1' });
            server.insert({ id: 'x2', created_at: 250, name: 'i2' });
        });
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const a = server.audit(idsOf(r.data));
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(c) SKIPPED ids', a.skipped, []);
        checkSeq('(c) DUPLICATED ids', a.duplicated, ['r03', 'r04']);
        check('(c) duplicate returns', a.duplicateCount, 2);
    }

    // ── (d) an insert AHEAD of the cursor does no damage at all ───────────────────────────────
    // Machine-checks the direction: only the region BEHIND the cursor matters. `x9` lands in page
    // 2's own territory and is simply read, so an insert can never cause a skip.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () =>
            server.insert({ id: 'x9', created_at: 550, name: 'ahead' }),
        );
        const r = await offsetLoop({ server, limit: LIMIT }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(d) SKIPPED ids', a.skipped, []);
        checkSeq('(d) DUPLICATED ids', a.duplicated, []);
        checkSeq(
            '(d) the new row was picked up',
            [collected.join(',')],
            ['r01,r02,r03,r04,r05,x9,r06,r07,r08,r09,r10'],
        );
    }

    // ── (e) nothing in the library noticed ────────────────────────────────────────────────────
    // `.report()` is the run diagnostic — attempts, timing, findings, the raw pre-validation body.
    // The duplicate is IN `raw` and IN `data`, and `findings` is empty, because a duplicate is not
    // a schema violation. There is no drift event, no warning, no non-zero anything.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () =>
            server.insert({ id: 'x1', created_at: 250, name: 'inserted' }),
        );
        const { call } = offsetLoop({ server, limit: LIMIT });
        const rep = await call.report({ query: { limit: LIMIT, offset: 0 } });
        check('(e) report.error', rep.error, null);
        check('(e) report.findings', rep.findings.length, 0);
        check('(e) report.status', rep.status, 200);
        check('(e) report.attempts', rep.attempts, 1);
        check('(e) rows in report.data', idsOf(rep.data).length, 11);
        check(
            '(e) rows in report.raw (pre-validation aggregate)',
            idsOf(rep.raw).length,
            11,
        );
        note(
            '(e) → every diagnostic the library offers reports a clean run over an 11-element array with 10 distinct rows',
            '',
        );
    }

    finish(
        'C1',
        'REFUTED IN DIRECTION, CONFIRMED IN DAMAGE. An insert before the cursor does NOT lose a row — it DUPLICATES one: measured skipped [], duplicated ["r04"], 11 items for 10 distinct rows, and the run reported ok with error null, 0 findings and status 200. Two inserts duplicate two rows (["r03","r04"]); an insert AHEAD of the cursor does nothing. An offset insert can never cause a skip, which is the opposite of the capture',
    );
}

void main();
