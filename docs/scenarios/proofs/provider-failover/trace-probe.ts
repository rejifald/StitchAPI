// A {@link TraceSink} that records every event with the run identity it arrived under.
//
// Two claims here are about OBSERVABILITY rather than cost, and both turn on the same question:
// after the call, can anything downstream say WHICH provider served it? A sink is the only place
// that can answer, because the returned value is just the winner's body and the combinators return
// no envelope. So this records `(name, type, traceId, spanId, parentSpanId)` per event and exposes
// the three reductions the claims assert on: which stitches emitted a terminal `result`, how many
// distinct trace trees the call produced, and the parent/child spine.
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';

export interface TraceRecord {
    /** The stitch's `name` — the only provider identity a sink ever sees. */
    name: string;
    type: StitchEvent['type'];
    status?: number;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
}

export interface RecordingSink extends TraceSink {
    readonly records: TraceRecord[];
    /** Stitch names that emitted an event of `type` — `'result'` is "this member SUCCEEDED". */
    names(type: StitchEvent['type']): string[];
    /** Distinct `traceId`s seen — 1 means the whole failover is one trace tree, 2 means two. */
    traceIds(): string[];
    /** `name → parentSpanId ?? '<root>'` for each `start`, the shape of the trace fan/chain. */
    spine(): string[];
    reset(): void;
}

export function recordingSink(): RecordingSink {
    const records: TraceRecord[] = [];
    const spans = new Map<string, string>(); // spanId → name, to resolve a parent to its label
    return {
        records,
        handle(event: StitchEvent, ctx: TraceContext): void {
            if (event.type === 'start' && ctx.spanId)
                spans.set(ctx.spanId, ctx.name);
            const rec: TraceRecord = { name: ctx.name, type: event.type };
            if (event.type === 'result') rec.status = event.status;
            if (event.type === 'error' && event.status !== undefined)
                rec.status = event.status;
            if (ctx.traceId !== undefined) rec.traceId = ctx.traceId;
            if (ctx.spanId !== undefined) rec.spanId = ctx.spanId;
            if (ctx.parentSpanId !== undefined)
                rec.parentSpanId = ctx.parentSpanId;
            records.push(rec);
        },
        names(type) {
            return records.filter((r) => r.type === type).map((r) => r.name);
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
        spine() {
            return records
                .filter((r) => r.type === 'start')
                .map(
                    (r) =>
                        `${r.name}<-${r.parentSpanId ? (spans.get(r.parentSpanId) ?? 'span') : '<root>'}`,
                );
        },
        reset() {
            records.length = 0;
            spans.clear();
        },
    };
}
