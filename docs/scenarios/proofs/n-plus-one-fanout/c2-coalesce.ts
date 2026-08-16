// C2 — THE DECIDING CLAIM. Does `cache.coalesce` collapse IN-FLIGHT duplicates?
//
// 100 orders commonly reference far fewer customers. A cache that only helps AFTER a response
// lands does nothing for a simultaneous fan-out — every one of the 100 calls misses, because none
// of them has finished yet. The fix is single-flight/in-flight coalescing, and most clients do not
// have it. `cache.coalesce` is documented as `'process' | 'cluster' | false` and nothing in this
// pass had exercised it.
//
// MEASURED, and IT IS REAL. 100 concurrent calls over 30 distinct ids:
//   (a) no cache at all → 100 requests. The 3.33x quota bill the capture describes.
//   (b) `cache: { ttl }` → 30 requests. ONE PER DISTINCT ID, from configuration alone, with all
//       100 calls in flight simultaneously and not one response yet landed. This is in-flight
//       coalescing, it is ON BY DEFAULT the moment you add a `cache` block, and it is the finding.
//   (c) `coalesce: false` → back to 100. So (b) is the coalescer, not the TTL cache.
//   (d) `'cluster'` → 30, identical to `'process'` (cache.ts:396-397 degrades it in v1).
//
// AND THE OTHER DIRECTION, which the capture did not ask about and which is bigger than it looks:
//   (e) A COALESCED FAILURE IS NOT SHARED. 100 concurrent calls for ONE id that 404s made 100
//       requests, in two waves — the leader, then 99 followers that each re-ran on their own
//       (engine.ts:1647-1659). Coalescing buys exactly nothing for a failing id, and the second
//       wave lands as a synchronised burst.
//   (f) The joiners do NOT get the leader's error; each gets its own. So one 404 is diagnosed 100
//       times and the vendor is asked 100 times for a resource that does not exist.
//   (g) The footgun: `cache: { ttl: 0 }` — the obvious spelling for "coalesce but do not cache" —
//       caches FOREVER (store.ts:45, `ttl ? now() + ttl : 0`, and `expires === 0` reads as live).
//   (h) …and `sensitive: true` silently turns the whole thing off, coalescing included.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c2-coalesce.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    CacheOptions,
    SafeResult,
} from '../../../../packages/core/src/types';
import { type Customer, FakeVendor, idsOf } from './fake-vendor';
import {
    check,
    checkRequests,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { runOut } from './virtual-time';

const BASE = 'https://api.vendor.test';
const ORDERS = 100;
const CUSTOMERS = 30;
const HOLD = 50;
const TTL = '60s';

interface Run {
    vendor: FakeVendor;
    results: SafeResult<Customer>[];
}

/**
 * Fire every order's customer lookup CONCURRENTLY through ONE stitch, with `cache` as given, and
 * run the clock out. This is the scenario's shape exactly: N calls in the same tick, each with its
 * own id, over a smaller pool of distinct ids.
 */
async function fanOut(opts: {
    cache?: CacheOptions;
    customers?: number;
    notFound?: readonly string[];
    sensitive?: boolean;
}): Promise<Run> {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: ORDERS,
        customers: opts.customers ?? CUSTOMERS,
        holdMs: HOLD,
        ...(opts.notFound ? { notFound: opts.notFound } : {}),
    });
    const fetchCustomer = stitch<Customer>({
        name: 'customer',
        url: `${BASE}/customers/{id}`,
        adapter: vendor.adapter(),
        clock,
        ...(opts.cache ? { cache: opts.cache } : {}),
        ...(opts.sensitive ? { sensitive: true } : {}),
    });
    const pending = idsOf(vendor.orders).map((id) =>
        fetchCustomer({ params: { id } }).safe(),
    );
    await runOut(clock, 20_000, 1_000);
    return { vendor, results: await Promise.all(pending) };
}

const okCount = (rs: readonly SafeResult<Customer>[]): number =>
    rs.filter((r) => r.ok).length;

async function main(): Promise<void> {
    heading(
        `C2 — ${String(ORDERS)} CONCURRENT calls over ${String(CUSTOMERS)} distinct ids: how many requests reach the server?`,
    );

    // ── (a) the baseline: no cache block at all ────────────────────────────────────────────────
    {
        const { vendor, results } = await fanOut({});
        checkRequests(
            '(a) no `cache` block',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        check('(a) calls that succeeded', okCount(results), 100);
        check('(a) distinct ids asked for', vendor.distinctIds, CUSTOMERS);
        checkSeq(
            '(a) requests for the three most-repeated ids',
            [
                vendor.requestsFor('cust-001'),
                vendor.requestsFor('cust-002'),
                vendor.requestsFor('cust-030'),
            ],
            [4, 4, 3],
        );
    }

    // ── (b) THE MEASUREMENT: a `cache` block, default coalescing ───────────────────────────────
    // Nothing has finished when the 100th call starts, so a read-through TTL cache alone cannot
    // help. 30 requests means the duplicates were collapsed WHILE IN FLIGHT.
    {
        const { vendor, results } = await fanOut({ cache: { ttl: TTL } });
        checkRequests(
            '(b) `cache: { ttl }` — default coalescing',
            vendor.customerRequests,
            vendor.distinctIds,
            30,
        );
        check('(b) calls that succeeded', okCount(results), 100);
        check('(b) DISTINCT ids asked for', vendor.distinctIds, CUSTOMERS);
        checkSeq(
            '(b) requests per id — every id exactly once',
            [...new Set(vendor.perIdCounts())],
            [1],
        );
        check(
            '(b) callers served without their own request',
            ORDERS - vendor.customerRequests,
            70,
        );
        note(
            '(b) → in-flight coalescing, from one config field',
            '`join(key)` returns a leader claim to the first caller and a shared promise to the rest (cache.ts:207-262); the engine awaits it at engine.ts:1634-1663',
        );
    }

    // ── (c) turn the coalescer off and the TTL cache alone buys NOTHING here ───────────────────
    // Same cache, same TTL, `coalesce: false`: 100 requests. Every one of the 100 calls missed,
    // because a simultaneous fan-out has no completed response to hit.
    {
        const { vendor } = await fanOut({
            cache: { ttl: TTL, coalesce: false },
        });
        checkRequests(
            '(c) `coalesce: false`',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        note(
            '(c) → the TTL cache is not what saved (b)',
            'a read-through cache helps the NEXT fan-out; the coalescer helps THIS one',
        );
    }

    // ── (d) `'cluster'` is accepted and behaves as `'process'` in v1 ───────────────────────────
    {
        const { vendor } = await fanOut({
            cache: { ttl: TTL, coalesce: 'cluster' },
        });
        checkRequests(
            "(d) `coalesce: 'cluster'`",
            vendor.customerRequests,
            vendor.distinctIds,
            30,
        );
        note(
            '(d) → identical to `process`, by design and silently',
            "cache.ts:396-397 — `config.coalesce === false ? false : 'process'`; the cross-process protocol is deferred and nothing warns that you did not get it",
        );
    }

    // ── (e) THE OTHER DIRECTION: a coalesced FAILURE is not shared ─────────────────────────────
    // 100 concurrent calls for ONE id, which 404s. If the failure were shared this would be 1
    // request. It is 100 — the leader, then 99 followers each re-running independently.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: ORDERS,
            customers: 1,
            holdMs: HOLD,
            notFound: ['cust-001'],
        });
        const fetchCustomer = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            cache: { ttl: TTL },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            fetchCustomer({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        const results = await Promise.all(pending);

        checkRequests(
            '(e) 100 concurrent calls for ONE id that 404s',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        check('(e) calls that failed', results.length - okCount(results), 100);
        // Two waves: the leader alone, then the 99 followers it rejected.
        const arrivals = vendor.customerCalls.map((c) => c.at);
        check('(e) DISTINCT arrival times (waves)', new Set(arrivals).size, 2);
        checkSeq(
            '(e) wave sizes',
            [
                arrivals.filter((a) => a === arrivals[0]).length,
                arrivals.filter((a) => a !== arrivals[0]).length,
            ],
            [1, 99],
        );
        note(
            '(e) → engine.ts:1646-1649 and 1656-1659',
            "`claim.fail(new Error('cache: leader run failed'))`, and each follower's `catch` re-runs the whole chain on its own",
        );
    }

    // ── (f) …and every joiner diagnoses the failure for itself ─────────────────────────────────
    // The leader's error is never handed on. Each follower gets ITS OWN 404 from ITS OWN request,
    // which is why (e) is 100 requests rather than 1 error fanned out to 100 callers.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: 20,
            customers: 1,
            holdMs: HOLD,
            notFound: ['cust-001'],
        });
        const fetchCustomer = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            cache: { ttl: TTL },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            fetchCustomer({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        const results = await Promise.all(pending);
        const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));

        check(
            '(f) requests for 20 concurrent calls, one dead id',
            vendor.customerRequests,
            20,
        );
        checkSeq(
            '(f) distinct error messages seen by the callers',
            [...new Set(errors.map((e) => e.message))],
            ['HTTP 404'],
        );
        checkSeq(
            '(f) distinct statuses',
            [...new Set(errors.map((e) => e.status))],
            [404],
        );
        check(
            "(f) any caller told 'cache: leader run failed'?",
            errors.some((e) => e.message.includes('leader run failed')),
            false,
        );
        note(
            '(f) → the right ERROR, at the wrong PRICE',
            'no caller is ever handed a leader-failure artefact (good), and the cost is that a deterministic 404 is re-asked once per joiner (bad)',
        );
    }

    // ── (g) THE FOOTGUN: `ttl: 0` is "cache forever", not "do not cache" ───────────────────────
    // The natural spelling for "I want the dedupe, not the staleness" is `ttl: 0`. `memoryStore`
    // stores `expires: ttl ? now() + ttl : 0` and treats `expires === 0` as immortal (store.ts:15-16,
    // 45) — so the entry never expires and a LATER fan-out is served entirely from cache.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: ORDERS,
            customers: CUSTOMERS,
            holdMs: HOLD,
        });
        const fetchCustomer = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            cache: { ttl: 0 },
            clock,
        });
        const first = idsOf(vendor.orders).map((id) =>
            fetchCustomer({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        await Promise.all(first);
        const afterFirst = vendor.customerRequests;
        // A SECOND fan-out, long after the first settled. With a real TTL of zero this should
        // re-fetch everything.
        const second = idsOf(vendor.orders).map((id) =>
            fetchCustomer({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        await Promise.all(second);

        check('(g) requests in the first fan-out', afterFirst, 30);
        check(
            '(g) requests added by the SECOND fan-out',
            vendor.customerRequests - afterFirst,
            0,
        );
        note(
            '(g) → `ttl: 0` caches FOREVER',
            'store.ts:45 `ttl ? now() + ttl : 0`, store.ts:15-16 `expires === 0` is live — the entry has no expiry at all. There is no "coalesce only" spelling',
        );
        note(
            '(g) → and the store TTL runs on the WALL clock',
            '`memoryStore` calls `now()` (util.ts:4 = `Date.now()`), not the injected `clock`, so a `manualClock` cannot age a cache entry out',
        );
    }

    // ── (h) `sensitive: true` turns the whole thing off, coalescing included ───────────────────
    {
        const { vendor } = await fanOut({
            cache: { ttl: TTL },
            sensitive: true,
        });
        checkRequests(
            '(h) `cache` + `sensitive: true`',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        note(
            '(h) → `ensureCache` returns null when `cfg.sensitive` (engine.ts:1020)',
            'the config still READS as coalescing; the 3.33x quota bill comes back with no warning',
        );
    }

    // ── (i) the coalescing set is the CACHEABLE-METHOD set ─────────────────────────────────────
    // `methods` defaults to GET/HEAD (cache.ts:367-369) and coalescing applies to exactly that
    // set, so a POST-shaped lookup (a batch-ish `POST /customers/search`) coalesces nothing until
    // `methods` names it.
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: ORDERS,
            customers: CUSTOMERS,
            holdMs: HOLD,
        });
        const post = stitch<Customer>({
            name: 'customer-post',
            method: 'POST',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            cache: { ttl: TTL },
            clock,
        });
        const pending = idsOf(vendor.orders).map((id) =>
            post({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        await Promise.all(pending);
        checkRequests(
            '(i) a POST lookup with `cache: { ttl }`',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );

        const clock2 = manualClock();
        const vendor2 = new FakeVendor({
            clock: clock2,
            orders: ORDERS,
            customers: CUSTOMERS,
            holdMs: HOLD,
        });
        const postCached = stitch<Customer>({
            name: 'customer-post',
            method: 'POST',
            url: `${BASE}/customers/{id}`,
            adapter: vendor2.adapter(),
            cache: { ttl: TTL, methods: 'POST' },
            clock: clock2,
        });
        const pending2 = idsOf(vendor2.orders).map((id) =>
            postCached({ params: { id } }).safe(),
        );
        await runOut(clock2, 20_000, 1_000);
        await Promise.all(pending2);
        checkRequests(
            "(i) …the same POST with `methods: 'POST'`",
            vendor2.customerRequests,
            vendor2.distinctIds,
            30,
        );
    }

    finish(
        'C2',
        'YES — `cache.coalesce` GENUINELY COLLAPSES IN-FLIGHT DUPLICATES, and this is the strongest positive result in the pass. 100 concurrent calls over 30 distinct ids made 30 REQUESTS — one per id, exactly the floor — with every call in flight simultaneously and not one response yet landed, from a single `cache: { ttl }` block and no user code. `coalesce: false` on the same cache put it back to 100, so the saving is the coalescer and not the TTL. 70 of the 100 callers were served without a request of their own. `cluster` is accepted and silently degrades to `process` (cache.ts:396-397). THE OTHER DIRECTION IS AS IMPORTANT AND CUTS THE OTHER WAY: a coalesced FAILURE is not shared. 100 concurrent calls for one id that 404s made 100 requests in TWO WAVES — 1 leader, then 99 followers each re-running the whole chain independently (engine.ts:1646-1659) — so a failing id gets no dedupe at all and its retry storm is synchronised. Every joiner got its own honest `HTTP 404` (status 404, never a leader-failure artefact), which is the right ERROR at the wrong PRICE: the correct diagnosis is bought by asking the vendor 100 times for a resource that does not exist. TWO FOOTGUNS. `cache: { ttl: 0 }` is the obvious spelling for "dedupe but do not cache" and it caches FOREVER (store.ts:15-16,45 — `expires === 0` reads as live); a second fan-out much later added 0 requests. And `sensitive: true` silently disables the whole cache including coalescing (engine.ts:1020), taking the fan-out back to 100 requests with the config still reading as if it coalesces. Coalescing also applies only to the CACHEABLE METHOD set: a POST lookup coalesced nothing (100) until `methods: \'POST\'` was named (30)',
    );
}

void main();
