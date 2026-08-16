// The assembled answer C8 runs: page a live collection as honestly as a client can.
//
//   - keyset where the vendor offers it — the only construction that is actually CORRECT;
//   - offset where it does not, with the damage DETECTED rather than hidden: dedupe, a `total`
//     that moved under the cursor, an empty page mid-run, and the page cap;
//   - the rows and the verdict handed back as ONE value, so a caller cannot read the rows without
//     the verdict being right there.
//
// The construction is: capture per-page facts in `transform` (it runs on every page including the
// terminal one, engine.ts:967, above the zero-item break at 984), decide once in `output` (it runs
// over the aggregated array, engine.ts:993, and its return value REPLACES the result at
// engine.ts:1005). Nothing here lives inside the loop, so nothing here can shorten the run — which
// is the mistake C5(b) measured a deduping `items` making.
//
// A fresh stitch per run is deliberate, not incidental: the closure below is per-run state, and
// C8(f) measures what re-using one stitch across two runs costs.
import { stitch } from '../../../../packages/core/src/index';
import type { LiveCollection, PageBody, Row } from './fake-collection';
import { rowsOf, rowsUrl, totalOf } from './fake-collection';

/** The rows AND what is known about how reliable they are. There is no way to get one without the other. */
export interface SyncResult {
    rows: Row[];
    pagesFetched: number;
    declaredTotal: number;
    /** Ids the server returned more than once. Proof of drift. */
    duplicates: string[];
    /** `[first, last]` when the declared `total` moved during the run — proof the collection changed. */
    totalMoved: [number, number] | null;
    /** 1-based page index of a page that came back empty mid-run; `null` when none did. */
    emptyPageAt: number | null;
    /** The `pages` cap ended the run rather than the collection did. */
    capReached: boolean;
    /** Distinct rows collected disagrees with the last declared `total`. */
    countMismatch: boolean;
    /**
     * Whether the caller may treat this list as a complete, exact snapshot. `false` means "re-sync",
     * not "some rows are wrong" — a client cannot tell which.
     */
    trustworthy: boolean;
}

export interface SyncOptions {
    server: LiveCollection;
    limit: number;
    /** `'keyset'` when the vendor offers a seek endpoint. Never silently fall back. */
    mode: 'keyset' | 'offset';
    /** Page cap. Pass it explicitly — the default 50 is a silent terminus (C7(d)). */
    pages: number;
}

/* <count:begin> */
export function syncCollection(opts: SyncOptions): Promise<SyncResult> {
    const { server, limit, mode, pages } = opts;
    const keyset = mode === 'keyset';
    const totals: number[] = [];
    const pageSizes: number[] = [];

    const call = stitch({
        url: rowsUrl,
        adapter: server.adapter(),
        // Every page, terminal one included — above the zero-item break.
        transform: (page: unknown) => {
            totals.push(totalOf(page) ?? -1);
            pageSizes.push(rowsOf(page).length);
            return page;
        },
        // Once, over the aggregate. Its return value IS the result.
        output: {
            async validate(value: unknown) {
                const all = value as Row[];
                const seen = new Set<string>();
                const rows: Row[] = [];
                const duplicates: string[] = [];
                for (const row of all)
                    if (seen.has(row.id)) duplicates.push(row.id);
                    else {
                        seen.add(row.id);
                        rows.push(row);
                    }
                const first = totals[0] ?? 0;
                const declaredTotal = totals.at(-1) ?? 0;
                const emptyPageAt = pageSizes.findIndex((n) => n === 0);
                const capReached = pageSizes.length >= pages;
                // Under keyset the cursor is a VALUE, so a moving `total`, a short page and the
                // terminal empty page are all normal. Under offset every one of them is drift.
                const totalMoved =
                    !keyset && first !== declaredTotal
                        ? ([first, declaredTotal] as [number, number])
                        : null;
                const countMismatch = !keyset && rows.length !== declaredTotal;
                const emptyMidRun =
                    !keyset && emptyPageAt > 0 ? emptyPageAt + 1 : null;
                return {
                    ok: true as const,
                    value: {
                        rows,
                        pagesFetched: pageSizes.length,
                        declaredTotal,
                        duplicates: [...new Set(duplicates)],
                        totalMoved,
                        emptyPageAt: emptyMidRun,
                        capReached,
                        countMismatch,
                        trustworthy:
                            duplicates.length === 0 &&
                            totalMoved === null &&
                            emptyMidRun === null &&
                            !capReached &&
                            !countMismatch,
                    } satisfies SyncResult,
                };
            },
        },
        paginate: {
            pages,
            items: (page: unknown) => rowsOf(page),
            next: keyset
                ? (prev: unknown) => {
                      const last = (prev as PageBody).rows.at(-1);
                      return last === undefined
                          ? undefined
                          : {
                                query: {
                                    after_ts: last.created_at,
                                    after_id: last.id,
                                },
                            };
                  }
                : (prev: unknown, fetched: number) =>
                      fetched * limit < (totalOf(prev) ?? 0)
                          ? { query: { offset: fetched * limit } }
                          : undefined,
        },
    });

    return call.unwrap(
        keyset
            ? { query: { limit, after_ts: 0, after_id: '' } }
            : { query: { limit, offset: 0 } },
    ) as Promise<SyncResult>;
}
/* <count:end> */
