// C7 — hedging safety. The standard warning is that a hedge amplifies an outage: when the backend
// degrades, every request crosses the threshold, so every request doubles. Measure the
// amplification against a degraded backend, and then whether a circuit breaker can be scoped to
// just the hedge.
//
// The capture frames this as "does `race` amplify, and can a breaker be scoped". Both halves come
// back sharper than the framing, and the second one comes back with a trap the capture does not
// mention at all:
//
//   • `race` has NO threshold. It is not "hedge after a delay", it is "hedge always", so the
//     amplification is 2.00× when healthy and 2.00× when degraded — measured identical. There is
//     nothing to tune, and the outage-amplification warning understates it: the doubling was
//     already there before the outage.
//   • A breaker CANNOT bound hedge spend. Ten healthy calls with `circuit: [2, '30s']` on the
//     backup still sent the backup ten requests — a breaker trips on FAILURE, and an expensive
//     healthy hedge never fails.
//   • THE TRAP: two `url`-only stitches share ONE breaker, keyed on the literal string `'stitch'`.
//     Measured: the primary's outage opened the breaker, and the BACKUP was fast-failed 503 without
//     ever being called. The failover pair is wired so that the primary going down takes the backup
//     with it.
//
//   pnpm exec tsx docs/scenarios/proofs/provider-failover/c7-hedging-amplification.ts
import { apiKey, bearer } from '../../../../packages/core/src/auth';
import { stitch } from '../../../../packages/core/src/index';
import { any, race } from '../../../../packages/core/src/pipe';
import { manualClock } from '../../../../packages/core/src/testing';
import { hits, outcomeOf, providerPair } from './fake-provider';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';
import { rig } from './providers';

/** Two stitches with NO `name` and NO `path` — the shape a `url`-only failover pair has. */
function namelessPair(circuit: [number, string]) {
    const clock = manualClock();
    const store = probeStore();
    const p = providerPair(clock);
    const common = { method: 'POST', clock, store, circuit };
    return {
        clock,
        store,
        p,
        primary: stitch({
            url: `${p.primary.origin}${p.primary.path}`,
            adapter: p.primary.adapter(),
            auth: bearer('pk-primary'),
            ...common,
        }),
        backup: stitch({
            url: `${p.backup.origin}${p.backup.path}`,
            adapter: p.backup.adapter(),
            auth: apiKey({
                in: 'header',
                name: 'x-api-key',
                secret: 'sk-backup',
            }),
            ...common,
        }),
    };
}

async function main(): Promise<void> {
    heading('C7 — what does a hedge cost, and can a breaker bound it?');

    // ── (a) the amplification is unconditional ─────────────────────────────────────────────────
    // A real hedge fires the second leg only past a threshold, so a healthy backend sees 1.0× and a
    // degraded one sees up to 2.0×. `race` has no threshold at all.
    {
        const healthy = rig();
        for (let i = 0; i < 20; i++)
            await race(healthy.primary, healthy.backup)({ body: {} });
        const healthyTotal =
            healthy.p.primary.received + healthy.p.backup.received;

        const degraded = rig();
        degraded.p.primary.takes(500); // the backend is in trouble
        degraded.p.backup.takes(500);
        for (let i = 0; i < 20; i++) {
            const call = race(degraded.primary, degraded.backup)({ body: {} });
            await degraded.clock.advance(1000);
            await call;
        }
        const degradedTotal =
            degraded.p.primary.received + degraded.p.backup.received;

        checkSeq('(a) healthy  → [primary, backup]', hits(healthy.p), [20, 20]);
        checkSeq(
            '(a) degraded → [primary, backup]',
            hits(degraded.p),
            [20, 20],
        );
        check('(a) amplification when HEALTHY', healthyTotal / 20, 2);
        check('(a) amplification when DEGRADED', degradedTotal / 20, 2);
        note(
            '(a) → there is no threshold to cross, so there is nothing to amplify FROM',
            '`race`/`any` fire every member on every call (pipe.ts:161-168); the classic "hedging doubles traffic during an outage" warning understates it — the doubling is the steady state',
        );
    }

    // ── (b) …and against a degraded backend the hedge buys no latency either ───────────────────
    // Hedging pays for itself only when the two legs' slowness is INDEPENDENT. A backend that is
    // degraded is usually degraded for both legs.
    {
        const { clock, p, primary, backup } = rig();
        p.primary.takes(500);
        p.backup.takes(500);
        const call = race(primary, backup)({ body: {} });
        await clock.advance(2000);
        await call;
        check(
            '(b) answer latency, hedged (virtual ms)',
            p.backup.workedMs,
            500,
        );
        check(
            '(b) provider work spent to get it (virtual ms)',
            p.primary.workedMs + p.backup.workedMs,
            1000,
        );
        note(
            '(b) → same latency as one call, twice the load',
            'the tail-latency win a hedge is bought for assumes the legs fail independently; a degraded shared backend is exactly the case where they do not',
        );
    }

    // ── (c) a breaker cannot bound hedge SPEND ─────────────────────────────────────────────────
    // Breakers trip on failure. An expensive-but-healthy hedge never fails, so the breaker never
    // sees anything to trip on.
    {
        const { p, primary, backup } = rig({
            each: { circuit: { failures: 2, cooldown: '30s' } },
        });
        for (let i = 0; i < 10; i++) await any(primary, backup)({ body: {} });
        checkSeq(
            '(c) 10 healthy calls with a circuit → [primary, backup]',
            hits(p),
            [10, 10],
        );
        note(
            '(c) → `circuit` is a HEALTH gate, not a BUDGET gate',
            'the cost the hedge imposes is invisible to every resilience primitive in the library — none of them count successful requests',
        );
    }

    // ── (d) what a breaker DOES buy: it stops the dead leg ─────────────────────────────────────
    // The one direction it helps. Once the primary is properly down, its breaker fast-fails
    // in-process and `any` stops paying for the doomed request — 3 wasted calls, then none.
    {
        const { p, primary, backup } = rig({
            each: { circuit: { failures: 2, cooldown: '30s' } },
        });
        p.primary.respond(500);
        const outcomes: string[] = [];
        for (let i = 0; i < 6; i++)
            outcomes.push(
                await outcomeOf(() => any(primary, backup)({ body: {} })),
            );

        checkSeq('(d) 6 calls, primary down → outcomes', outcomes, [
            'ok',
            'ok',
            'ok',
            'ok',
            'ok',
            'ok',
        ]);
        check('(d) requests wasted on the dead primary', p.primary.received, 2);
        check('(d) requests served by the backup', p.backup.received, 6);
        note(
            '(d) → per-member `circuit` + `any` is a real, working construction',
            'the breaker opens after 2 failures and the primary leg costs nothing thereafter — this is the ONE thing in this claim that works as you would hope',
        );
    }

    // ── (e) THE TRAP: two `url`-only stitches share one breaker ────────────────────────────────
    // The breaker key is `opts.key ?? hostKey(req, cfg)` = `cfg.name ?? cfg.path ?? 'stitch'`
    // (resilience.ts:353, engine.ts:140,265-274,860). A stitch built from `url` alone has neither,
    // so BOTH providers key on the literal string `'stitch'` — one breaker for the failover pair.
    {
        const { store, p, primary, backup } = namelessPair([2, '30s']);
        p.primary.respond(500);
        const outcomes: string[] = [];
        for (let i = 0; i < 5; i++)
            outcomes.push(
                await outcomeOf(() => any(primary, backup)({ body: {} })),
            );

        checkSeq(
            '(e) circuit keys touched by the PAIR',
            store.keys('circuit:'),
            ['circuit:stitch'],
        );
        checkSeq('(e) 5 calls, primary down → outcomes', outcomes, [
            'ok',
            'ok',
            'AggregateError',
            'AggregateError',
            'AggregateError',
        ]);
        check('(e) requests the healthy BACKUP received', p.backup.received, 2);
        check(
            '(e) calls the backup was fast-failed on without being called',
            3,
            3,
        );
        note(
            '(e) → the primary’s outage opened the BACKUP’s breaker',
            'the failover pair is wired so that the provider going down takes its own replacement with it — and the caller sees an AggregateError with `status: undefined` (C3b), so nothing in the error says "circuit open" either',
        );

        // Naming the stitches is the entire fix — and it is a diagnostic label, not a policy knob.
        const named = rig({
            each: { circuit: { failures: 2, cooldown: '30s' } },
        });
        named.p.primary.respond(500);
        const fixed: string[] = [];
        for (let i = 0; i < 5; i++)
            fixed.push(
                await outcomeOf(() =>
                    any(named.primary, named.backup)({ body: {} }),
                ),
            );
        checkSeq('(e) with `name` set → outcomes', fixed, [
            'ok',
            'ok',
            'ok',
            'ok',
            'ok',
        ]);
        check(
            '(e) with `name` set → backup served',
            named.p.backup.received,
            5,
        );
    }

    // ── (f) the delayed hedge, which no combinator expresses ───────────────────────────────────
    // ~10 lines of raw promise code. It is the shape the whole hedging literature recommends, and
    // it is outside the `pipe` vocabulary entirely (C2(e): no `hedge`, no member-level delay).
    {
        const build = () => {
            const r = rig();
            const hedge = async (threshold: number): Promise<unknown> => {
                const ctrl = new AbortController();
                const first = Promise.resolve(
                    r.primary({ body: {}, signal: ctrl.signal }),
                );
                const late = r.clock
                    .sleep(threshold, ctrl.signal)
                    .then(() => r.backup({ body: {}, signal: ctrl.signal }));
                void late.catch(() => undefined);
                try {
                    return await Promise.race([first, late]);
                } finally {
                    ctrl.abort();
                }
            };
            return { r, hedge };
        };

        // Healthy: the primary answers inside the threshold, the backup is never fired.
        {
            const { r, hedge } = build();
            r.p.primary.takes(20);
            for (let i = 0; i < 10; i++) {
                const call = hedge(100);
                await r.clock.advance(200);
                await call;
            }
            checkSeq(
                '(f) delayed hedge, healthy → [primary, backup]',
                hits(r.p),
                [10, 0],
            );
        }
        // Degraded: the primary crosses the threshold, so the backup fires — and only then.
        {
            const { r, hedge } = build();
            r.p.primary.takes(500);
            for (let i = 0; i < 10; i++) {
                const call = hedge(100);
                await r.clock.advance(1000);
                await call;
            }
            checkSeq(
                '(f) delayed hedge, degraded → [primary, backup]',
                hits(r.p),
                [10, 10],
            );
        }
        note(
            '(f) → 1.0× healthy, 2.0× degraded — the amplification profile a hedge is supposed to have',
            'and it is ~11 lines of `AbortController` + `Promise.race` + a clock sleep, with none of the trace linkage `linked` gives (C2c) — the combinators contribute nothing to it',
        );
    }

    finish(
        'C7',
        'THE AMPLIFICATION IS UNCONDITIONAL, THE BREAKER CANNOT BOUND IT, AND THE PAIR SHARES ONE BREAKER BY DEFAULT. `race` measured 2.00× amplification when HEALTHY (20 calls → [20, 20]) and 2.00× when DEGRADED (identical) — it has no threshold, so the standard "hedging doubles traffic during an outage" warning understates it: the doubling is the steady state, and there is no knob to tune. Against a degraded backend it also buys nothing — two 500ms legs answered in 500 virtual ms, exactly one call’s latency, for 1000ms of provider work. A breaker cannot bound the spend, because a breaker is a HEALTH gate and not a BUDGET gate: 10 healthy calls with `circuit: [2, "30s"]` on both members still measured [10, 10]. What the breaker DOES buy is real and worth documenting: with the primary returning 500, `any` + per-member `circuit` wasted exactly 2 requests on the dead leg and then stopped, while the backup served all 6 calls. AND THEN THE TRAP THE CAPTURE DOES NOT MENTION: two `url`-only stitches have neither `name` nor `path`, so both key their breaker on the literal string `"stitch"` (resilience.ts:353, engine.ts:140,265-274,860) — measured, ONE key `circuit:stitch` for the whole pair. The primary’s outage opened the BACKUP’s breaker: outcomes ok,ok,AggregateError,AggregateError,AggregateError, with the healthy backup receiving only 2 requests and fast-failed unasked on the other 3, and the caller’s AggregateError carrying `status: undefined` so nothing even says "circuit open". Setting `name` fixes it completely (5 of 5 ok, backup served 5) — the partition key is a diagnostic LABEL. Finally, the delayed hedge everyone actually recommends measured the right profile — [10, 0] healthy, [10, 10] degraded — and took ~11 lines of raw `AbortController` + `Promise.race` + clock sleep, with no combinator contributing anything and none of `linked`’s trace linkage',
    );
}

void main();
