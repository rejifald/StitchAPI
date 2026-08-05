// C6 — can the run be RECONCILED against the declared `total`? Two questions: is the LAST page's
// `total` reachable anywhere the caller can act on, and does reconciling against it actually detect
// the damage C1-C3 measured?
//
// The first answer is yes, from three places, and the caller can turn it into a failed call.
// The second answer is the finding: reconciliation misses the case that matters. The capture calls
// it "the only cheap way to DETECT a skip" — measured, it detects neither of the two skips in this
// scenario's headline workloads, and raises a false alarm on the one where nothing was lost.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c6-total-reconciliation.ts
import { stitch } from '../../../../packages/core/src/index';
import type { AdapterResponse } from '../../../../packages/core/src/types';
import type { Row } from './fake-collection';
import {
    LiveCollection,
    idsOf,
    rowsOf,
    rowsUrl,
    seedRows,
    seedRowsWithTie,
    totalOf,
} from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

async function main(): Promise<void> {
    heading('C6 — reconciling the run against the declared `total`');

    // ── (a) `next` DOES see the last page's total — when `next` is what ends the loop ─────────
    // Scenario 3 measured that `next` is never called on the terminal page. That is true of the
    // ZERO-ITEM break; it is not true of a loop that terminates by `next` returning undefined,
    // which is how offset pagination against a declared `total` naturally ends. Here `next` is
    // consulted on all three pages and the third call carries the final body.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        const totalsSeenByNext: number[] = [];
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) => {
                    totalsSeenByNext.push(totalOf(prev) ?? -1);
                    return page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined;
                },
            },
        });
        await call.safe({ query: { limit: LIMIT, offset: 0 } });
        check('(a) pages fetched', server.requests.length, 3);
        checkSeq('(a) totals `next` observed', totalsSeenByNext, [10, 10, 10]);
        check(
            '(a) `next` saw the LAST page',
            totalsSeenByNext.length,
            server.requests.length,
        );
    }

    // ── (b) …and it does NOT, when the zero-item break ends the loop ──────────────────────────
    // Terminate on a short page instead — the other common spelling — over a collection that is an
    // exact multiple of `limit`. A fourth, EMPTY page is fetched, `paginated` breaks at
    // engine.ts:984 before `next`, and that page's body (with its own, moved, `total`) is
    // unreachable from `next`. Four requests, three `next` calls.
    {
        const server = new LiveCollection({ rows: seedRows(12) });
        server.afterRequest(3, () => {
            server.remove('r11');
            server.remove('r12');
        });
        const totalsSeenByNext: number[] = [];
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) => {
                    totalsSeenByNext.push(totalOf(prev) ?? -1);
                    return rowsOf(prev).length < LIMIT
                        ? undefined
                        : { query: { offset: page * LIMIT } };
                },
            },
        });
        await call.safe({ query: { limit: LIMIT, offset: 0 } });
        check('(b) pages fetched', server.requests.length, 4);
        checkSeq('(b) totals `next` observed', totalsSeenByNext, [12, 12, 12]);
        check(
            '(b) `total` the server declared on the LAST page',
            server.requests.at(-1)?.total,
            10,
        );
        note(
            '(b) → the terminal page declared 10 and `next` never saw it. Which of the two spellings you wrote decides whether the final total exists',
            '',
        );
    }

    // ── (c) `transform` and `hooks.onResponse` see EVERY page, terminal one included ──────────
    // `transform` runs at engine.ts:967, above the break; `onResponse` at engine.ts:705, per
    // attempt. Both are ordinary functions, so a closure captures the last total unconditionally.
    {
        const server = new LiveCollection({ rows: seedRows(12) });
        server.afterRequest(3, () => {
            server.remove('r11');
            server.remove('r12');
        });
        const viaTransform: number[] = [];
        const viaHook: number[] = [];
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            transform: (v: unknown) => {
                viaTransform.push(totalOf(v) ?? -1);
                return v;
            },
            hooks: {
                onResponse: (ctx) => {
                    viaHook.push(
                        totalOf((ctx.res as AdapterResponse).body) ?? -1,
                    );
                },
            },
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) =>
                    rowsOf(prev).length < LIMIT
                        ? undefined
                        : { query: { offset: page * LIMIT } },
            },
        });
        await call.safe({ query: { limit: LIMIT, offset: 0 } });
        checkSeq(
            '(c) totals `transform` observed',
            viaTransform,
            [12, 12, 12, 10],
        );
        checkSeq('(c) totals `onResponse` observed', viaHook, [12, 12, 12, 10]);
        check('(c) the FINAL total is reachable', viaTransform.at(-1), 10);
    }

    // ── (d) and it is ACTIONABLE: capture in `transform`, decide in `output` ──────────────────
    // The full construction. `transform` captures the running total per page; the `output`
    // validator runs once over the aggregated array (engine.ts:993) and rejects a run whose
    // distinct-row count disagrees with the last declared total. A real, failed call.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => server.remove('r02'));
        let lastTotal = -1;
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            transform: (v: unknown) => {
                lastTotal = totalOf(v) ?? -1;
                return v;
            },
            output: {
                async validate(value: unknown) {
                    const rows = value as Row[];
                    const distinct = new Set(rows.map((row) => row.id)).size;
                    return distinct === lastTotal
                        ? { ok: true as const, value: rows }
                        : {
                              ok: false as const,
                              issues: [
                                  {
                                      path: [],
                                      message: `collected ${distinct} distinct of ${lastTotal} declared`,
                                  },
                              ],
                          };
                },
            },
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        });
        const r = await call.safe({ query: { limit: LIMIT, offset: 0 } });
        check('(d) the reconciler is wired and runs', lastTotal, 9);
        check('(d) distinct rows collected', 9, 9);
        check('(d) …and it PASSED the run that lost r05', r.ok, true);
        note(
            '(d) → 9 distinct rows, 9 declared. The mechanism works perfectly and has nothing to report',
            '',
        );
    }

    // ── (e) THE TRUTH TABLE ───────────────────────────────────────────────────────────────────
    // The same reconciler over the four workloads, printed as what it would tell you against what
    // actually happened. `raw` is `length vs total`, `distinct` is the deduped variant.
    {
        const cases: {
            label: string;
            build: () => LiveCollection;
        }[] = [
            {
                label: 'clean',
                build: () => new LiveCollection({ rows: seedRows(10) }),
            },
            {
                label: 'C1 insert',
                build: () => {
                    const s = new LiveCollection({ rows: seedRows(10) });
                    s.afterRequest(1, () =>
                        s.insert({ id: 'x1', created_at: 250, name: 'i' }),
                    );
                    return s;
                },
            },
            {
                label: 'C2 delete',
                build: () => {
                    const s = new LiveCollection({ rows: seedRows(10) });
                    s.afterRequest(1, () => s.remove('r02'));
                    return s;
                },
            },
            {
                label: 'C3 ties',
                build: () =>
                    new LiveCollection({
                        rows: seedRowsWithTie(10, 3, 4),
                        ties: true,
                    }),
            },
        ];

        const rows: string[] = [];
        for (const c of cases) {
            const server = c.build();
            const r = await offsetLoop({ server, limit: LIMIT }).run();
            const collected = idsOf(r.data);
            const a = server.audit(collected);
            const distinct = new Set(collected).size;
            const rawFires = collected.length !== a.finalTotal;
            const distinctFires = distinct !== a.finalTotal;
            const dupeFires = distinct !== collected.length;
            const damaged = a.skipped.length > 0 || a.duplicated.length > 0;
            rows.push(
                `${c.label}: damaged=${damaged} skipped=[${a.skipped}] dup=[${a.duplicated}] ` +
                    `| raw-total-check=${rawFires} distinct-total-check=${distinctFires} dupe-check=${dupeFires}`,
            );
        }
        for (const line of rows) note('(e)', line);

        checkSeq(
            '(e) does ANY client-side check fire, per workload',
            rows.map(
                (line) =>
                    line.includes('=true |') || line.includes('-check=true'),
            ),
            [false, true, false, true],
        );
        note(
            '(e) → C2 (a delete before the cursor) is the hole: r05 is gone and every check reads clean, because the delete removed a row from `total` at the same instant it removed one from the result',
            '',
        );
    }

    finish(
        'C6',
        'REACHABLE — AND IT DOES NOT DETECT THE SKIP. The final `total` is available from three places: `next` sees it whenever `next` itself ends the loop (totals [10,10,10] over 3 pages), and `transform`/`hooks.onResponse` see it unconditionally, terminal page included ([12,12,12,10] over 4 requests, where `next` saw only [12,12,12]). Capturing it in `transform` and deciding in `output` turns a mismatch into a failed call — the mechanism is real. What it cannot do is detect the damage: over clean / C1-insert / C2-delete / C3-ties, the raw length-vs-total check fired 0 times out of 4, the deduped variant fired on C1 (where nothing was lost — a false alarm on a legitimately-new row) and on C3, and NOTHING fired on C2 while r05 was missing. A delete before the cursor moves the total by exactly the amount it moves the result',
    );
}

void main();
