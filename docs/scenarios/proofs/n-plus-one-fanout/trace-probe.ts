// A {@link TraceSink} that records every event with the run identity it arrived under.
//
// C6's question is whether a 100-call fan-out is ONE tree or a hundred unrelated roots, so this
// records `(name, type, traceId, spanId, parentSpanId)` plus the `url` off each `start` — the url
// is the only thing that says WHICH id a span was for, because one stitch called 100 times emits
// 100 spans all named `customer`.
//
// The reductions the claims assert on: how many distinct trace trees, how many roots, how deep the
// deepest chain is, and how wide the widest fan is.
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';

export interface TraceRecord {
    /** The stitch's `name` — the only identity a sink gets for free. */
    name: string;
    type: StitchEvent['type'];
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    /** Present on `start` only: the resolved request URL, which carries the id. */
    url?: string;
}

export interface RecordingSink extends TraceSink {
    readonly records: TraceRecord[];
    /** Every `start` event, in order. One per call. */
    starts(): TraceRecord[];
    /** Distinct `traceId`s — 1 means the whole fan-out is one tree, 100 means a hundred roots. */
    traceIds(): string[];
    /** Starts with no `parentSpanId` — the ROOT runs. */
    roots(): TraceRecord[];
    /**
     * Longest ancestor chain among the recorded spans. 1 = a flat fan; N = an N-deep chain, which
     * is what `linked` produces when it is used to give each call its own input.
     */
    maxDepth(): number;
    /** Largest number of spans sharing one `parentSpanId` — the widest fan. */
    maxFanout(): number;
    reset(): void;
}

export function recordingSink(): RecordingSink {
    const records: TraceRecord[] = [];
    return {
        records,
        handle(event: StitchEvent, ctx: TraceContext): void {
            const rec: TraceRecord = { name: ctx.name, type: event.type };
            if (ctx.traceId !== undefined) rec.traceId = ctx.traceId;
            if (ctx.spanId !== undefined) rec.spanId = ctx.spanId;
            if (ctx.parentSpanId !== undefined)
                rec.parentSpanId = ctx.parentSpanId;
            if (event.type === 'start') rec.url = event.url;
            records.push(rec);
        },
        starts() {
            return records.filter((r) => r.type === 'start');
        },
        traceIds() {
            return [
                ...new Set(
                    records
                        .map((r) => r.traceId)
                        .filter((t): t is string => t !== undefined),
                ),
            ];
        },
        roots() {
            return this.starts().filter((r) => r.parentSpanId === undefined);
        },
        maxDepth() {
            const parent = new Map<string, string | undefined>();
            for (const r of this.starts())
                if (r.spanId) parent.set(r.spanId, r.parentSpanId);
            let deepest = 0;
            for (const span of parent.keys()) {
                let d = 1;
                let cur = parent.get(span);
                // The chain is walked against the KNOWN spans only: a `parentSpanId` naming a span
                // that never emitted (a combinator's group run) terminates the walk.
                while (cur !== undefined && parent.has(cur)) {
                    d += 1;
                    cur = parent.get(cur);
                }
                if (d > deepest) deepest = d;
            }
            return deepest;
        },
        maxFanout() {
            const byParent = new Map<string, number>();
            let widest = 0;
            for (const r of this.starts()) {
                const key = r.parentSpanId ?? '<root>';
                const n = (byParent.get(key) ?? 0) + 1;
                byParent.set(key, n);
                if (n > widest) widest = n;
            }
            return widest;
        },
        reset() {
            records.length = 0;
        },
    };
}

/** The customer id a `start` record was for, read off its url. */
export const idFromUrl = (r: TraceRecord): string =>
    r.url ? (r.url.split('/').pop() ?? '') : '';
