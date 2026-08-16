// C7 — noise. At request volume does the naive approach produce one line per call, and can it be
// de-duplicated per endpoint WITHOUT hand-rolled state?
//
// One line per call: yes, measured at 600. De-duplicated without hand-rolled state: no. The library
// ships one genuine drop hook — `loggerSink({ levelOf })` returns `null` to discard an event before
// it is logged, and `format` returning `null` does the same — but the predicate it drops on is a
// pure function of `(event, ctx)`, and "have I already reported this endpoint" is not. The `Map`
// that answers it is yours to write and yours to bound.
//
// The drift channel does not help either: a folded notice produces one `info|undeclared` finding
// PER CALL, so routing the notice through findings converts 600 log lines into 600 findings.
//
// Nothing in the library counts, latches, samples or rate-limits a repeated observation. The five
// lines of `Map` in `DeprecationWatch` are the entire difference between 600 lines and 3.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c7-noise.ts
import { drift, loggerSink, seam } from '../../../../packages/core/src/index';
import type {
    LogLevel,
    LoggerLike,
    Validator,
} from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    DeprecationWatch,
    deprecationSurface,
    noticeOf,
    readNotice,
} from './deprecation';
import { BASE, FLEET, FakeVendor, NOW } from './fake-vendor';
import { check, checkAtMost, checkSeq, finish, heading, note } from './harness';

/** 120 rounds over the 5-endpoint fleet = 600 calls, 360 of them carrying a notice. */
const ROUNDS = 120;

/** A logger that counts lines instead of printing them. */
function countingLogger(): LoggerLike & { lines: string[] } {
    const lines: string[] = [];
    const push = (m: string): void => void lines.push(m);
    return {
        lines,
        error: push,
        warn: push,
        info: push,
        debug: push,
    };
}

/** Run the whole fleet `ROUNDS` times through one seam, and hand back the request total. */
async function runFleet(
    trace: TraceSink,
    opts: { fold?: boolean; output?: Validator<unknown> } = {},
): Promise<number> {
    const clock = manualClock(NOW);
    const vendor = new FakeVendor();
    const api = seam({
        baseUrl: BASE,
        adapter: vendor.adapter(),
        clock,
        trace,
    });
    const surface = deprecationSurface({ fold: opts.fold ?? false });
    const members = FLEET.map((e) =>
        api.stitch({
            name: e.name,
            path: e.path,
            kind: surface,
            ...(opts.output ? { output: drift(opts.output) } : {}),
        }),
    );
    for (let r = 0; r < ROUNDS; r += 1) for (const m of members) await m();
    return vendor.total;
}

async function main(): Promise<void> {
    heading('C7 — 600 calls. How many lines?');

    // ── (a) the naive answer: one line per call that carries a notice ────────────────────────
    {
        const lines: string[] = [];
        const naive: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type !== 'result') return;
                const n = noticeOf(e.data);
                if (n !== null)
                    lines.push(
                        `WARN ${ctx.name} is deprecated, sunset ${new Date(n.sunsetAt ?? 0).toISOString().slice(0, 10)}`,
                    );
            },
        };
        const total = await runFleet(naive, { fold: true });
        check('(a) calls made', total, 600);
        check('(a) log lines produced', lines.length, 360);
        check('(a) distinct lines among them', new Set(lines).size, 3);
        note(
            '(a) → 360 lines carrying 3 distinct facts. This is the failure mode the capture names: "one line per call in a log nobody greps"',
        );
    }

    // ── (b) the same thing through `hooks.onResponse`, for completeness ──────────────────────
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const lines: string[] = [];
        const api = seam({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            hooks: {
                onResponse: (c) => {
                    if (readNotice(c.res?.headers ?? {}) !== null)
                        lines.push(`WARN ${c.name} is deprecated`);
                },
            },
        });
        const members = FLEET.map((e) =>
            api.stitch({ name: e.name, path: e.path }),
        );
        for (let r = 0; r < ROUNDS; r += 1) for (const m of members) await m();
        check('(b) hook-logged lines', lines.length, 360);
        note(
            '(b) → identical volume from the other header-bearing seam, and `hooks` is seam-level so this is the one-line change a team actually makes first',
        );
    }

    // ── (c) the library's built-in `loggerSink` is louder, not quieter ───────────────────────
    {
        const logger = countingLogger();
        const total = await runFleet(loggerSink(logger), { fold: true });
        check('(c) calls made', total, 600);
        check(
            '(c) lines from the default `loggerSink`',
            logger.lines.length,
            2400,
        );
        checkSeq('(c) …one call, unpacked', logger.lines.slice(0, 4), [
            'users GET https://api.vendor.test/v1/users',
            'users request#1',
            'users 200 ok (1 attempt(s))',
            'users done in 0ms',
        ]);
        note(
            `(c) → 4 lines per call (start/progress/result/done) whether or not anything is wrong. The default sink is a run log, not a findings log — first line: "${logger.lines[0] ?? ''}"`,
        );
    }

    // ── (d) `levelOf` CAN drop events — the only drop hook in the library ────────────────────
    {
        const logger = countingLogger();
        const sink = loggerSink(logger, {
            // Return `null` to discard. A pure function of (event, ctx) — which is exactly what
            // makes it unable to express "only the first time".
            levelOf: (e: StitchEvent): LogLevel | null =>
                e.type === 'result' ? 'warn' : null,
        });
        const total = await runFleet(sink, { fold: true });
        check('(d) calls made', total, 600);
        check(
            '(d) lines after dropping 3 of 4 event types',
            logger.lines.length,
            600,
        );
        note(
            '(d) → `levelOf` returning `null` is real filtering (trace.ts:415-451), and `format` returning `null` drops too. It cut 2400 to 600 and it cannot cut 600 to 3, because the question "have I said this already" is not answerable from one event',
        );
    }

    // ── (e) …so the latch is user code, and it is a Map ──────────────────────────────────────
    {
        const seen = new Set<string>();
        const lines: string[] = [];
        const latched: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type !== 'result') return;
                const n = noticeOf(e.data);
                if (n === null || seen.has(ctx.name)) return;
                seen.add(ctx.name);
                lines.push(
                    `WARN ${ctx.name} is deprecated, sunset ${new Date(n.sunsetAt ?? 0).toISOString().slice(0, 10)}`,
                );
            },
        };
        const total = await runFleet(latched, { fold: true });
        check('(e) calls made', total, 600);
        check('(e) lines after a 3-line latch', lines.length, 3);
        checkSeq('(e) the lines', lines, [
            'WARN users is deprecated, sunset 2026-01-01',
            'WARN search is deprecated, sunset 2026-03-15',
            'WARN orders is deprecated, sunset 2026-06-01',
        ]);
        checkAtMost('(e) lines per deprecated endpoint', lines.length / 3, 1);
        note(
            '(e) → 600 calls, 3 lines, and the whole mechanism is a `Set` and an early return',
        );
    }

    // ── (f) the aggregating sink does better: one REPORT, not one line per endpoint ──────────
    {
        const clock = manualClock(NOW);
        const watch = new DeprecationWatch(clock);
        const total = await runFleet(watch, { fold: true });
        check('(f) calls made', total, 600);
        check('(f) rows', watch.fleet().length, 3);
        check(
            '(f) lines an operator reads',
            watch.summary().split('\n').length,
            1,
        );
        check(
            '(f) …which is',
            watch.summary(),
            '3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users',
        );
        note(
            '(f) → the latch in (e) reports each endpoint ONCE EVER, so it cannot tell you the sunset moved. The aggregator keeps the latest per endpoint and is queried on demand, which is the shape that survives a vendor changing its mind',
        );
    }

    // ── (g) routing the notice through DRIFT does not de-duplicate it either ─────────────────
    {
        let findings = 0;
        const counter: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings += 1;
            },
        };
        const total = await runFleet(counter, {
            fold: true,
            output: {
                validate: async (v: unknown) => ({
                    ok: true as const,
                    value: v,
                }),
            },
        });
        check('(g) calls made', total, 600);
        check('(g) drift findings emitted', findings, 0);
        note(
            '(g) → zero, because a permissive validator that returns the value unchanged declares nothing undeclared. The finding in C3 came from a contract that STRIPPED `_deprecation`',
        );
    }
    {
        let findings = 0;
        const counter: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings += 1;
            },
        };
        await runFleet(counter, {
            fold: true,
            output: {
                // Declares nothing, so every top-level field is `undeclared` drift.
                validate: async () => ({ ok: true as const, value: {} }),
            },
        });
        check('(g) findings from a stripping contract', findings, 960);
        note(
            '(g) → one finding PER CALL per undeclared field, forever. The drift channel carries the notice (C3) and does not de-duplicate it — 600 log lines become 960 findings',
        );
    }

    // ── (h) is there any built-in de-duplication anywhere? ───────────────────────────────────
    {
        // Hunted for on the public barrel: anything that latches, samples, throttles a REPORT, or
        // remembers an observation across calls. `throttle` is request pacing, not report pacing.
        const dedupish = Object.keys(
            await import('../../../../packages/core/src/index'),
        ).filter((k) => /dedup|once|latch|sample|distinct|uniq/i.test(k));
        checkSeq('(h) de-duplication primitives exported', dedupish, []);
        note(
            '(h) → none. `cache.coalesce` de-duplicates REQUESTS, never observations, and `throttle` paces the wire. Report-level de-duplication is not a thing the library has an opinion about',
        );
    }

    finish(
        'C7',
        'ONE LINE PER CALL, YES — 360 lines carrying 3 distinct facts across 600 calls — AND NO, IT CANNOT BE DE-DUPLICATED WITHOUT HAND-ROLLED STATE. The naive sink and the naive `hooks.onResponse` both produced 360 lines; the library\'s own `loggerSink` is louder still at 2400 (4 events per call, logged whether or not anything is wrong). There IS a real drop hook — `loggerSink({ levelOf })` returning `null` discards an event, and `format` returning `null` does too — and it cut 2400 to 600, but it cannot cut 600 to 3: `levelOf` is a pure function of `(event, ctx)` and "have I reported this endpoint already" is not answerable from one event. A 3-line `Set` latch in the sink took 600 calls to 3 lines; the aggregating `DeprecationWatch` did better by keeping ONE ROW PER ENDPOINT queried on demand, so a vendor that moves its sunset date is still visible where a fire-once latch would have gone quiet. Routing the notice through the drift channel does not help — a stripping contract emitted 960 findings over the same 600 calls, one per call per undeclared field. Nothing on the public barrel latches, samples or de-duplicates an observation: `cache.coalesce` de-duplicates requests and `throttle` paces the wire, and neither has anything to say about a repeated report',
    );
}

void main();
