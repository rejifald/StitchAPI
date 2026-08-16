// The keyset/seek `paginate` block — the correct construction, in one place so C4 and C8 run the
// same code.
//
// This is the whole of it. `next` is handed the previous page's RAW body (engine.ts:985), so it can
// read the last row's `(created_at, id)` and hand it back as the next request's query. That is
// exactly the composite cursor the state of the art prescribes, and it is four lines.
import { stitch } from '../../../../packages/core/src/index';
import type { SchemaLike } from '../../../../packages/core/src/infer';
import type { Stitch } from '../../../../packages/core/src/types';
import type { LiveCollection, PageBody } from './fake-collection';
import { rowsOf, rowsUrl } from './fake-collection';

export interface KeysetLoopOptions {
    server: LiveCollection;
    limit: number;
    /** Contract over the AGGREGATED array — C8 layers its reconciliation here. */
    output?: SchemaLike;
    transform?: (value: unknown) => unknown;
}

export function keysetLoop(opts: KeysetLoopOptions): {
    call: Stitch;
    run: () => Promise<{ ok: boolean; data: unknown; error: unknown }>;
} {
    const { server, limit } = opts;
    const call = stitch({
        url: rowsUrl,
        adapter: server.adapter(),
        paginate: {
            items: (value: unknown) => rowsOf(value),
            // <count:begin>
            next: (prev: unknown) => {
                const last = (prev as PageBody).rows.at(-1);
                if (!last) return undefined;
                return {
                    query: { after_ts: last.created_at, after_id: last.id },
                };
            },
            // <count:end>
        },
        ...(opts.output === undefined ? {} : { output: opts.output }),
        ...(opts.transform === undefined ? {} : { transform: opts.transform }),
    });
    return {
        call,
        run: async () => {
            // The cursor starts at negative infinity — a real seek entry point, not `offset=0`.
            const r = await call.safe({
                query: { limit, after_ts: 0, after_id: '' },
            });
            return { ok: r.ok, data: r.data, error: r.error };
        },
    };
}
