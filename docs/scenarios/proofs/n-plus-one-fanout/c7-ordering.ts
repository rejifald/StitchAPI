// C7 — does the result order match the input order under concurrency?
//
// The join at the end of a fan-out is `orders[i]` to `customers[i]`. If the result order followed
// COMPLETION order instead, every row would be attached to the wrong customer — the quietest
// possible data-corruption bug, because nothing errors and every field is populated.
//
// MEASURED: positional, always, and the one hazard is aliasing rather than ordering.
//   (a) With per-id latencies that scramble completion order completely (last id first), the
//       result array is still in INPUT order. `Promise.all` is positional; nothing in the library
//       changes that.
//   (b) Bounded concurrency does not perturb it either.
//   (c) Neither does coalescing, where 70 of 100 callers are resolved out of a shared promise.
//   (d) THE HAZARD IS ALIASING, NOT ORDER. Under coalescing the joiners are handed the LEADER'S
//       OBJECT — the same reference (engine.ts:1645,1662). 4 order rows sharing a customer got 4
//       references to ONE object, so mutating a joined row mutates the other three.
//   (e) The same is true of a CACHE HIT: the stored value is handed out by reference, so a mutation
//       persists into every later hit for the TTL.
//   (f) Without a cache each caller gets its own object, so the hazard appears exactly when you
//       turn on the optimisation C2 recommends.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c7-ordering.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { CacheOptions } from '../../../../packages/core/src/types';
import { type Customer, FakeVendor, idsOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { runOut } from './virtual-time';

const BASE = 'https://api.vendor.test';
const HOLD = 10;

/** Fire one lookup per order and return the results IN CALL ORDER, plus the vendor. */
async function fanOut(opts: {
    orders: number;
    customers: number;
    slow?: Record<string, number>;
    cache?: CacheOptions;
    concurrency?: number;
}) {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: opts.orders,
        customers: opts.customers,
        holdMs: HOLD,
        ...(opts.slow ? { slow: opts.slow } : {}),
    });
    const call = stitch<Customer>({
        name: 'customer',
        url: `${BASE}/customers/{id}`,
        adapter: vendor.adapter(),
        clock,
        ...(opts.cache ? { cache: opts.cache } : {}),
        ...(opts.concurrency
            ? { throttle: { concurrency: opts.concurrency } }
            : {}),
    });
    const ids = idsOf(vendor.orders);
    const pending = ids.map((id) => call({ params: { id } }).safe());
    await runOut(clock, 60_000, 1_000);
    const results = await Promise.all(pending);
    return { vendor, ids, results };
}

/** The id each positional result actually came back with — the join's correctness, as a list. */
const joinedIds = (
    results: readonly Awaited<ReturnType<typeof fanOut>>['results'][number][],
): string[] => results.map((r) => (r.ok ? r.data.id : '<failed>'));

async function main(): Promise<void> {
    heading(
        'C7 — 20 concurrent lookups whose completion order is deliberately reversed',
    );

    // ── (a) completion order reversed, result order intact ─────────────────────────────────────
    // Id N is held for (21-N)·100ms, so the LAST request completes FIRST and the first completes
    // last. If anything anywhere ordered by completion, this is where it would show.
    {
        const slow = Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [
                `cust-${String(i + 1).padStart(3, '0')}`,
                (20 - i) * 100,
            ]),
        );
        const { vendor, ids, results } = await fanOut({
            orders: 20,
            customers: 20,
            slow,
        });
        checkSeq(
            '(a) COMPLETION order at the server (first 4)',
            vendor.completions.slice(0, 4),
            ['cust-020', 'cust-019', 'cust-018', 'cust-017'],
        );
        checkSeq(
            '(a) RESULT order handed to the caller (first 4)',
            joinedIds(results).slice(0, 4),
            ['cust-001', 'cust-002', 'cust-003', 'cust-004'],
        );
        checkSeq('(a) result order === input order', joinedIds(results), ids);
        check(
            '(a) …and it is the exact REVERSE of completion order',
            JSON.stringify([...vendor.completions].reverse()) ===
                JSON.stringify(ids),
            true,
        );
    }

    // ── (b) bounded concurrency does not perturb it ────────────────────────────────────────────
    {
        const slow = Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [
                `cust-${String(i + 1).padStart(3, '0')}`,
                (20 - i) * 100,
            ]),
        );
        const { ids, results } = await fanOut({
            orders: 20,
            customers: 20,
            slow,
            concurrency: 4,
        });
        checkSeq('(b) with `concurrency: 4`', joinedIds(results), ids);
    }

    // ── (c) coalescing does not perturb it ─────────────────────────────────────────────────────
    // 20 orders over 5 customers: 15 of the 20 results come out of a shared promise rather than
    // their own response, and the array is still positional.
    {
        const { ids, results } = await fanOut({
            orders: 20,
            customers: 5,
            cache: { ttl: '60s' },
        });
        checkSeq('(c) with coalescing', joinedIds(results), ids);
        checkSeq(
            '(c) …which is 4 repeats of 5 ids',
            joinedIds(results).slice(0, 6),
            [
                'cust-001',
                'cust-002',
                'cust-003',
                'cust-004',
                'cust-005',
                'cust-001',
            ],
        );
    }

    // ── (d) THE HAZARD: coalesced callers share ONE object ─────────────────────────────────────
    // `claim.settle({ data: out.value, … })` hands every follower the leader's value by reference
    // (engine.ts:1645) and `resultEvt(shared.data, …)` passes it straight through (engine.ts:1662).
    {
        const { results } = await fanOut({
            orders: 20,
            customers: 5,
            cache: { ttl: '60s' },
        });
        const rows = results.flatMap((r) => (r.ok ? [r.data] : []));
        const a = rows[0];
        const b = rows[5]; // the next order for the same customer
        check('(d) same customer id', a?.id === b?.id, true);
        check('(d) SAME OBJECT REFERENCE', a === b, true);
        if (a) a.tier = 'mutated-by-row-0';
        check(
            '(d) …so mutating row 0 changed row 5',
            b?.tier,
            'mutated-by-row-0',
        );
        const distinct = new Set(rows).size;
        check('(d) distinct customer OBJECTS across 20 rows', distinct, 5);
        note(
            '(d) → the aliasing arrives WITH the optimisation',
            'a per-row `transform`, a normalise step, or anything that writes onto the joined customer now writes onto every row that shares it',
        );
    }

    // ── (e) a cache HIT aliases too, and for the whole TTL ─────────────────────────────────────
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: 4,
            customers: 1,
            holdMs: HOLD,
        });
        const call = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            cache: { ttl: '60s' },
            clock,
        });
        const one = call({ params: { id: 'cust-001' } }).safe();
        await runOut(clock, 10_000, 1_000);
        const first = await one;
        if (first.ok) first.data.tier = 'mutated-before-the-hit';
        const two = call({ params: { id: 'cust-001' } }).safe();
        await runOut(clock, 10_000, 1_000);
        const second = await two;

        check('(e) requests made', vendor.customerRequests, 1);
        check(
            '(e) the SECOND call was served the mutated object',
            second.ok ? second.data.tier : '<failed>',
            'mutated-before-the-hit',
        );
        check(
            '(e) same reference across the cache hit',
            first.ok && second.ok && first.data === second.data,
            true,
        );
    }

    // ── (f) with no cache, every caller gets its own object ────────────────────────────────────
    {
        const { results } = await fanOut({ orders: 20, customers: 5 });
        const rows = results.flatMap((r) => (r.ok ? [r.data] : []));
        check(
            '(f) distinct customer OBJECTS across 20 rows',
            new Set(rows).size,
            20,
        );
        check(
            '(f) rows 0 and 5 share an id',
            rows[0]?.id === rows[5]?.id,
            true,
        );
        check('(f) …and are DIFFERENT objects', rows[0] === rows[5], false);
    }

    finish(
        'C7',
        'ORDER IS POSITIONAL AND SAFE; THE REAL HAZARD IS ALIASING. With per-id latencies chosen so the LAST request completes FIRST — a completion order that is the exact reverse of the call order — the result array came back in INPUT order, so `orders[i]` joins to `results[i]` with no correlation key. That held under bounded concurrency and under coalescing, where 15 of 20 results are resolved out of a shared promise rather than their own response. THE FINDING IS ELSEWHERE: under coalescing every joiner is handed the LEADER`S OBJECT BY REFERENCE (`claim.settle({ data: out.value })` at engine.ts:1645, passed through at engine.ts:1662). 20 rows over 5 customers measured 5 DISTINCT OBJECTS — mutating the customer on row 0 changed row 5 — where the same fan-out with no cache measured 20 distinct objects. A cache HIT aliases the same way and for the whole TTL: a value mutated after the first call was handed unchanged to the second. So the aliasing appears exactly when you turn on the optimisation C2 recommends, and any normalise/enrich step that writes onto a joined customer will silently write onto every row sharing it',
    );
}

void main();
