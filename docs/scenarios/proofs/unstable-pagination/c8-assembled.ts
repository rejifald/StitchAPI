// C8 — the most honest answer a client can assemble: keyset where the vendor offers it, and where
// it does not, offset with the damage DETECTED and handed back attached to the rows.
//
// The detector is not the one the state of the art recommends. Dedupe + reconcile-against-total was
// measured in C6 catching 2 of 3 damage cases and raising a false alarm on a fourth; the missing
// signal is that the DECLARED TOTAL ITSELF MOVED. A `total` that is 10 on page 1 and 9 on page 3 is
// proof the collection changed under the cursor, and it is the only thing that fires on C2.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c8-assembled.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import {
    LiveCollection,
    idsOf,
    rowsOf,
    rowsUrl,
    seedRows,
    seedRowsWithTie,
    totalOf,
} from './fake-collection';
import { handRolledSync } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import type { SyncResult } from './sync-collection';
import { syncCollection } from './sync-collection';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMIT = 4;

/** Count the CODE lines between the `<count:begin>` / `<count:end>` markers of a file. */
function countedLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8').split('\n');
    const from = src.findIndex((l) => l.includes('<count:begin>'));
    const to = src.findIndex((l) => l.includes('<count:end>'));
    return src
        .slice(from + 1, to)
        .filter(
            (l) =>
                l.trim() !== '' &&
                !l.trim().startsWith('//') &&
                !l.trim().startsWith('*') &&
                !l.trim().startsWith('/*'),
        ).length;
}

/** The eight workloads every construction in this file is measured over. */
const WORKLOADS: { label: string; build: () => LiveCollection }[] = [
    {
        label: 'clean            ',
        build: () => new LiveCollection({ rows: seedRows(10) }),
    },
    {
        label: 'insert behind    ',
        build: () => {
            const s = new LiveCollection({ rows: seedRows(10) });
            s.afterRequest(1, () =>
                s.insert({ id: 'x1', created_at: 250, name: 'i' }),
            );
            return s;
        },
    },
    {
        label: 'insert ahead     ',
        build: () => {
            const s = new LiveCollection({ rows: seedRows(10) });
            s.afterRequest(1, () =>
                s.insert({ id: 'x9', created_at: 550, name: 'i' }),
            );
            return s;
        },
    },
    {
        label: 'delete behind    ',
        build: () => {
            const s = new LiveCollection({ rows: seedRows(10) });
            s.afterRequest(1, () => s.remove('r02'));
            return s;
        },
    },
    {
        label: 'delete ahead     ',
        build: () => {
            const s = new LiveCollection({ rows: seedRows(10) });
            s.afterRequest(1, () => s.remove('r09'));
            return s;
        },
    },
    {
        label: 'ties, no writes  ',
        build: () =>
            new LiveCollection({ rows: seedRowsWithTie(10, 3, 4), ties: true }),
    },
    {
        label: 'collapse mid-run ',
        build: () => {
            const s = new LiveCollection({ rows: seedRows(12) });
            s.afterRequest(1, () => {
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
                    s.remove(id);
            });
            return s;
        },
    },
    {
        label: 'over the page cap',
        build: () => new LiveCollection({ rows: seedRows(28) }),
    },
];

/** Was the run actually damaged, per the server's ground truth? */
function damaged(server: LiveCollection, rows: { id: string }[]): boolean {
    const a = server.audit(rows.map((r) => r.id));
    // The deduped list is what the caller reads, so measure completeness against it.
    return a.skipped.length > 0;
}

async function main(): Promise<void> {
    heading('C8 — the assembled answer, and what it costs');

    // ── (a) offset mode: does the verdict track the ground truth? ─────────────────────────────
    {
        const flagged: boolean[] = [];
        const truth: boolean[] = [];
        for (const w of WORKLOADS) {
            const server = w.build();
            const r = await syncCollection({
                server,
                limit: LIMIT,
                mode: 'offset',
                pages: 6,
            });
            const isDamaged = damaged(server, r.rows);
            flagged.push(!r.trustworthy);
            truth.push(isDamaged);
            note(
                '(a)',
                `${w.label} damaged=${isDamaged ? 'YES' : 'no '} flagged=${
                    r.trustworthy ? 'no ' : 'YES'
                } | dup=[${r.duplicates}] totalMoved=${
                    r.totalMoved ? r.totalMoved.join('→') : '-'
                } emptyPage=${r.emptyPageAt ?? '-'} cap=${r.capReached} countMismatch=${r.countMismatch}`,
            );
        }
        checkSeq('(a) rows actually LOST, per workload', truth, [
            false,
            false,
            false,
            true,
            false,
            true,
            true,
            true,
        ]);
        checkSeq('(a) the verdict said "do not trust this"', flagged, [
            false,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
        ]);
        check(
            '(a) every damaged run was flagged (no false negatives)',
            truth.every((t, i) => !t || flagged[i]),
            true,
        );
        check(
            '(a) false alarms on undamaged runs',
            truth.filter((t, i) => !t && flagged[i]).length,
            3,
        );
        note(
            '(a) → zero false negatives and three false alarms. That is the right trade for a sync job: the verdict means "re-sync", not "these rows are wrong", and a client genuinely cannot tell the two apart',
            '',
        );
    }

    // ── (b) keyset mode: correct, and quiet ───────────────────────────────────────────────────
    // The same eight workloads against the seek endpoint. Nothing is lost, so nothing is flagged —
    // the moved-total and count checks are disabled under keyset because a cursor on a value is
    // immune to the thing they detect.
    {
        const lost: string[] = [];
        const flagged: string[] = [];
        for (const w of WORKLOADS) {
            const server = w.build();
            const r = await syncCollection({
                server,
                limit: LIMIT,
                mode: 'keyset',
                pages: 20,
            });
            if (damaged(server, r.rows)) lost.push(w.label.trim());
            if (!r.trustworthy) flagged.push(w.label.trim());
        }
        checkSeq('(b) workloads that lost rows under keyset', lost, []);
        checkSeq('(b) workloads flagged untrustworthy', flagged, []);
    }

    // ── (c) the shape the caller reads ────────────────────────────────────────────────────────
    // The rows and the verdict are ONE value — `output`'s return replaces the result
    // (engine.ts:1005-1009) — so there is no way to consume the rows without the verdict in scope.
    {
        const server = WORKLOADS[3]!.build(); // delete behind the cursor: C2's silent skip
        const r: SyncResult = await syncCollection({
            server,
            limit: LIMIT,
            mode: 'offset',
            pages: 6,
        });
        check('(c) rows handed back', r.rows.length, 9);
        check('(c) trustworthy', r.trustworthy, false);
        checkSeq('(c) totalMoved', r.totalMoved ?? [], [10, 9]);
        checkSeq('(c) duplicates', r.duplicates, []);
        check('(c) countMismatch', r.countMismatch, false);
        checkSeq(
            '(c) SKIPPED ids, per the server',
            server.audit(r.rows.map((row) => row.id)).skipped,
            ['r05'],
        );
        note(
            '(c) → the ONLY signal that fires on C2 is that `total` went 10 → 9. Dedupe is silent, the count matches, and there is no duplicate to find',
            '',
        );
    }

    // ── (d) the price, against the same feature set hand-rolled ───────────────────────────────
    {
        const lib = countedLines('sync-collection.ts');
        const hand = countedLines('hand-rolled.ts');
        check('(d) counted lines — library', lib, 84);
        check('(d) counted lines — hand-rolled', hand, 74);
        check('(d) is the library version SHORTER?', lib < hand, false);
        note(
            '(d)',
            `${lib} vs ${hand} — the library version is ${lib - hand} lines LONGER for this feature set. The detection logic is identical in both; what differs is that a hand-rolled paging loop is ~15 lines and the declarative equivalent (a stitch config, a transform, an output validator, a two-mode next) is ~25`,
        );

        // …and both produce the same verdicts, which is what makes the comparison fair.
        const libV: string[] = [];
        const handV: string[] = [];
        for (const w of WORKLOADS) {
            const a = await syncCollection({
                server: w.build(),
                limit: LIMIT,
                mode: 'offset',
                pages: 6,
            });
            const b = await handRolledSync({
                server: w.build(),
                limit: LIMIT,
                mode: 'offset',
                pages: 6,
            });
            libV.push(`${a.rows.length}/${a.trustworthy}`);
            handV.push(`${b.rows.length}/${b.trustworthy}`);
        }
        checkSeq('(d) library vs hand-rolled, rows/verdict', libV, handV);
    }

    // ── (e) what the library is actually contributing here ────────────────────────────────────
    // The honest accounting: the loop, the URL/query building, the merge of the next page's input
    // over the original, and the aggregation. Not the correctness, and not the detection.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        const r = await syncCollection({
            server,
            limit: LIMIT,
            mode: 'keyset',
            pages: 20,
        });
        check('(e) pages the engine drove', r.pagesFetched, 4);
        checkSeq(
            '(e) the cursor it threaded through, unaided',
            server.requests.map((q) => `${q.afterTs}/${q.afterId}`),
            ['0/', '400/r04', '800/r08', '1000/r10'],
        );
        note(
            '(e) → auth, retry, throttle, circuit and the trace apply to every page for free (engine.ts:946). That is real, and it is orthogonal to every number in this scenario',
            '',
        );
    }

    // ── (e2) …and here is the part the 74-line baseline does not have at ALL ──────────────────
    // Page 2 of 3 answers `500`. One config line retries THAT PAGE and the run completes with
    // every row. The hand-rolled loop has no retry, no backoff, no per-page budget — adding them
    // is where its line count goes, and it is the only axis on which the library is buying
    // anything in this scenario.
    {
        const clock = manualClock();
        const server = new LiveCollection({ rows: seedRows(10) });
        server.failRequest(2, 500);
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            clock,
            retry: { attempts: 2, on: [500], backoff: { base: 100 } },
            paginate: {
                items: (page: unknown) => rowsOf(page),
                next: (prev: unknown, fetched: number) =>
                    fetched * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: fetched * LIMIT } }
                        : undefined,
            },
        });
        const p = call.safe({ query: { limit: LIMIT, offset: 0 } });
        await clock.advance(10_000);
        const r = await p;
        check('(e2) the run REPORTED SUCCESS', r.ok, true);
        check(
            '(e2) wire requests (one of them a 500)',
            server.requests.length,
            4,
        );
        check('(e2) rows collected', idsOf(r.data).length, 10);
        checkSeq('(e2) SKIPPED ids', server.audit(idsOf(r.data)).skipped, []);
    }

    // ── (f) THE FOOTGUN in the construction: a REUSED stitch keeps its closure ────────────────
    // `sync-collection.ts` builds a fresh stitch per run for a reason. A stitch is meant to be
    // defined once and called many times; a deduping `items` with module-level state turns the
    // second call into an empty successful result, because every id is already "seen" and the
    // first page aggregates zero items — engine.ts:984 again.
    {
        const seen = new Set<string>();
        const shared = stitch({
            url: rowsUrl,
            adapter: new LiveCollection({ rows: seedRows(10) }).adapter(),
            paginate: {
                items: (page: unknown) =>
                    rowsOf(page).filter((row) =>
                        seen.has(row.id) ? false : (seen.add(row.id), true),
                    ),
                next: (prev: unknown, fetched: number) =>
                    fetched * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: fetched * LIMIT } }
                        : undefined,
            },
        });
        const first = await shared.safe({ query: { limit: LIMIT, offset: 0 } });
        const second = await shared.safe({
            query: { limit: LIMIT, offset: 0 },
        });
        check('(f) rows on the first call', idsOf(first.data).length, 10);
        check('(f) the second call REPORTED SUCCESS', second.ok, true);
        check('(f) rows on the second call', idsOf(second.data).length, 0);
        check('(f) error on the second call', second.error, null);
        note(
            '(f) → the natural way to write a deduping paginator — one stitch, defined once — returns an empty list on every call after the first, successfully',
            '',
        );
    }

    finish(
        'C8',
        "ASSEMBLED. Over 8 workloads the verdict had ZERO false negatives — every run that lost rows (delete-behind, ties, collapse-mid-run, over-the-cap) was flagged — and 3 false alarms on undamaged runs, which is the correct trade for a sync job. The signal that carries C2 is not dedupe and not the count: it is that the DECLARED TOTAL MOVED (10 → 9), the one check the state of the art does not name. Under keyset the same code lost nothing on all 8 and flagged nothing. Rows and verdict come back as ONE value because `output`'s return replaces the result (engine.ts:1005). Price: 84 counted lines against 74 hand-rolled — the library version is LONGER, because the detection is identical in both and a raw paging loop is cheaper to write than the declarative equivalent; the two agree on rows and verdict for all 8. What the 74 lines do not have is the resilience stack: one `retry` line recovered a page that answered 500 mid-run (4 wire requests, 10 rows, nothing skipped). The footgun in the construction is measured at (f): a deduping `items` on a REUSED stitch returns an empty array, successfully, on every call after the first",
    );
}

void main();
