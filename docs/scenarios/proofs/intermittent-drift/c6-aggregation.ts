// C6 — DECIDING CLAIM. Over 100 calls where 5 drift, can the caller learn "5% of calls drifted on
// field X"?
//
// The capture predicted this was the gap, on the strength of every other scenario in this pass
// finding no cross-call state: no per-call slot on `HookContext` (scenario 7), no run-scoped state
// (scenario 7), closures that leak across calls (scenario 11).
//
// The prediction is WRONG. `trace` is a genuine aggregation seam, and it is the one place in the
// library where cross-call state is the design rather than a leak: a `TraceSink` is configured
// once on a stitch or a seam, receives `handle(event, ctx)` for every event of every call through
// it, and `ctx.spanId` identifies the logical call. Measured: 100 calls, 5 drifted, the sink
// reported `5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)` — the
// rate, the field, and the fact that the coerced value was a zero.
//
// The library still counts NOTHING itself. Three traps in the counting are measured below, and one
// of them (the cache) can divide a real rate by five without any code being wrong.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c6-aggregation.ts
import { drift, seam, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    HookContext,
    StitchEvent,
    StitchStore,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { DriftRate } from './drift-rate';
import { FakeVendor, fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

const Charge = z.object({
    transaction_id: z.coerce.number().catch(0),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
});

async function main(): Promise<void> {
    heading('C6 — 5 of 100 calls drift. Can you learn the RATE?');

    // ── (a) the answer: a TraceSink counts it, and the number is right ───────────────────────
    {
        const vendor = new FakeVendor({ mutation: 'nulled', rate: 0.05 });
        const rate = new DriftRate({ zeroWatch: ['transaction_id'] });
        const charge = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: vendor.adapter(),
            output: drift(Charge),
            trace: rate,
        });

        const values: unknown[] = [];
        for (let i = 0; i < 100; i += 1) {
            const r = await charge.safe();
            values.push((r.data as Record<string, unknown>)['transaction_id']);
        }

        check('(a) calls the sink counted', rate.calls, 100);
        check('(a) calls the vendor actually drifted', vendor.mutatedCount, 5);
        checkSeq('(a) the report', rate.report(), [
            '5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)',
        ]);
        check(
            '(a) callers that received a literal 0',
            values.filter((v) => v === 0).length,
            5,
        );
        note(
            '(a) → the rate, the level, the kind, the FIELD, and the fact that the value landed on zero. That is an alertable line, and no library code produced it',
            '',
        );
    }

    // ── (b) TRAP 1: findings are not calls ───────────────────────────────────────────────────
    // Two fields drifting on one response emits two findings. `findings / calls` reports 200%.
    {
        const rate = new DriftRate();
        const perCall: string[] = [];
        const raw: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type === 'drift')
                    perCall.push(
                        `${ctx.spanId?.slice(0, 4) ?? '?'}:${fmt(e.finding)}`,
                    );
            },
        };
        const both: TraceSink = {
            handle(e, ctx) {
                rate.handle(e, ctx);
                raw.handle(e, ctx);
            },
        };
        const call = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: serving({
                transaction_id: null,
                amount: 4200,
                currency: 'usd',
                status: 'succeeded',
                settlement_delay_ms: 900,
            }),
            output: drift(Charge),
            trace: both,
        });
        await call.safe();

        check('(b) calls made', rate.calls, 1);
        check('(b) findings emitted', perCall.length, 2);
        check(
            '(b) distinct spans behind them',
            new Set(perCall.map((p) => p.split(':')[0])).size,
            1,
        );
        checkSeq(
            '(b) rows, each counting DRIFTED CALLS not findings',
            rate
                .rows()
                .map((r) => `${r.key} findings=${r.findings} calls=${r.calls}`),
            [
                'warn|coerced|transaction_id|null -> number findings=1 calls=1',
                'info|undeclared|settlement_delay_ms|undeclared field (number) findings=1 calls=1',
            ],
        );
        note(
            '(b) → a naive `findings / calls` on this one response is 200%. `ctx.spanId` is what collapses it back to "1 of 1 calls drifted, on two fields"',
            '',
        );
    }

    // ── (c) TRAP 2: the cache divides your drift rate by the hit ratio ───────────────────────
    // A cache hit emits `start` and `result` (so the denominator grows) but no drift (the engine
    // states outright that soft drift is meaningless on a hit, engine.ts:1668-1669). Five calls
    // against a 100%-drifting vendor, one wire request, and the measured rate is 20%.
    {
        const vendor = new FakeVendor({ mutation: 'nulled', rate: 1 });
        const rate = new DriftRate();
        const cached = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: vendor.adapter(),
            output: drift(Charge),
            trace: rate,
            // `fingerprint: 'v1'` is the manual version tag (ADR 0004; bare string ≡
            // `{ version: 'v1' }`). Without it the fingerprint ladder fails closed on a Zod
            // schema — no registered fingerprinter → `bypass: no fingerprinter registered for
            // 'zod'` — and every call would go to the wire, which is a different trap than the
            // one this section measures.
            cache: { ttl: 60_000, fingerprint: 'v1' },
        });
        for (let i = 0; i < 5; i += 1) await cached.safe();

        check('(c) wire requests', vendor.calls.length, 1);
        check('(c) responses the vendor drifted', vendor.mutatedCount, 1);
        check('(c) calls the sink counted', rate.calls, 5);
        checkSeq('(c) the report', rate.report(), [
            '20.0% of calls: warn|coerced|transaction_id|null -> number (1/5)',
        ]);
        note(
            '(c) → the TRUE vendor drift rate is 100%. The sink says 20%, and every line of code involved is correct. Cache hit ratio is a hidden divisor on any drift rate',
            '',
        );
    }

    // ── (d) TRAP 3: `.report()` / `.inspect()` pollute BOTH sides of the fraction ────────────
    // A diagnostic probe is a real run: it makes a request, and it emits `start` + `drift` into
    // the same sink. Reach for `.report()` in a catch block and your rate moves.
    {
        const vendor = new FakeVendor({ mutation: 'nulled', rate: 1 });
        const rate = new DriftRate();
        const call = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: vendor.adapter(),
            output: drift(Charge),
            trace: rate,
        });
        await call.safe();
        const before = { calls: rate.calls, wire: vendor.calls.length };
        await call.report();
        checkSeq(
            '(d) calls/wire before and after one `.report()`',
            [before.calls, before.wire, rate.calls, vendor.calls.length],
            [1, 1, 2, 2],
        );
        note(
            '(d) → `.report()` is a fresh run (stitch.ts:1024-1090), not a read of the run you made. It costs a request AND a tick in your denominator',
            '',
        );
    }

    // ── (e) what the sink CAN do that no other accessor can: join to the value ───────────────
    // C3(e) established that `warn|coerced|transaction_id|string -> number` is identical for
    // `"12345" -> 12345` and `"abc" -> 0`. The `result` event carries the validated `data` on the
    // SAME span, so the sink is the one place both halves are in scope at once.
    {
        const bodies = [
            {
                transaction_id: '12345',
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            },
            {
                transaction_id: 'abc',
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            },
            {
                transaction_id: null,
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            },
        ];
        let i = 0;
        const rate = new DriftRate({ zeroWatch: ['transaction_id'] });
        const call = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: async () => ({
                status: 200,
                headers: {},
                body: bodies[i++],
            }),
            output: drift(Charge),
            trace: rate,
        });
        for (let k = 0; k < 3; k += 1) await call.safe();

        checkSeq('(e) the report', rate.report(), [
            '66.7% of calls: warn|coerced|transaction_id|string -> number (2/3, 1 landed 0)',
            '33.3% of calls: warn|coerced|transaction_id|null -> number (1/3, 1 landed 0)',
        ]);
        note(
            '(e) → `2/3, 1 landed 0` is the whole point: two calls produced the SAME finding and only one of them was a $0 charge. The finding alone cannot say that; the join can',
            '',
        );
    }

    // ── (f) a rolling window, so the rate is a rate and not a lifetime average ───────────────
    // A canary that goes 5% → 25% has to be visible AS A CHANGE. Time is injected, so this is
    // deterministic.
    {
        const clock = manualClock();
        const rate = new DriftRate({ clock, window: 60_000 });
        let phase: 'five' | 'twentyfive' = 'five';
        let n = 0;
        const call = stitch({
            name: 'charge',
            url: 'https://pay.example/charges',
            adapter: async () => {
                n += 1;
                const period = phase === 'five' ? 20 : 4;
                const drifty = n % period === 0;
                return {
                    status: 200,
                    headers: {},
                    body: {
                        transaction_id: drifty ? null : 100000 + n,
                        amount: 4200,
                        currency: 'usd',
                        status: 'ok',
                    },
                };
            },
            output: drift(Charge),
            trace: rate,
            clock,
        });

        for (let i = 0; i < 100; i += 1) {
            await call.safe();
            await clock.advance(500); // 100 calls over 50s — inside the 60s window
        }
        const yesterday = rate.report();

        // The canary widens. Move past the window so the old sample is fully evicted.
        phase = 'twentyfive';
        n = 0;
        await clock.advance(120_000);
        for (let i = 0; i < 100; i += 1) {
            await call.safe();
            await clock.advance(500);
        }
        const today = rate.report();

        checkSeq('(f) window 1', yesterday, [
            '5.0% of calls: warn|coerced|transaction_id|null -> number (5/100)',
        ]);
        checkSeq('(f) window 2, after the canary widened', today, [
            '25.0% of calls: warn|coerced|transaction_id|null -> number (25/100)',
        ]);
        check('(f) virtual ms elapsed', clock.now(), 220_000);
        note(
            '(f) → 5% → 25% on the same field, each window standing alone. That is the alert the scenario is asking for, and it is 5 lines of eviction in user code',
            '',
        );
    }

    // ── (g) a SEAM-level sink aggregates across endpoints, tagged by name ────────────────────
    // `seam({ trace })` puts one sink under every stitch it builds, and `ctx.name` says which
    // endpoint drifted — the shape a real service needs.
    {
        const rows: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type === 'drift')
                    rows.push(`${ctx.name}:${e.finding.path}`);
            },
        };
        const api = seam({
            baseUrl: 'https://pay.example',
            adapter: serving({
                transaction_id: null,
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            }),
            trace: sink,
        });
        const charge = api.stitch({
            name: 'charge',
            path: '/charges',
            output: drift(Charge),
        });
        const refund = api.stitch({
            name: 'refund',
            path: '/refunds',
            output: drift(Charge),
        });
        await charge.safe();
        await refund.safe();
        await charge.safe();
        checkSeq('(g) one sink, two endpoints', rows, [
            'charge:transaction_id',
            'refund:transaction_id',
            'charge:transaction_id',
        ]);
    }

    // ── (h) the seams that DO NOT work, measured ─────────────────────────────────────────────
    // For completeness, because the capture asked "where would a counter live".
    {
        // hooks: `HookContext` is `{ name, attempt, req?, res?, error? }` (types.ts:1443-1449) and
        // `onResponse` runs BEFORE validation, so there is no finding to count there.
        const keys: string[] = [];
        const call = stitch({
            url: 'https://pay.example/charges',
            adapter: serving({
                transaction_id: null,
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            }),
            output: drift(Charge),
            hooks: {
                onResponse: (c: HookContext) => {
                    keys.push(Object.keys(c).sort().join(','));
                },
            },
        });
        const r = await call.safe();
        checkSeq('(h) `HookContext` keys', keys, ['attempt,name,res']);
        checkSeq('(h) `SafeResult` keys', Object.keys(r).sort(), [
            'data',
            'error',
            'ok',
        ]);
        note(
            '(h) → neither hooks nor `.safe()` carries a finding. A soft drift is INVISIBLE on the awaited path — `ok: true`, `error: null`, and nothing else to read',
            '',
        );

        // A `StitchStore` can hold the counter (Redis, for a rate across workers), but `handle` is
        // SYNCHRONOUS (`handle(...): void`, types.ts:2161-2164) so the increment is fire-and-forget
        // and you own the promise. Measured working, with the caveat on the page.
        const map = new Map<string, number>();
        const store: StitchStore = {
            async get(k) {
                return map.get(k);
            },
            async set() {},
            async increment(k) {
                const v = (map.get(k) ?? 0) + 1;
                map.set(k, v);
                return v;
            },
        };
        const inflight: Promise<unknown>[] = [];
        const storeSink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'start') inflight.push(store.increment('calls'));
                if (e.type === 'drift')
                    inflight.push(store.increment(`drift:${e.finding.path}`));
            },
        };
        const counted = stitch({
            url: 'https://pay.example/charges',
            adapter: serving({
                transaction_id: null,
                amount: 4200,
                currency: 'usd',
                status: 'ok',
            }),
            output: drift(Charge),
            trace: storeSink,
        });
        for (let i = 0; i < 4; i += 1) await counted.safe();
        await Promise.all(inflight);
        checkSeq(
            '(h) a store-backed counter',
            [...map],
            [
                ['calls', 4],
                ['drift:transaction_id', 4],
            ],
        );
        note(
            '(h) → `StitchStore.increment` makes the rate cross-process. `TraceSink.handle` returns `void`, so nothing awaits it: you hold the promises yourself and drain them on `seam.flush()`',
            '',
        );
    }

    finish(
        'C6',
        "THE CAPTURE'S PREDICTION IS REFUTED — aggregation WORKS, and `trace` is a real seam. 100 calls, 5 drifted, and the sink reported `5.0% of calls: warn|coerced|transaction_id|null -> number (5/100, 5 landed 0)`; a rolling window on an injected clock showed the canary widening 5.0% → 25.0% on the same field. A `TraceSink` is configured once, sees every event of every call, and `ctx.spanId` is what makes per-call state possible — the one place in the library where cross-call state is the design and not a leak. A seam-level sink aggregates across endpoints tagged by `ctx.name`, and `StitchStore.increment` takes it cross-process. Three traps, all measured: findings are not calls (2 findings on 1 response reads as 200% without a `spanId` collapse); a CACHE HIT emits `start`+`result` but no drift, so 5 calls against a 100%-drifting vendor measured 20%; and `.report()` is a fresh run that adds a request AND a tick to the denominator. Neither `hooks` nor `.safe()` can see a soft finding at all",
    );
}

void main();
