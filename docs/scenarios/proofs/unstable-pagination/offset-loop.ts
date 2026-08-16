// The offset/limit `paginate` block every damage claim (C1, C2, C3, C6, C7) runs, in ONE place so
// that the only variable between them is what the server does.
//
// This is the loop a competent caller writes against an API that returns `{ rows, total }`: pull
// the rows with `items`, advance `offset` by `limit` with `next`, and stop when the offset passes
// the declared `total`. There is nothing wrong with it. That is the point of the scenario.
import { stitch } from '../../../../packages/core/src/index';
import type { SchemaLike } from '../../../../packages/core/src/infer';
import type { Stitch } from '../../../../packages/core/src/types';
import type { LiveCollection, PageBody } from './fake-collection';
import { rowsOf, rowsUrl } from './fake-collection';

export interface OffsetLoopOptions {
    server: LiveCollection;
    limit: number;
    /**
     * Stop on a short page (`rows.length < limit`) instead of on `offset >= total`. Both are common
     * spellings; C6 shows they terminate the run at DIFFERENT places, which decides whether `next`
     * ever sees the last page's `total`.
     */
    stopOnShortPage?: boolean;
    /** Extra `paginate` fields (a dedupe `items`, a page cap) a claim wants to layer on. */
    paginate?: { items?: (value: unknown) => unknown[]; pages?: number };
    /** Contract over the AGGREGATED array — the seam C5/C6/C8 use. */
    output?: SchemaLike;
    /** Per-page hook — the seam C6 uses to reach the terminal page's `total`. */
    transform?: (value: unknown) => unknown;
}

/** The stitch under test, plus the call that runs it from offset 0. */
export function offsetLoop(opts: OffsetLoopOptions): {
    call: Stitch;
    run: () => Promise<{ ok: boolean; data: unknown; error: unknown }>;
} {
    const { server, limit } = opts;
    const call = stitch({
        url: rowsUrl,
        adapter: server.adapter(),
        paginate: {
            items: (value: unknown) => rowsOf(value),
            ...opts.paginate,
            next: (prev: unknown, pagesFetched: number) => {
                const body = prev as PageBody;
                if (opts.stopOnShortPage)
                    return body.rows.length < limit
                        ? undefined
                        : { query: { offset: pagesFetched * limit } };
                const offset = pagesFetched * limit;
                return offset < body.total ? { query: { offset } } : undefined;
            },
        },
        ...(opts.output === undefined ? {} : { output: opts.output }),
        ...(opts.transform === undefined ? {} : { transform: opts.transform }),
    });
    return {
        call,
        run: async () => {
            const r = await call.safe({ query: { limit, offset: 0 } });
            return { ok: r.ok, data: r.data, error: r.error };
        },
    };
}
