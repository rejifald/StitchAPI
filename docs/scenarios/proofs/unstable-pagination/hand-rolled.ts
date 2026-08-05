// The same feature set as `sync-collection.ts` with no library at all, against the same fake
// server — the baseline C8 prices the library against.
//
// Feature parity, deliberately: two pagination modes with no silent fallback, query-string
// building, a page cap, dedupe by id, duplicate collection, the `total` moved-under-the-cursor
// check, the empty-page-mid-run check, the count check, one verdict object, and a non-2xx that
// fails rather than being aggregated as a value.
import type { PageBody, Row } from './fake-collection';
import { rowsUrl } from './fake-collection';
import type { SyncOptions, SyncResult } from './sync-collection';

/* <count:begin> */
export async function handRolledSync(opts: SyncOptions): Promise<SyncResult> {
    const { server, limit, mode, pages } = opts;
    const keyset = mode === 'keyset';
    const adapter = server.adapter();
    const all: Row[] = [];
    const totals: number[] = [];
    const pageSizes: number[] = [];
    let cursor: { after_ts: number; after_id: string } | null = keyset
        ? { after_ts: 0, after_id: '' }
        : null;
    let offset = 0;

    for (let page = 0; page < pages; page++) {
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor) {
            q.set('after_ts', String(cursor.after_ts));
            q.set('after_id', cursor.after_id);
        } else q.set('offset', String(offset));
        const res = await adapter({
            url: `${rowsUrl}?${q.toString()}`,
            method: 'GET',
            headers: {},
        });
        if (res.status < 200 || res.status >= 300)
            throw new Error(`GET ${rowsUrl} failed: ${res.status}`);
        const body = res.body as PageBody;
        totals.push(body.total);
        pageSizes.push(body.rows.length);
        all.push(...body.rows);
        if (keyset) {
            const last = body.rows.at(-1);
            if (!last) break;
            cursor = { after_ts: last.created_at, after_id: last.id };
        } else {
            if (body.rows.length === 0) break;
            offset += limit;
            if (offset >= body.total) break;
        }
    }

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
    const emptyAt = pageSizes.findIndex((n) => n === 0);
    const totalMoved =
        !keyset && first !== declaredTotal
            ? ([first, declaredTotal] as [number, number])
            : null;
    const emptyPageAt = !keyset && emptyAt > 0 ? emptyAt + 1 : null;
    const capReached = pageSizes.length >= pages;
    const countMismatch = !keyset && rows.length !== declaredTotal;
    return {
        rows,
        pagesFetched: pageSizes.length,
        declaredTotal,
        duplicates: [...new Set(duplicates)],
        totalMoved,
        emptyPageAt,
        capReached,
        countMismatch,
        trustworthy:
            duplicates.length === 0 &&
            totalMoved === null &&
            emptyPageAt === null &&
            !capReached &&
            !countMismatch,
    };
}
/* <count:end> */
