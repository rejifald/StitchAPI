// C5 — can duplicates be DETECTED or REMOVED inside the library? Every seam a caller could reach
// for, measured on C1's workload (insert before the cursor → r04 twice): `items`, `transform`,
// `output` as a deduping validator, `output` as a rejecting validator, `output` wrapped in
// `drift()`, `hooks.onResponse`, a custom `Surface.interpret`, and `.report().raw`.
//
// Five of them work. Two of the five are BOOBY-TRAPPED, and it is the two a caller reaches for
// first — a dedupe that lives inside the loop can empty a page, and an empty page ends the run.
//
//   pnpm exec tsx docs/scenarios/proofs/unstable-pagination/c5-detection-seams.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    AdapterResponse,
    StitchEvent,
} from '../../../../packages/core/src/types';
import type { Validator } from '../../../../packages/core/src/validator';
import type { Row } from './fake-collection';
import {
    LiveCollection,
    idsOf,
    pageSpine,
    rowsOf,
    rowsUrl,
    seedRows,
    totalOf,
} from './fake-collection';
import { check, checkSeq, finish, heading, note } from './harness';
import { offsetLoop } from './offset-loop';

const LIMIT = 4;

/** The workload every seam is measured on: C1's insert, which delivers r04 twice. */
function driftedServer(): LiveCollection {
    const server = new LiveCollection({ rows: seedRows(10) });
    server.afterRequest(1, () =>
        server.insert({ id: 'x1', created_at: 250, name: 'inserted' }),
    );
    return server;
}

/** Drop rows whose id has already been seen. The stateful half of every in-loop seam. */
function makeDeduper(): (rows: Row[]) => Row[] {
    const seen = new Set<string>();
    return (rows) =>
        rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

async function main(): Promise<void> {
    heading('C5 — where a duplicate can be seen, and where it can be removed');

    // ── (a) `items` with a closure — it dedupes ───────────────────────────────────────────────
    // `items` runs per page (engine.ts:969-973) and is an ordinary function, so a closure carries
    // state across pages. On this workload it is correct.
    {
        const server = driftedServer();
        const dedupe = makeDeduper();
        const r = await offsetLoop({
            server,
            limit: LIMIT,
            paginate: { items: (v) => dedupe(rowsOf(v)) },
        }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(a) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(a) DUPLICATED ids', a.duplicated, []);
        checkSeq('(a) SKIPPED ids', a.skipped, []);
        check('(a) rows collected', collected.length, 10);
    }

    // ── (b) THE TRAP: the same `items` dedupe TRUNCATES the run ───────────────────────────────
    // Four rows inserted behind the cursor make page 2 a verbatim repeat of page 1. The deduper
    // returns zero items, `paginated` breaks at engine.ts:984 BEFORE calling `next`, and the run
    // ends OK with 4 of 14 rows. The fix for duplicates is a mechanism for losing rows.
    {
        const server = new LiveCollection({ rows: seedRows(10) });
        server.afterRequest(1, () => {
            for (let i = 1; i <= 4; i++)
                server.insert({ id: `x${i}`, created_at: 10 * i, name: 'ins' });
        });
        const dedupe = makeDeduper();
        const r = await offsetLoop({
            server,
            limit: LIMIT,
            paginate: { items: (v) => dedupe(rowsOf(v)) },
        }).run();
        const collected = idsOf(r.data);
        const a = server.audit(collected);
        check('(b) the run REPORTED SUCCESS', r.ok, true);
        check('(b) there is no error', r.error, null);
        check('(b) pages fetched', server.requests.length, 2);
        checkSeq(
            '(b) what the server served, page by page',
            [pageSpine(server)],
            ['r01,r02,r03,r04 | r01,r02,r03,r04'],
        );
        checkSeq(
            '(b) ids the caller got',
            [collected.join(',')],
            ['r01,r02,r03,r04'],
        );
        checkSeq('(b) SKIPPED ids', a.skipped, [
            'r05',
            'r06',
            'r07',
            'r08',
            'r09',
            'r10',
        ]);
        check('(b) `total` the server declared', a.finalTotal, 14);
        note(
            '(b) → 6 of 10 original rows lost, silently, BY THE DEDUPE. Without it the same run returns all ten (plus four repeats)',
            '',
        );
    }

    // ── (c) `transform` has the same reach and the same trap ──────────────────────────────────
    // It runs per page at engine.ts:967, before `pick` and before `items`, so a closure works
    // there too — and an emptied `rows` reaches the same break.
    {
        const server = driftedServer();
        const dedupe = makeDeduper();
        const r = await offsetLoop({
            server,
            limit: LIMIT,
            transform: (v) => ({
                ...(v as object),
                rows: dedupe(rowsOf(v)),
            }),
        }).run();
        const a = server.audit(idsOf(r.data));
        check('(c) the run REPORTED SUCCESS', r.ok, true);
        checkSeq('(c) DUPLICATED ids', a.duplicated, []);
        checkSeq('(c) SKIPPED ids', a.skipped, []);
    }

    // ── (d) `output` as a deduping validator — the SAFE seam ──────────────────────────────────
    // `validateOutput` runs ONCE, over the aggregated array, after the loop has finished
    // (engine.ts:993). Its returned value REPLACES the result (engine.ts:1005-1009), so a
    // hand-rolled `Validator` is a real post-processing hook. Nothing it does can shorten the run.
    {
        const server = driftedServer();
        const dedupeOutput: Validator<Row[]> = {
            async validate(value) {
                const seen = new Set<string>();
                const out: Row[] = [];
                for (const row of value as Row[])
                    if (!seen.has(row.id)) {
                        seen.add(row.id);
                        out.push(row);
                    }
                return { ok: true, value: out };
            },
        };
        const r = await offsetLoop({
            server,
            limit: LIMIT,
            output: dedupeOutput,
        }).run();
        const collected = idsOf(r.data);
        check('(d) the run REPORTED SUCCESS', r.ok, true);
        check('(d) pages fetched (unchanged)', server.requests.length, 3);
        check('(d) rows handed back', collected.length, 10);
        checkSeq('(d) DUPLICATED ids', server.audit(collected).duplicated, []);
        checkSeq('(d) SKIPPED ids', server.audit(collected).skipped, []);
    }

    // ── (e) `output` as a REJECTING validator — the run fails, loudly ─────────────────────────
    // The other half of the seam: returning `ok: false` makes the aggregate a contract violation,
    // which is the one way to turn drift into a failed call the caller cannot ignore.
    {
        const server = driftedServer();
        const rejectDuplicates: Validator<Row[]> = {
            async validate(value) {
                const rows = value as Row[];
                const ids = rows.map((row) => row.id);
                const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
                return dupes.length === 0
                    ? { ok: true, value: rows }
                    : {
                          ok: false,
                          issues: [
                              {
                                  path: [],
                                  message: `pagination drift: duplicate ids ${[...new Set(dupes)].join(',')}`,
                              },
                          ],
                      };
            },
        };
        const { call } = offsetLoop({
            server,
            limit: LIMIT,
            output: rejectDuplicates,
        });
        const r = await call.safe({ query: { limit: LIMIT, offset: 0 } });
        check('(e) the run FAILED', r.ok, false);
        check('(e) data', r.data, null);
        check(
            '(e) error message',
            (r.error as Error | null)?.message,
            'contract violation (drift)',
        );
        note(
            '(e) → the ISSUE text naming the duplicate ids does not reach `error.message`; the caller gets the generic contract-violation string',
            '',
        );

        const server2 = driftedServer();
        const rep = await stitch({
            url: rowsUrl,
            adapter: server2.adapter(),
            output: rejectDuplicates,
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        }).report({ query: { limit: LIMIT, offset: 0 } });
        check('(e) report.error is set', rep.error !== null, true);
        checkSeq(
            '(e) report.findings — the issue text, reachable here',
            rep.findings.map((f) => `${f.level}:${f.detail}`),
            ['error:pagination drift: duplicate ids r04'],
        );
        check(
            '(e) report.raw still carries the 11 aggregated rows',
            idsOf(rep.raw).length,
            11,
        );
        note(
            '(e) → `.report()`/`.inspect()` recover both the naming AND the partial data from a failed contract. `.safe()` alone recovers neither',
            '',
        );
    }

    // ── (f) `output` wrapped in `drift()` — dedupe AND a finding, on a run that still succeeds ─
    // `classifyDiff(raw, validated)` runs when the schema is wrapped (engine.ts:445-449), so the
    // rows the deduper removed come back as findings. They are levelled `info` and worded
    // `undeclared field`, because the diff engine is describing schema stripping, not row loss.
    {
        const server = driftedServer();
        const dedupeOutput: Validator<Row[]> = {
            async validate(value) {
                const seen = new Set<string>();
                const out: Row[] = [];
                for (const row of value as Row[])
                    if (!seen.has(row.id)) {
                        seen.add(row.id);
                        out.push(row);
                    }
                return { ok: true, value: out };
            },
        };
        const rep = await stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            output: {
                __kind: 'drift' as const,
                schema: dedupeOutput,
                options: {},
            },
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        }).report({ query: { limit: LIMIT, offset: 0 } });
        check('(f) report.error', rep.error, null);
        check('(f) rows in report.data (deduped)', idsOf(rep.data).length, 10);
        check('(f) rows in report.raw (aggregate)', idsOf(rep.raw).length, 11);
        checkSeq(
            '(f) findings',
            rep.findings.map((x) => `${x.level}|${x.change}|${x.path}`),
            [
                'warn|coerced|[].id',
                'warn|coerced|[].created_at',
                'warn|coerced|[].name',
                'info|undeclared|[]',
            ],
        );
        note(
            '(f) → four findings, none of which says "duplicate". Removing one element RE-INDEXES the array, so the positional diff reports every field of every later row as `coerced` (a string that changed) plus one `undeclared` element at the tail. It fires on the right event and describes something else entirely',
            '',
        );
    }

    // ── (g) `hooks.onResponse` — it SEES every page, and can change nothing ───────────────────
    // The hook is `(ctx) => void | Promise<void>` (types.ts:1285-1290) with the raw
    // `AdapterResponse`. It is the most complete view in the library and it is read-only.
    {
        const server = driftedServer();
        const seenPages: string[][] = [];
        const call = stitch({
            url: rowsUrl,
            adapter: server.adapter(),
            hooks: {
                onResponse: (ctx) => {
                    seenPages.push(
                        rowsOf((ctx.res as AdapterResponse).body).map(
                            (row) => row.id,
                        ),
                    );
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
        checkSeq(
            '(g) pages the hook observed',
            seenPages.map((p) => p.join(',')),
            ['r01,r02,r03,r04', 'r04,r05,r06,r07', 'r08,r09,r10'],
        );
        check('(g) the hook fired on EVERY page', seenPages.length, 3);
        check('(g) the result is unchanged by it', idsOf(r.data).length, 11);
    }

    // ── (h) a custom `Surface.interpret` — it can FAIL THE RUN mid-pagination ─────────────────
    // `interpret` runs per page inside the attempt loop (engine.ts:775). A `{ ok: false, message }`
    // on a 200 is returned rather than thrown (engine.ts:824-831), and `paginated` turns it into
    // an error event + `done(false)` (engine.ts:960-964). This is the ONLY seam that can stop the
    // run at the page where the drift happened, and the message reaches the caller intact.
    {
        const server = driftedServer();
        const seen = new Set<string>();
        const driftDetectingHttp: Surface = {
            id: 'http-drift-check',
            interpret: (res) => {
                const dupes = rowsOf(res.body)
                    .map((row) => row.id)
                    .filter((id) => seen.has(id));
                for (const row of rowsOf(res.body)) seen.add(row.id);
                return dupes.length === 0
                    ? { ok: true, data: res.body }
                    : {
                          ok: false,
                          message: `pagination drift: page repeated ${dupes.join(',')}`,
                      };
            },
        };
        const call = stitch({
            url: rowsUrl,
            kind: driftDetectingHttp,
            adapter: server.adapter(),
            paginate: {
                items: (v: unknown) => rowsOf(v),
                next: (prev: unknown, page: number) =>
                    page * LIMIT < (totalOf(prev) ?? 0)
                        ? { query: { offset: page * LIMIT } }
                        : undefined,
            },
        });
        const evts: StitchEvent[] = [];
        for await (const e of call.stream({
            query: { limit: LIMIT, offset: 0 },
        }))
            evts.push(e);
        const err = evts.find((e) => e.type === 'error');

        check('(h) pages fetched before it stopped', server.requests.length, 2);
        check(
            '(h) the run FAILED',
            evts.find((e) => e.type === 'done')?.ok,
            false,
        );
        check(
            '(h) the message reached the caller',
            err && 'message' in err ? err.message : undefined,
            'pagination drift: page repeated r04',
        );
        note(
            '(h) → detection at the page it happened, with the id named. The cost is that the aggregated rows are DISCARDED: a failed paginated run emits no `result` event',
            '',
        );
        check(
            '(h) `result` events on the failed run',
            evts.filter((e) => e.type === 'result').length,
            0,
        );
    }

    // ── (i) `.report().raw` — the aggregate, after the fact ───────────────────────────────────
    // Measured in C1(e): `raw` is the pre-validation aggregated array, duplicate included. It is a
    // real seam, and it costs a SECOND FULL PAGINATED RUN — `.report()`/`.inspect()` are fresh
    // probes, not observers of the call you already made.
    {
        const server = driftedServer();
        const { call } = offsetLoop({ server, limit: LIMIT });
        await call.safe({ query: { limit: LIMIT, offset: 0 } });
        const requestsAfterFirstRun = server.requests.length;
        const rep = await call.report({ query: { limit: LIMIT, offset: 0 } });
        check('(i) requests for the run itself', requestsAfterFirstRun, 3);
        check(
            '(i) requests after ALSO calling .report()',
            server.requests.length,
            6,
        );
        check('(i) rows in report.raw', idsOf(rep.raw).length, 11);
        check(
            '(i) duplicates in report.raw',
            idsOf(rep.raw).length - new Set(idsOf(rep.raw)).size,
            0,
        );
        note(
            '(i) → the probe paginated the collection a SECOND time, by which point the write had settled, so it did not reproduce the duplicate at all. `.report()` describes a run it just made, never the run you made',
            '',
        );
    }

    finish(
        'C5',
        'CONFIRMED WITH A TRAP. Five seams reach the duplicate. `items` and `transform` dedupe INSIDE the loop and both are booby-trapped: on a workload where page 2 repeats page 1 verbatim, the deduper emptied the page, `paginated` broke at engine.ts:984, and the run ended ok having SKIPPED ["r05".."r10"] — 6 rows lost BY the fix, against a declared total of 14. `output` is the safe seam: a hand-rolled Validator over the aggregated array either dedupes (10 rows, run ok, pages unchanged) or rejects (run fails, "contract violation (drift)"), and `.report()` recovers both the naming and the 11 partial rows that `.safe()` throws away. `drift()` turns the dedupe into 4 findings — 3 `coerced` and 1 `undeclared` — none of which says "duplicate", because removing an element re-indexes the array. `hooks.onResponse` sees all 3 pages and can change nothing. A custom `Surface.interpret` is the only seam that stops the run AT the drifted page with the id named — at the cost of discarding every row already collected. And `.report()` is a FRESH probe: it re-paginated the collection (3 more requests) and did not reproduce the duplicate at all',
    );
}

void main();
