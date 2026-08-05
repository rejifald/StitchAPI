// A fake, in-memory collection server that models a LIVE table — the ground truth every claim in
// this scenario is measured against.
//
// It serves the same rows three ways, so the only variable between claims is the PAGINATION
// CONTRACT and never the data:
//
//   - `GET /rows?offset=&limit=`         — offset/limit over the sorted collection.
//   - `GET /rows?after_ts=&after_id=&limit=` — keyset/seek: `(created_at, id) > (:after_ts, :after_id)`.
//   - both answer `{ rows, total, limit, offset? }` — every response carries a declared `total`.
//
// Rows are sorted by `(created_at, id)` ascending, which is the ONLY thing that makes offset
// deterministic in the first place. The `ties` variant deliberately breaks that: it sorts by
// `created_at` alone and ROTATES each tie group one position per query, which is a legal (if
// unhelpful) thing for a database to do when the ORDER BY is not a total order. No writes are
// involved in that variant at all.
//
// Writes land BETWEEN page fetches, not on a timer: `afterRequest(n, mutation)` runs `mutation`
// once request `n` has been answered, which is exactly the interleaving the scenario is about and
// is fully deterministic. Nothing here touches the network or the wall clock.
//
// The audit is the point. {@link LiveCollection.audit} compares what a run collected against what
// the server knows, using the only defensible definition of "correct" for a live collection:
//
//   STABLE = ids present at the start of the run AND still present at the end.
//   A correct paginator returns every stable id EXACTLY ONCE.
//   Rows created or destroyed mid-run are TRANSIENT — returning them or not is both defensible,
//   so they are reported separately and never counted as damage.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

/** One row in the collection. `created_at` is the sort field; `id` is the unique tiebreak. */
export interface Row {
    id: string;
    created_at: number;
    name: string;
}

/** One page as the server answered it — the wire shape every claim's `next` reads. */
export interface PageBody {
    rows: Row[];
    /** The collection's size AT THE MOMENT THIS PAGE WAS SERVED. It moves, which is the point. */
    total: number;
    limit: number;
    offset?: number;
}

/** One request, as the server saw it. `requests.length` IS the page count. */
export interface RecordedRequest {
    offset?: number;
    afterTs?: number;
    afterId?: string;
    limit: number;
    /** Ids this request answered with — the per-page spine a claim prints. */
    returned: string[];
    /** `total` as declared on this response. */
    total: number;
}

/** What a run got, against what it should have got. Every field is a list of ids. */
export interface Audit {
    /** Ids the run collected, in order, duplicates included. */
    collected: string[];
    /** Ids present at the start of the run AND at the end — the rows a correct run must return. */
    stable: string[];
    /** Stable ids the run NEVER returned. **Empty is the only correct value.** */
    skipped: string[];
    /** Ids the run returned more than once. **Empty is the only correct value.** */
    duplicated: string[];
    /** Returns beyond the first, summed over every id — 0 when nothing repeated. */
    duplicateCount: number;
    /** Ids created or destroyed mid-run. Returning them is defensible either way; not damage. */
    transient: string[];
    /** `total` on the LAST page the server served — what a reconciler would compare against. */
    finalTotal: number;
}

export interface CollectionOptions {
    rows: Row[];
    /**
     * Sort by `created_at` alone and rotate each tie group one position per query, modelling a
     * non-unique ORDER BY whose ties come back in a different order every time. No writes needed —
     * this alone breaks offset pagination, which is C3.
     */
    ties?: boolean;
    /**
     * Make the SEEK endpoint sort by `created_at` alone too — a vendor that accepts a composite
     * cursor but whose `ORDER BY` is still not a total order. C4 measures it to show that keyset
     * is a property of the server's sort, not of the cursor the client sends. Default `false`: a
     * seek endpoint orders by `(created_at, id)`, which is what makes it a seek endpoint.
     */
    brokenSeek?: boolean;
}

const ROWS_URL = 'https://api.example.test/rows';

/** The endpoint every claim points a stitch at. */
export const rowsUrl = ROWS_URL;

/** Build `n` rows `r01..rNN`, `created_at` 100, 200, 300… — distinct, so `(created_at, id)` is total. */
export function seedRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `r${String(i + 1).padStart(2, '0')}`,
        created_at: (i + 1) * 100,
        name: `row ${i + 1}`,
    }));
}

/**
 * Build `n` rows where `tieAt` consecutive rows starting at `tieFrom` (1-based) SHARE one
 * `created_at`. The sort key is no longer a total order, so the server is free to return that group
 * in any order — and this one does.
 */
export function seedRowsWithTie(
    n: number,
    tieFrom: number,
    tieAt: number,
): Row[] {
    return seedRows(n).map((r, i) => {
        const pos = i + 1;
        const inTie = pos >= tieFrom && pos < tieFrom + tieAt;
        return inTie ? { ...r, created_at: tieFrom * 100 } : r;
    });
}

export class LiveCollection {
    /** Every request the server answered, in order. */
    readonly requests: RecordedRequest[] = [];
    /** Ids present when the run started — half of the STABLE set. */
    readonly initialIds: string[];

    private rows: Row[];
    private readonly ties: boolean;
    private readonly brokenSeek: boolean;
    private queries = 0;
    private readonly pending = new Map<number, () => void>();
    private readonly failures = new Map<number, number>();

    constructor(opts: CollectionOptions) {
        this.rows = [...opts.rows];
        this.ties = opts.ties ?? false;
        this.brokenSeek = opts.brokenSeek ?? false;
        this.initialIds = this.ordered(0, true).map((r) => r.id);
    }

    /** Ids present right now, in server order. The other half of the STABLE set. */
    get currentIds(): string[] {
        return this.ordered(0, true).map((r) => r.id);
    }

    /** Collection size right now — what the server declares as `total`. */
    get size(): number {
        return this.rows.length;
    }

    /**
     * Run `mutation` once request number `n` (1-based) has been ANSWERED, i.e. in the gap before
     * request `n + 1`. This is the whole scenario: a write that lands between two page fetches.
     */
    afterRequest(n: number, mutation: () => void): this {
        this.pending.set(n, mutation);
        return this;
    }

    /**
     * Answer request number `n` (1-based, counting every hit including this one) with `status`
     * instead of a page. Used to measure that the resilience stack applies PER PAGE.
     */
    failRequest(n: number, status: number): this {
        this.failures.set(n, status);
        return this;
    }

    /** Insert a row. Sorted into place by `created_at`, so `at` decides which side of a cursor it lands. */
    insert(row: Row): void {
        this.rows.push(row);
    }

    /** Delete a row by id. Returns whether it was there. */
    remove(id: string): boolean {
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => r.id !== id);
        return this.rows.length < before;
    }

    /** The ids a given offset window WOULD return right now — used to name the row a drift moved. */
    windowAt(offset: number, limit: number): string[] {
        return this.ordered(0)
            .slice(offset, offset + limit)
            .map((r) => r.id);
    }

    /**
     * Compare a run's collected ids against the ground truth. See the module header for why STABLE
     * (present at start AND end) is the right yardstick for a collection that is being written to.
     */
    audit(collected: string[]): Audit {
        const now = new Set(this.currentIds);
        const start = new Set(this.initialIds);
        const stable = this.initialIds.filter((id) => now.has(id));
        const seen = new Map<string, number>();
        for (const id of collected) seen.set(id, (seen.get(id) ?? 0) + 1);
        const duplicated = [...seen.entries()]
            .filter(([, n]) => n > 1)
            .map(([id]) => id);
        let duplicateCount = 0;
        for (const n of seen.values()) duplicateCount += n - 1;
        const transient = [
            ...this.initialIds.filter((id) => !now.has(id)),
            ...this.currentIds.filter((id) => !start.has(id)),
        ];
        return {
            collected,
            stable,
            skipped: stable.filter((id) => !seen.has(id)),
            duplicated,
            duplicateCount,
            transient,
            finalTotal: this.requests.at(-1)?.total ?? 0,
        };
    }

    /** The transport every claim plugs into `stitch({ adapter })`. */
    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> =>
            this.serve(req);
    }

    // The collection in server order for query number `q`. Distinct `created_at` ⇒ `(created_at,
    // id)` is a total order and `q` is irrelevant. With `ties`, the comparator is `created_at`
    // alone and each tie group is rotated by `q` — a legal answer to an ORDER BY that does not
    // uniquely determine an order, and the entire content of C3. `forceTotalOrder` restores the
    // `(created_at, id)` comparator for the seek endpoint, which is what makes seek work.
    private ordered(q: number, forceTotalOrder = false): Row[] {
        const rotate = this.ties && !forceTotalOrder;
        const sorted = [...this.rows].sort((a, b) =>
            a.created_at !== b.created_at
                ? a.created_at - b.created_at
                : rotate
                  ? 0
                  : a.id < b.id
                    ? -1
                    : 1,
        );
        if (!rotate) return sorted;
        const out: Row[] = [];
        for (let i = 0; i < sorted.length;) {
            let j = i;
            while (
                j < sorted.length &&
                sorted[j]!.created_at === sorted[i]!.created_at
            )
                j++;
            const group = sorted.slice(i, j);
            const shift = group.length > 1 ? q % group.length : 0;
            out.push(...group.slice(shift), ...group.slice(0, shift));
            i = j;
        }
        return out;
    }

    private serve(req: AdapterRequest): AdapterResponse {
        const url = new URL(req.url);
        const q = url.searchParams;
        const limit = Number(q.get('limit') ?? 10);
        const failWith = this.failures.get(this.requests.length + 1);
        if (failWith !== undefined) {
            this.requests.push({ limit, returned: [], total: -1 });
            return {
                status: failWith,
                headers: {},
                body: { error: 'upstream' },
            };
        }
        const seeking = q.has('after_ts') || q.has('after_id');
        // A seek endpoint orders by the composite key it takes a cursor on; the offset endpoint
        // orders by whatever the collection was configured with. `brokenSeek` collapses them.
        const view = this.ordered(this.queries, seeking && !this.brokenSeek);
        this.queries += 1;

        let rows: Row[];
        let offset: number | undefined;
        if (seeking) {
            const afterTs = Number(q.get('after_ts'));
            const afterId = q.get('after_id') ?? '';
            rows = view
                .filter(
                    (r) =>
                        r.created_at > afterTs ||
                        (r.created_at === afterTs && r.id > afterId),
                )
                .slice(0, limit);
        } else {
            // No cursor: the head of the collection. This is both `offset=0` and the seek loop's
            // entry point (`LIMIT n` with no `WHERE`) — they are the same request.
            offset = Number(q.get('offset') ?? 0);
            rows = view.slice(offset, offset + limit);
        }

        const body: PageBody = {
            rows,
            total: this.rows.length,
            limit,
            ...(offset === undefined ? {} : { offset }),
        };
        const record: RecordedRequest = {
            limit,
            returned: rows.map((r) => r.id),
            total: body.total,
            ...(offset === undefined ? {} : { offset }),
        };
        if (q.has('after_ts')) {
            record.afterTs = Number(q.get('after_ts'));
            record.afterId = q.get('after_id') ?? '';
        }
        this.requests.push(record);

        // The write lands HERE — after this page was answered, before the next one is asked for.
        this.pending.get(this.requests.length)?.();
        this.pending.delete(this.requests.length);

        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body,
        };
    }
}

// ---- body readers the claims share ----------------------------------------

/** Pull the rows array off a page body. */
export function rowsOf(body: unknown): Row[] {
    return (body as PageBody | undefined)?.rows ?? [];
}

/** Pull the declared `total` off a page body. */
export function totalOf(body: unknown): number | undefined {
    return (body as PageBody | undefined)?.total;
}

/** Ids of whatever a run handed back — the aggregated array, however it was shaped. */
export function idsOf(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((v) => (v as Row | undefined)?.id ?? String(v))
        : [];
}

/** Compact one-line rendering of a run: `r01,r02 | r04,r05` — pages separated, ids in order. */
export function pageSpine(server: LiveCollection): string {
    return server.requests.map((r) => r.returned.join(',')).join(' | ');
}
