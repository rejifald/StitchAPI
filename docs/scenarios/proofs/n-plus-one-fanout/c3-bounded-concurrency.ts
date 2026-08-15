// C3 — bounded concurrency. Does `throttle: { concurrency: N }` actually bound a 100-call fan-out,
// and what happens to someone who builds a stitch per id?
//
// The governance on this shape is often concurrency-based rather than request-rate-based, so a
// requests-per-second cap does not protect you: what the vendor counts is how many of your
// connections are open at once. The only honest measurement is PEAK IN-FLIGHT at the server.
//
// MEASURED: the declaration works, on ONE stitch, and spreading the fan-out across stitch
// OBJECTS silently multiplies the budget — unless the limiter STATE is pooled: `pool: 'host'`
// in-process, a lease-capable store fleet-wide (ADR 0025), or a seam.
//   (a) no throttle → peak 100. `all()` bounded nothing (C1 d) and neither does a bare loop.
//   (b) `throttle: { concurrency: 8 }` on ONE stitch called 100 times → PEAK 8. It holds exactly,
//       and it is the right construction for this scenario.
//   (c) THE TRAP: 100 SEPARATE stitches, each declaring `concurrency: 8` → PEAK 100. Each
//       `stitch()` builds its own limiter (stitch.ts:1042-1046) with closure-local state
//       (resilience.ts:111), so "8 at a time" became "8 at a time, 100 times over".
//   (d) `pool: 'host'` fixes (c) — peak 8 across 100 separate stitches, via the module-level
//       `hostStates` registry (resilience.ts:88,111).
//   (e) …and a lease-capable `store` KEEPS that fix now (ADR 0025, #630). The engine keys the
//       store throttle with the same pool-aware host key (engine.ts:642 → :274-283) and the
//       store owns ONE counting semaphore under it (lease verbs, store.ts:90-106), so
//       `pool: 'host'` + `store` measured PEAK 8 — a budget store.spec.ts:456-464 pins
//       fleet-wide. Before #630 the store throttle kept concurrency per-instance and this exact
//       construction measured PEAK 100; that residue survives only on a lease-LESS store
//       (store.spec.ts:466-475).
//   (f) A SEAM with a seam-level `concurrency` DOES pool across its members — peak 8 over 100
//       member stitches (seam.ts:51-69) — which survives the stitch-per-id shape with nothing
//       else declared.
//   (g) A BACKING-OFF CALL HOLDS ITS SLOT. The backoff sleep is inside the `try` the release's
//       `finally` guards (engine.ts:760-765, 834-837), so N slots can be occupied by N calls that
//       are asleep and issuing nothing — measured 4 of 4 idle for 95% of the run.
//   (h) The coalescer sits OUTSIDE the throttle: 100 calls over 30 ids at a bound of 8 fired 22
//       `throttled` events, not 92, so the joiners never take a slot. The bound is on REQUESTS.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c3-bounded-concurrency.ts
import { seam, stitch } from '../../../../packages/core/src/index';
import { memoryStore } from '../../../../packages/core/src/store';
import { manualClock } from '../../../../packages/core/src/testing';
import { type Customer, FakeVendor, idsOf } from './fake-vendor';
import { check, checkPeak, checkSeq, finish, heading, note } from './harness';
import { runOut } from './virtual-time';

const ORDERS = 100;
const BOUND = 8;
const HOLD = 50;

/** A fresh vendor with 100 orders over 100 distinct customers (no duplicates: this is not C2). */
function context(host: string) {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: ORDERS,
        customers: ORDERS,
        holdMs: HOLD,
    });
    return { clock, vendor, base: `https://${host}` };
}

async function main(): Promise<void> {
    heading(
        `C3 — ${String(ORDERS)} calls, a declared bound of ${String(BOUND)}: what was the PEAK IN-FLIGHT?`,
    );

    // ── (a) the unbounded baseline ─────────────────────────────────────────────────────────────
    {
        const { clock, vendor, base } = context('a.vendor.test');
        const call = stitch<Customer>({
            name: 'customer',
            url: `${base}/customers/{id}`,
            adapter: vendor.adapter(),
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 60_000, 1_000);
        await Promise.all(pending);
        checkPeak('(a) no throttle', vendor.peakInFlight, undefined, 100);
    }

    // ── (b) ONE stitch, called 100 times, with a declared bound ────────────────────────────────
    // This is the construction the capture predicted would work, and it does — exactly.
    {
        const { clock, vendor, base } = context('b.vendor.test');
        const call = stitch<Customer>({
            name: 'customer',
            url: `${base}/customers/{id}`,
            adapter: vendor.adapter(),
            throttle: { concurrency: BOUND },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 60_000, 1_000);
        const results = await Promise.all(pending);
        checkPeak(
            '(b) ONE stitch, `throttle: { concurrency: 8 }`',
            vendor.peakInFlight,
            BOUND,
            BOUND,
        );
        check(
            '(b) all 100 calls still completed',
            results.filter((r) => r.ok).length,
            100,
        );
        check('(b) requests made', vendor.customerRequests, 100);
        note(
            '(b) → the slot is keyed on `nameOf(cfg)` (engine.ts:274-283)',
            'one stitch called N times is ONE key over ONE limiter — which is exactly this scenario',
        );
    }

    // ── (c) THE TRAP: one stitch per id, each declaring the same bound ─────────────────────────
    // The construction C1 (c) showed is the only way `all()` can express the scenario. Give each of
    // those 100 stitches the bound and the bound evaporates: `makeStitch` builds a limiter per
    // stitch, and `createThrottle`'s per-key state is closure-local unless pooled.
    {
        const { clock, vendor, base } = context('c.vendor.test');
        const adapter = vendor.adapter();
        const calls = idsOf(vendor.orders).map((id) =>
            stitch<Customer>({
                name: `customer:${id}`,
                url: `${base}/customers/${id}`,
                adapter,
                throttle: { concurrency: BOUND },
                clock,
            }),
        );
        const pending = calls.map((c) => c().safe());
        await runOut(clock, 60_000, 1_000);
        await Promise.all(pending);
        checkPeak(
            '(c) 100 SEPARATE stitches, each `concurrency: 8`',
            vendor.peakInFlight,
            BOUND,
            100,
        );
        note(
            '(c) → 100 limiters, 8 slots each: a declared budget multiplied by 100',
            'stitch.ts:1042-1046 builds a throttle per stitch; `createThrottle` keeps state in a closure-local Map (resilience.ts:111)',
        );
    }

    // ── (d) `pool: 'host'` re-pools the separate stitches ──────────────────────────────────────
    {
        const { clock, vendor, base } = context('d.vendor.test');
        const adapter = vendor.adapter();
        const calls = idsOf(vendor.orders).map((id) =>
            stitch<Customer>({
                name: `customer:${id}`,
                url: `${base}/customers/${id}`,
                adapter,
                throttle: { concurrency: BOUND, pool: 'host' as const },
                clock,
            }),
        );
        const pending = calls.map((c) => c().safe());
        await runOut(clock, 60_000, 1_000);
        await Promise.all(pending);
        checkPeak(
            "(d) …the same 100 stitches with `pool: 'host'`",
            vendor.peakInFlight,
            BOUND,
            BOUND,
        );
        note(
            '(d) → the state moves to a MODULE-level registry',
            '`hostStates` (resilience.ts:88) is shared by every host-pooled limiter in the process, and `hostKey` keys on the URL host (engine.ts:274-283)',
        );
    }

    // ── (e) …and a lease-capable `store` now KEEPS the fix ─────────────────────────────────────
    // A store is what you add to make the budgets cross-process, and since ADR 0025 (#630) that
    // includes CONCURRENCY: the engine hands the store throttle the same pool-aware host key it
    // gives the in-process limiter (engine.ts:642 → :274-283), and a store with the lease verbs
    // (`memoryStore`: store.ts:90-106) holds ONE counting semaphore under that key — for this
    // process and for every other worker on the same store (store.spec.ts:456-464).
    {
        const { clock, vendor, base } = context('e.vendor.test');
        const adapter = vendor.adapter();
        const store = memoryStore();
        const calls = idsOf(vendor.orders).map((id) =>
            stitch<Customer>({
                name: `customer:${id}`,
                url: `${base}/customers/${id}`,
                adapter,
                throttle: { concurrency: BOUND, pool: 'host' as const },
                store,
                clock,
            }),
        );
        const pending = calls.map((c) => c().safe());
        await runOut(clock, 60_000, 1_000);
        await Promise.all(pending);
        checkPeak(
            "(e) `pool: 'host'` + a shared `store`",
            vendor.peakInFlight,
            BOUND,
            BOUND,
        );
        note(
            '(e) → one budget, keyed like the in-process pool, owned by the store',
            'the residue is a lease-LESS store (no `lease`/`release` — the fallback an eventually-consistent KV takes, store.ts:226-233): concurrency stays per-process there (store.spec.ts:466-475), which is where the old peak-100 trap survives',
        );
    }

    // ── (f) a SEAM pools its members, which is the construction that survives ──────────────────
    {
        const { clock, vendor, base } = context('f.vendor.test');
        const s = seam({
            baseUrl: base,
            adapter: vendor.adapter(),
            throttle: { concurrency: BOUND },
            clock,
        });
        const calls = idsOf(vendor.orders).map((id) =>
            s.stitch<Customer>({
                name: `customer:${id}`,
                path: `/customers/${id}`,
            }),
        );
        const pending = calls.map((c) => c().safe());
        await runOut(clock, 60_000, 1_000);
        await Promise.all(pending);
        checkPeak(
            '(f) 100 seam MEMBERS under a seam-level `concurrency: 8`',
            vendor.peakInFlight,
            BOUND,
            BOUND,
        );
        note(
            '(f) → `seamBucket` re-keys every acquire onto `seam:<id>` (seam.ts:51-69)',
            'one bucket for every member, whatever its name — a stitch-per-id fan-out bounded with neither `pool` nor a store declared',
        );
    }

    // ── (g) A BACKING-OFF CALL HOLDS ITS SLOT ──────────────────────────────────────────────────
    // The retry-backoff sleep (engine.ts:760-765) is INSIDE the `try` whose `finally` releases
    // (engine.ts:834-837), so a call that is asleep still occupies one of the N slots. 16 calls,
    // bound 4, every first attempt 429ed, a 1s fixed backoff: if the slot were released at the
    // 429 the 5th call would leave at t=50. It leaves at t=1050 — the whole backoff later.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: 16,
            customers: 16,
            holdMs: HOLD,
        });
        vendor.burst429(16); // every first attempt is rate-limited; every retry succeeds
        const call = stitch<Customer>({
            name: 'customer',
            url: 'https://g.vendor.test/customers/{id}',
            adapter: vendor.adapter(),
            throttle: { concurrency: 4 },
            retry: { attempts: 2, backoff: { curve: 'fixed', base: '1s' } },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 60_000, 1_000);
        const results = await Promise.all(pending);
        const first = vendor.customerCalls.filter((c) => c.status === 429);
        checkPeak(
            '(g) peak in-flight with a retry in the mix',
            vendor.peakInFlight,
            4,
            4,
        );
        check(
            '(g) requests (16 calls x 2 attempts)',
            vendor.customerRequests,
            32,
        );
        check(
            '(g) calls that eventually succeeded',
            results.filter((r) => r.ok).length,
            16,
        );
        checkSeq(
            '(g) when each wave of 4 FIRST attempts left',
            [...new Set(first.map((c) => c.at))],
            [0, 1050, 2100, 3150],
        );
        note(
            '(g) → wave 2 left at t=1050, not t=50',
            'the 429 landed at t=50 and the slot stayed held for the whole 1000ms backoff — 4 of 4 slots occupied by calls doing nothing, ~95% of the declared budget idle',
        );
        checkSeq(
            '(g) when the first call`s RETRY finally left',
            vendor.customerCalls
                .filter((c) => c.id === 'cust-001')
                .map((c) => c.at),
            [0, 4200],
        );
        note(
            '(g) → and a retry re-queues at the BACK of the FIFO',
            '`continue` (engine.ts:765) runs the `finally` release, which hands the slot to the next WAITER (resilience.ts:162-164); the retrying call then re-acquires behind every fresh call',
        );
    }

    // ── (h) the coalescer sits OUTSIDE the throttle ────────────────────────────────────────────
    // The cache lookup is outermost over the expensive chain (engine.ts:1713-1718) and the throttle
    // is acquired inside `attemptLoop` — so a coalesced JOINER never takes a slot. The decisive
    // measurement is the `throttled` progress event, which fires once per acquire that actually
    // BLOCKED (engine.ts:636-643): 100 calls over 30 ids at a bound of 8 should block at most
    // 30 - 8 = 22 times, not 100 - 8 = 92.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: 100,
            customers: 30,
            holdMs: HOLD,
        });
        let throttled = 0;
        const call = stitch<Customer>({
            name: 'customer',
            url: 'https://h.vendor.test/customers/{id}',
            adapter: vendor.adapter(),
            throttle: { concurrency: BOUND },
            cache: { ttl: '60s' },
            trace: {
                handle(event) {
                    if (
                        event.type === 'progress' &&
                        event.phase === 'throttled'
                    )
                        throttled += 1;
                },
            },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 60_000, 1_000);
        const results = await Promise.all(pending);
        check(
            '(h) requests made (100 calls, 30 ids)',
            vendor.customerRequests,
            30,
        );
        check('(h) calls completed', results.filter((r) => r.ok).length, 100);
        checkPeak('(h) peak in-flight', vendor.peakInFlight, BOUND, BOUND);
        check('(h) `throttled` events — acquires that BLOCKED', throttled, 22);
        note(
            '(h) → 22 = the 30 real requests minus the first 8',
            'the 70 coalesced joiners never reached the limiter at all, so the bound applies to REQUESTS and not to callers — which is what you want, and it means a fan-out over duplicates finishes far faster than its call count suggests',
        );
    }

    finish(
        'C3',
        'YES on one stitch, NO on any UN-POOLED construction that spreads the fan-out across stitch OBJECTS — and that failure is silent. `throttle: { concurrency: 8 }` on ONE stitch called 100 times measured PEAK 8 in-flight exactly, against an unthrottled baseline of 100, with all 100 calls completing. That is the right construction for this scenario and it needs no user code. THE TRAP IS REAL AND IT IS THE CONSTRUCTION C1 FORCES: the only way `all()` can express a per-id fan-out is one stitch per id, and 100 separate stitches each declaring `concurrency: 8` measured PEAK 100 — `makeStitch` builds a limiter per stitch (stitch.ts:1042-1046) over closure-local state (resilience.ts:111), so a declared budget of 8 became 800. `pool: \'host\'` repairs it (peak 8 over 100 stitches, via the module-level `hostStates` registry, resilience.ts:88) — and a lease-capable `store` KEEPS THE REPAIR since ADR 0025 (#630): the engine keys the store throttle with the same pool-aware host key (engine.ts:642), the store owns ONE counting semaphore under it (store.ts:90-106), and `pool: "host"` + `store` measured PEAK 8 — a budget store.spec.ts:456-464 pins fleet-wide, every worker on that store included. The residue is a lease-LESS store (no `lease`/`release`): concurrency stays per-process there (store.spec.ts:466-475), the one place the old peak-100 trap survives. A SEAM also survives the stitch-per-id shape with nothing else declared: 100 members under a seam-level `concurrency: 8` measured peak 8, because `seamBucket` re-keys every acquire onto one `seam:<id>` (seam.ts:51-69). ONE MORE, AGAINST AN ASSUMPTION THIS PROOF MADE AND HAD TO CORRECT: a BACKING-OFF call HOLDS its slot. The retry sleep sits inside the `try` the release `finally` guards (engine.ts:760-765, 834-837), so with a bound of 4, a 429ed first wave and a 1s backoff, the fifth call left at t=1050 rather than t=50 — 4 of 4 slots occupied by calls that were asleep and issuing nothing, ~95% of the declared budget idle. And a retry re-queues at the BACK of the FIFO (the `continue` releases to the next waiter, resilience.ts:162-164): the first call`s retry left at t=4200, behind every other call`s first attempt. ONE CLEAN WIN TO END ON: the coalescer sits OUTSIDE the throttle (engine.ts:1713-1718), so 100 calls over 30 ids at a bound of 8 fired exactly 22 `throttled` events — 30 real requests minus the first 8 — proving the 70 joiners never reached the limiter. The bound applies to REQUESTS, not to callers',
    );
}

void main();
