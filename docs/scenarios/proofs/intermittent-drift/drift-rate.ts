// The aggregation seam: a `TraceSink` that turns per-call drift findings into a RATE.
//
// This is the answer to C6, and it is user code — the library counts nothing. What the library
// supplies is the seam: `trace` accepts any `{ handle(event, ctx) }`, it is configured ONCE on a
// stitch or a seam, it receives every event of every call through it, and `ctx.spanId` identifies
// the logical call. That is exactly the shape a counter needs, and it is the only place in the
// library where cross-call state is deliberate rather than a leak.
//
// Three things this sink has to get right, each of which is a measured trap in `c6-aggregation.ts`:
//
//  1. **The denominator is `start` events, not findings.** A call with two drifted fields emits two
//     findings (measured: 3 findings on one call in C6), so `findings / calls` reports 300%.
//  2. **A call that drifted is not the same as a finding.** `spanId` collapses N findings back to
//     one drifted call, which is what "5% of calls drifted" means.
//  3. **The VALUE is not in the finding.** `warn|coerced|transaction_id|string -> number` is
//     byte-identical for `"12345" -> 12345` and for `"abc" -> 0` (C3). The `result` event carries
//     the validated `data` on the same `spanId`, so joining the two is how a counter learns that
//     the coercion produced a zero. Nothing else in the library exposes that.
//
// The window is clock-driven so a rate is a rate over a period rather than since-process-start —
// `manualClock()` drives it in the proofs, `Date.now` in production.
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';

/** Just enough of a clock for the window — `manualClock()` satisfies it, so does `{ now: Date.now }`. */
export interface NowSource {
    now(): number;
}

export interface DriftRateOptions {
    /** Clock the rolling window is measured on. Default: wall clock. */
    clock?: NowSource;
    /** Rolling window in ms. Omitted ⇒ count since construction (no eviction). */
    window?: number;
    /**
     * Paths whose validated value being `0` should be counted separately — the `$0 transaction`
     * detector. A coercion is only dangerous when it lands on a value the business logic will act
     * on, and the finding cannot tell you that; the joined `result` event can.
     */
    zeroWatch?: string[];
}

/** One aggregated row: a distinct finding identity and how often it fired. */
export interface DriftRow {
    key: string;
    level: string;
    change: string;
    path: string;
    detail: string;
    /** Findings emitted (a call with the same finding twice counts twice — arrays collapse first). */
    findings: number;
    /** Distinct logical calls that emitted this finding. The numerator of a rate. */
    calls: number;
    /** Of those calls, how many landed a `0` on a `zeroWatch` path. */
    zeros: number;
}

/** What a recorded tick counts: one logical call, one finding, one drifted call, one landed zero. */
type Tick = 'call' | 'finding' | 'drifted' | 'zero';

/* <count:begin> */
export class DriftRate implements TraceSink {
    private readonly clock: NowSource;
    private readonly window: number | undefined;
    private readonly zeroWatch: Set<string>;
    /** Every observed event reduced to `{ at, key, kind }`, so eviction is a filter on `at`. */
    private ticks: { at: number; key: string; kind: Tick }[] = [];
    /** Findings seen on a span not yet terminated by its `result` / `error` event. */
    private readonly open = new Map<string, string[]>();

    constructor(opts: DriftRateOptions = {}) {
        this.clock = opts.clock ?? Date;
        this.window = opts.window;
        this.zeroWatch = new Set(opts.zeroWatch ?? []);
    }

    handle(e: StitchEvent, ctx: TraceContext): void {
        const at = this.clock.now();
        const span = ctx.spanId ?? '<no-span>';
        if (e.type === 'start')
            this.ticks.push({ at, key: ctx.name, kind: 'call' });
        if (e.type === 'drift') {
            const f = e.finding;
            const key = `${f.level}|${f.change}|${f.path}|${f.detail ?? ''}`;
            this.ticks.push({ at, key, kind: 'finding' });
            const slot = this.open.get(span) ?? [];
            slot.push(key);
            this.open.set(span, slot);
        }
        // Join: the validated value arrives on the SAME span, after the findings. This is the only
        // way to learn that `coerced` produced a ZERO rather than the right number.
        if (e.type !== 'result' && e.type !== 'error') return;
        const slot = this.open.get(span);
        this.open.delete(span);
        if (!slot) return;
        for (const key of new Set(slot))
            this.ticks.push({ at, key, kind: 'drifted' });
        if (e.type !== 'result') return;
        const data = e.data;
        if (data === null || typeof data !== 'object') return;
        const record = data as Record<string, unknown>;
        for (const key of new Set(slot)) {
            const path = key.split('|')[2] ?? '';
            if (this.zeroWatch.has(path) && record[path] === 0)
                this.ticks.push({ at, key, kind: 'zero' });
        }
    }

    /** Ticks still inside the window (evicting is how a rolling rate forgets). */
    private live(): { at: number; key: string; kind: Tick }[] {
        if (this.window === undefined) return this.ticks;
        const floor = this.clock.now() - this.window;
        this.ticks = this.ticks.filter((t) => t.at > floor);
        return this.ticks;
    }

    /** Logical calls in the window — the denominator. */
    get calls(): number {
        return this.live().filter((t) => t.kind === 'call').length;
    }

    /** One row per distinct finding identity, most drifted calls first. */
    rows(): DriftRow[] {
        const by = new Map<string, DriftRow>();
        for (const t of this.live()) {
            if (t.kind === 'call') continue;
            const [level = '', change = '', path = '', detail = ''] =
                t.key.split('|');
            let row = by.get(t.key);
            if (!row) {
                row = {
                    key: t.key,
                    level,
                    change,
                    path,
                    detail,
                    findings: 0,
                    calls: 0,
                    zeros: 0,
                };
                by.set(t.key, row);
            }
            if (t.kind === 'finding') row.findings += 1;
            if (t.kind === 'drifted') row.calls += 1;
            if (t.kind === 'zero') row.zeros += 1;
        }
        return [...by.values()].sort((a, b) => b.calls - a.calls);
    }

    /** `"5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)"` */
    report(): string[] {
        const total = this.calls;
        return this.rows().map((r) => {
            const pct = total === 0 ? 0 : (r.calls / total) * 100;
            const zeros = r.zeros > 0 ? `, ${r.zeros} landed 0` : '';
            return `${pct.toFixed(1)}% of calls: ${r.key} (${r.calls}/${total}${zeros})`;
        });
    }
}
/* <count:end> */
