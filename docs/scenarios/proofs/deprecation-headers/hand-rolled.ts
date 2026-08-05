// The control: the same job with no library at all, over the same `Adapter` and the same `Clock`.
//
// It has to do everything `assembled.ts` does — parse both header formats, keep one row per
// endpoint, sort by soonest sunset, answer "how many days", and trip after a sunset you chose — so
// the comparison is of the same work, not of two different jobs.
//
// The parsers are IMPORTED rather than re-typed, because C6 already established they are 100% user
// code on both sides: re-typing them here would inflate the control by 29 lines that say nothing
// about the library. What is counted is the wiring — the request loop, the per-endpoint state, the
// tripwire, and the reporting.
import type { Adapter, Clock } from '../../../../packages/core/src/types';
import { type Notice, readNotice } from './deprecation';
import { DAY } from './fake-vendor';

export interface HandRolledOptions {
    baseUrl: string;
    adapter: Adapter;
    clock: Clock;
    /** Fail the call once its announced sunset has passed. */
    failAfterSunset: boolean;
}

// >>> BEGIN USER CODE
/** A client that reads retirement notices off its own responses. */
export class HandRolledClient {
    private readonly rows = new Map<
        string,
        { notice: Notice; calls: number }
    >();

    constructor(private readonly opts: HandRolledOptions) {}

    async call(name: string, path: string): Promise<unknown> {
        const res = await this.opts.adapter({
            url: `${this.opts.baseUrl}${path}`,
            method: 'GET',
            headers: {},
        });
        if (res.status >= 400)
            throw new Error(`${name}: HTTP ${String(res.status)}`);
        const notice = readNotice(res.headers);
        if (notice !== null) {
            const prior = this.rows.get(name);
            this.rows.set(name, { notice, calls: (prior?.calls ?? 0) + 1 });
            if (
                this.opts.failAfterSunset &&
                notice.sunsetAt !== null &&
                this.opts.clock.now() >= notice.sunsetAt
            )
                throw new Error(
                    `${name}: sunset passed (${new Date(notice.sunsetAt).toISOString()})`,
                );
        }
        return res.body;
    }

    fleet(): { endpoint: string; notice: Notice; calls: number }[] {
        return [...this.rows.entries()]
            .map(([endpoint, r]) => ({ endpoint, ...r }))
            .sort(
                (a, b) =>
                    (a.notice.sunsetAt ?? Infinity) -
                    (b.notice.sunsetAt ?? Infinity),
            );
    }

    summary(): string {
        const rows = this.fleet();
        if (rows.length === 0) return 'no deprecated endpoints';
        const first = rows[0];
        if (first === undefined) return 'no deprecated endpoints';
        const names = rows.map((r) => r.endpoint).join(', ');
        if (first.notice.sunsetAt === null)
            return `${String(rows.length)} endpoints deprecated (${names}), no sunset announced`;
        const days = Math.round(
            (first.notice.sunsetAt - this.opts.clock.now()) / DAY,
        );
        return `${String(rows.length)} endpoints deprecated (${names}), earliest sunset in ${String(days)} days: ${first.endpoint}`;
    }
}
// <<< END USER CODE
