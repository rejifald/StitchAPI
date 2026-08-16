// THE REACTION HALF — user code, and it is almost entirely config. Everything downstream of the
// ack is an outbound call, which is exactly what this library is for.
//
// Two stitches on one seam:
//
//   `current`  — fetch-on-receipt. The event is a HINT; this is the answer. C4 measured that this
//                is what makes reversed delivery converge, and that it needs its own auth, retry
//                and rate budget — all of which are the seam's, not this file's.
//   `apply`    — the downstream write, carrying the event id as its idempotency key so a duplicate
//                that got past the ledger still cannot double-charge.
//
// The version guard is here rather than in config because C4 (c) measured that fetch-on-receipt
// alone does NOT make write order safe: two concurrent handlers holding snapshots v2 and v3 land
// on v2 under last-write-wins. Nothing in the library expresses "reject a write carrying an older
// version" — it is four lines, and they are four lines you have to write.
import { bearer } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type { Adapter, StitchStore } from '../../../../packages/core/src/types';

export interface Subscription {
    id: string;
    status: string;
    plan: string;
    version: number;
}

export interface ReactionOptions {
    baseUrl: string;
    token: string;
    /** The SAME store the receipt half deduplicates against (C5). */
    store: StitchStore;
    adapter: Adapter;
    /** The local read model the handler maintains. */
    write: (sub: Subscription) => void;
    /** Reports a write rejected as stale, so the guard is observable. */
    onStale?: (version: number) => void;
}

export interface Reaction {
    handle(event: { id: string; type: string; subject: string }): Promise<void>;
    close(): Promise<void>;
}

export function createReaction(opts: ReactionOptions): Reaction {
    // One seam: the auth, the retry budget, the rate budget and the deadline are declared once and
    // both members inherit them. The store is the receipt half's ledger, shared.
    const api = seam({
        baseUrl: opts.baseUrl,
        auth: bearer(() => opts.token),
        adapter: opts.adapter,
        store: opts.store,
        retry: { attempts: 3, on: [429, 500, 502, 503, 504] },
        throttle: { rate: '25/s' },
        timeout: { total: '10s' },
    });

    const current = api.stitch({
        path: '/v1/subscriptions/{id}',
        method: 'GET',
    });
    const apply = api.stitch({
        path: '/v1/entitlements',
        method: 'POST',
        idempotency: {
            keyOf: (input) =>
                String((input.body as { eventId?: string }).eventId),
        },
    });

    let seen = 0;

    return {
        async handle(event) {
            // The payload contributed the subject id and nothing else — the state comes from here.
            const sub = (await current({
                params: { id: event.subject },
            })) as Subscription;

            // C4 (c): the guard fetch-on-receipt does not give you.
            if (sub.version <= seen) {
                opts.onStale?.(sub.version);
                return;
            }
            seen = sub.version;

            await apply({
                body: {
                    eventId: event.id,
                    subscription: sub.id,
                    plan: sub.plan,
                },
            });
            opts.write(sub);
        },
        close: () => api.close(),
    };
}
