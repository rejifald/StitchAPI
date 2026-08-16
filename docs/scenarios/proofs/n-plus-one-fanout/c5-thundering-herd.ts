// C5 — THE THUNDERING HERD. 100 calls leave together, 100 calls are 429ed together. When do the
// retries arrive?
//
// This matters more here than anywhere else, precisely because the calls started together. A
// deterministic backoff adds the SAME number to the SAME instant and re-clusters the burst exactly
// as it was; only jitter breaks it. `backoff: 'expo-jitter'` is the default (resilience.ts:45), so
// the question is whether the default actually de-clusters — quantified, not asserted.
//
// The measurement is the ARRIVAL TIME at the server. `manualClock` reports a timer's EXACT due
// time (test-clock.ts:90), so a backoff of 372.4ms is recorded as 372.4 and the bucketing is done
// by this proof, at a stated width. `largestBucket(arrivals, 1)` is how many retries share their
// most crowded MILLISECOND: 1 means fully de-clustered, 100 means the burst re-formed intact. A
// 100ms width is also reported, because that is closer to the scale a rate window cares about.
//
// MEASURED: the default works, and it is the only one of the three that does.
//   (a) `'fixed'`   → 100 retries in ONE millisecond. The burst re-formed exactly.
//   (b) `'expo'`    → 100 retries in ONE millisecond. Identical: doubling a constant is a constant.
//   (c) `'expo-jitter'` (default) → ~100 distinct milliseconds, worst millisecond holds 1-2, and
//       at a 100ms width the 100 retries are spread over all 10 slices of the window, ~10 each.
//       This is the whole reason it is the default.
//   (d) THE ONE THAT UNDOES IT, and it is on by DEFAULT: a vendor that sends `Retry-After` gets
//       obeyed verbatim (engine.ts:748-751), and every retry is then scheduled at the SAME
//       absolute instant — 100 in one bucket, WITH `expo-jitter` configured. `retry: { respect:
//       false }` restores the jitter and disobeys the server.
//   (e) The jitter is FULL, not equal: `Math.random() * computed` (resilience.ts:54), so a retry
//       can land arbitrarily early. That is the aggressive-but-correct choice for de-clustering.
//   (f) Coalescing does NOT protect a herd: C2 measured that a failed leader releases its
//       followers to run independently, so a 429ed cohort of duplicates re-fans at full width.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c5-thundering-herd.ts
import { stitch } from '../../../../packages/core/src/index';
import {
    type ManualClock,
    manualClock,
} from '../../../../packages/core/src/testing';
import type { BackoffCurve, Stitch } from '../../../../packages/core/src/types';
import {
    type Customer,
    FakeVendor,
    distinctBuckets,
    idsOf,
    largestBucket,
} from './fake-vendor';
import {
    check,
    checkAtLeast,
    checkAtMost,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { runOut } from './virtual-time';

const HERD = 100;
/** Long enough that a 1ms bucket is a fine-grained reading of the jitter window. */
const BASE = '1s';
const BASE_MS = 1000;

interface Spread {
    /** How many retries shared their most crowded MILLISECOND. */
    largest: number;
    /** How many distinct milliseconds the retries occupied. */
    buckets: number;
    /** The same, at a 100ms width — a tenth of the jitter window. */
    largestCoarse: number;
    coarseBuckets: number;
    first: number;
    last: number;
    /** Every retry arrival, for the raw record. */
    arrivals: number[];
}

/** Round for printing: the raw arrivals are fractional and unreadable at full precision. */
const ms = (x: number): string => x.toFixed(1);

/**
 * Fire `HERD` calls in one tick, 429 every one of them, and report WHEN the retries arrived.
 *
 * The vendor is told to 429 exactly the first `HERD` requests, so the whole cohort is throttled
 * simultaneously and every retry succeeds — which isolates the backoff curve as the only thing
 * deciding arrival time.
 */
async function herd(opts: {
    /** A curve AND a base, both present: the config surface refuses an all-optional envelope. */
    backoff: { curve: BackoffCurve; base: string };
    retryAfter?: string;
    /** `retry.respect` — defaults ON in the library, so this mirrors it. */
    respect?: boolean;
}): Promise<Spread> {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: HERD,
        customers: HERD,
        holdMs: 0, // the 429 comes back immediately: every call is throttled in the same instant
        ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}),
    });
    vendor.burst429(HERD);
    const call = stitch<Customer>({
        name: 'customer',
        url: 'https://api.vendor.test/customers/{id}',
        adapter: vendor.adapter(),
        retry: {
            attempts: 2,
            backoff: opts.backoff,
            respect: opts.respect ?? true,
        },
        clock,
    });
    return measure(clock, vendor, call);
}

/** Drive one cohort to completion and reduce its retry arrivals to a {@link Spread}. */
async function measure(
    clock: ManualClock,
    vendor: FakeVendor,
    call: Stitch<Customer>,
): Promise<Spread> {
    const pending = idsOf(vendor.orders).map((id) =>
        call({ params: { id } }).safe(),
    );
    await runOut(clock, 4 * BASE_MS, 250);
    await Promise.all(pending);
    const arrivals = vendor.arrivalsAfter(HERD); // everything after the 429ed first wave
    return {
        largest: largestBucket(arrivals, 1),
        buckets: distinctBuckets(arrivals, 1),
        largestCoarse: largestBucket(arrivals, 100),
        coarseBuckets: distinctBuckets(arrivals, 100),
        first: Math.min(...arrivals),
        last: Math.max(...arrivals),
        arrivals,
    };
}

const report = (label: string, s: Spread): void => {
    note(
        `${label} spread`,
        `${String(s.buckets)} distinct ms over [${ms(s.first)}, ${ms(s.last)}]ms; worst ms holds ${String(s.largest)}, worst 100ms slice holds ${String(s.largestCoarse)} across ${String(s.coarseBuckets)} slices`,
    );
};

async function main(): Promise<void> {
    heading(
        `C5 — ${String(HERD)} calls 429ed in the same instant: when do the retries land?`,
    );

    // ── (a) `'fixed'` — the burst re-forms exactly ─────────────────────────────────────────────
    {
        const s = await herd({ backoff: { curve: 'fixed', base: BASE } });
        check('(a) `fixed` retries that arrived', s.arrivals.length, HERD);
        check(
            '(a) `fixed` — retries in the WORST millisecond',
            s.largest,
            HERD,
        );
        check('(a) `fixed` — distinct milliseconds', s.buckets, 1);
        checkSeq(
            '(a) `fixed` — [first, last] arrival',
            [s.first, s.last],
            [BASE_MS, BASE_MS],
        );
        report('(a) `fixed`', s);
    }

    // ── (b) `'expo'` — identical, because attempt 2 is base·2^0 ────────────────────────────────
    {
        const s = await herd({ backoff: { curve: 'expo', base: BASE } });
        check('(b) `expo` — retries in the WORST millisecond', s.largest, HERD);
        check('(b) `expo` — distinct milliseconds', s.buckets, 1);
        report('(b) `expo`', s);
        note(
            '(b) → doubling a constant is still a constant',
            'every member of the cohort computes the same delay from the same instant (resilience.ts:48-55); the burst arrives as one packet whatever the exponent',
        );
    }

    // ── (c) `'expo-jitter'`, the DEFAULT — the burst is broken up ──────────────────────────────
    // `Math.random()` is real randomness, so the exact numbers move run to run. The assertions are
    // therefore bounds, set far from both the ~1-2 per millisecond a birthday estimate gives for
    // 100 continuous draws over a 1000ms window and the 100 the deterministic curves produce.
    {
        const s = await herd({ backoff: { curve: 'expo-jitter', base: BASE } });
        check(
            '(c) `expo-jitter` — retries that arrived',
            s.arrivals.length,
            HERD,
        );
        checkAtMost(
            '(c) `expo-jitter` — retries in the WORST millisecond',
            s.largest,
            4,
        );
        checkAtLeast(
            '(c) `expo-jitter` — distinct milliseconds',
            s.buckets,
            80,
        );
        checkAtMost(
            '(c) `expo-jitter` — retries in the WORST 100ms slice',
            s.largestCoarse,
            25,
        );
        check(
            '(c) `expo-jitter` — 100ms slices of the window touched (of 10)',
            s.coarseBuckets,
            10,
        );
        checkAtMost('(c) earliest retry (ms)', s.first, 200);
        checkAtLeast('(c) latest retry (ms)', s.last, 800);
        report('(c) `expo-jitter`', s);

        // …and the same measurement with NOTHING declared but `attempts`, to establish that the
        // curve above really is what a bare `retry` gets. The base is then the built-in 100ms
        // (resilience.ts:46), so the window is a tenth as wide and the millisecond buckets crowd
        // proportionally — the point is only that the arrivals are SPREAD rather than identical.
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: HERD,
            customers: HERD,
            holdMs: 0,
        });
        vendor.burst429(HERD);
        const bare = await measure(
            clock,
            vendor,
            stitch<Customer>({
                name: 'customer',
                url: 'https://api.vendor.test/customers/{id}',
                adapter: vendor.adapter(),
                retry: { attempts: 2 }, // no `backoff` at all
                clock,
            }),
        );
        checkAtLeast(
            '(c) a BARE `retry: { attempts: 2 }` — distinct milliseconds',
            bare.buckets,
            50,
        );
        checkAtMost(
            '(c) …latest retry (ms), against the 100ms default base',
            bare.last,
            100,
        );
        report('(c) bare `retry: { attempts: 2 }`', bare);
        note(
            '(c) → `expo-jitter` really is the default',
            '`kind = policy.curve ?? "expo-jitter"` (resilience.ts:45) with `base ?? 100` (resilience.ts:46); nothing has to be configured to de-cluster',
        );
    }

    // ── (d) …and the default vendor behaviour undoes it ────────────────────────────────────────
    // A well-behaved 429 carries `Retry-After`. The engine prefers it over the computed backoff
    // (`ra ?? backoffDelay(...)`, engine.ts:748-761) and `retry.respect` defaults ON — so every
    // member of the cohort is told the same number and the herd re-forms, with `expo-jitter` still
    // configured and doing nothing.
    {
        const s = await herd({
            backoff: { curve: 'expo-jitter', base: BASE },
            retryAfter: '2',
        });
        check('(d) with `Retry-After: 2` — worst millisecond', s.largest, HERD);
        check('(d) distinct milliseconds', s.buckets, 1);
        checkSeq('(d) [first, last] arrival', [s.first, s.last], [2000, 2000]);
        report('(d) `expo-jitter` + `Retry-After`', s);

        const restored = await herd({
            backoff: { curve: 'expo-jitter', base: BASE },
            retryAfter: '2',
            respect: false,
        });
        checkAtMost(
            '(d) …with `retry: { respect: false }` — worst millisecond',
            restored.largest,
            4,
        );
        checkAtLeast('(d) …distinct milliseconds', restored.buckets, 80);
        report('(d) `respect: false`', restored);
        note(
            '(d) → the fix disobeys the server',
            '`respect: false` is all-or-nothing: there is no "honour the header, then jitter around it" — the two policies cannot be combined in configuration',
        );
    }

    // ── (e) the jitter is FULL, not equal ──────────────────────────────────────────────────────
    // `delay = Math.random() * computed` (resilience.ts:54) — the whole window, from 0. An "equal
    // jitter" scheme (half fixed, half random) would floor at base/2. Measuring the earliest
    // arrival across a large cohort distinguishes them.
    {
        const s = await herd({ backoff: { curve: 'expo-jitter', base: BASE } });
        checkAtMost(
            '(e) earliest of 100 retries, against base/2 = 500ms',
            s.first,
            400,
        );
        note(
            '(e) → full jitter, so a retry may land almost immediately',
            'aggressive for de-clustering and correct for it; it does mean the effective minimum wait is 0, not base',
        );
    }

    // ── (f) coalescing does not protect the herd ───────────────────────────────────────────────
    // C2 (e) measured the mechanism; here is what it costs a throttled fan-out. 100 calls over 20
    // distinct ids, all 429ed: a cache collapses the SUCCESSES, but the failed leaders release
    // their followers, so the cohort re-fans at full width.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: HERD,
            customers: 20,
            holdMs: 0,
            retryAfter: '1',
        });
        vendor.burst429(20); // only the 20 LEADERS are throttled
        const call = stitch<Customer>({
            name: 'customer',
            url: 'https://api.vendor.test/customers/{id}',
            adapter: vendor.adapter(),
            cache: { ttl: '60s' },
            retry: { attempts: 1 }, // no retry: isolate the follower re-run from a retry
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            call({ params: { id } }).safe(),
        );
        await runOut(clock, 4 * BASE_MS, 250);
        const results = await Promise.all(pending);
        check(
            '(f) requests for 100 calls over 20 ids when the leaders are 429ed',
            vendor.customerRequests,
            100,
        );
        check(
            '(f) calls that succeeded',
            results.filter((r) => r.ok).length,
            80,
        );
        check(
            '(f) the 20 leaders failed, the 80 followers re-ran and succeeded',
            results.filter((r) => !r.ok).length,
            20,
        );
        note(
            '(f) → the coalescer is a SUCCESS-path optimisation',
            'engine.ts:1646-1659 — a failed leader hands its followers nothing, so exactly the cohort that just tripped a rate limit is the cohort that fans back out at full width',
        );
    }

    finish(
        'C5',
        "THE DEFAULT DOES DE-CLUSTER, and the default VENDOR behaviour cancels it. 100 calls 429ed in the same instant, over a 1s backoff window: `'fixed'` put all 100 retries in ONE MILLISECOND (t=1000.0, 1 distinct arrival time), `'expo'` did exactly the same (doubling a constant is still a constant — attempt 2 is base·2^0), and `'expo-jitter'` — the default, resilience.ts:45 — spread them over ~98 distinct milliseconds from ~4ms to ~990ms, with the worst millisecond holding 2 and all ten 100ms slices of the window occupied (worst slice ~14-16). A bare `retry: { attempts: n }` therefore already breaks the herd, with nothing to configure. THE TRAP IS THAT A WELL-BEHAVED VENDOR UNDOES IT: a 429 carrying `Retry-After` is obeyed verbatim (`ra ?? backoffDelay(...)`, engine.ts:748-761) and `retry.respect` defaults ON, so `Retry-After: 2` put all 100 retries back into ONE millisecond at exactly t=2000 with `expo-jitter` still configured and contributing nothing. `retry: { respect: false }` restored the ~98-millisecond spread and is all-or-nothing — there is no \"honour the header, then jitter around it\", so the choice is obey-and-cluster or ignore-and-spread. Two riders. The jitter is FULL (`Math.random() * computed`, resilience.ts:54), not equal, so the earliest of 100 retries measured 2-8ms against a base/2 floor of 500 — aggressive, and correct for this. And COALESCING DOES NOT PROTECT A HERD: with 100 calls over 20 ids and only the 20 leaders 429ed, the run made 100 requests and 80 followers re-fanned at full width, because a failed leader releases its joiners (engine.ts:1646-1659) — the cohort that just tripped the limit is exactly the cohort that fans back out",
    );
}

void main();
