// C1 — can `all()` express a runtime-length list of DIFFERENT inputs?
//
// This is the shape the whole scenario is: `GET /orders` returns N rows, each needing its own
// `GET /customers/{id}`. N is not known until the first response lands, and every call needs a
// DIFFERENT id. The capture's hypothesis, inherited from scenario 7, is that `all()` structurally
// cannot do it because it broadcasts ONE `StitchInput` to every member (pipe.ts:75-86).
//
// MEASURED: the hypothesis holds, and the runtime length is not the reason.
//   (a) The RUNTIME LENGTH is fine. `all(ids.map(…))` compiles and runs — `membersFrom`
//       (pipe.ts:226-229) takes a plain array, and nothing anywhere wants a literal.
//   (b) THE INPUT IS THE WALL. 100 members, one input: 100 requests, ONE distinct id, 100 requests
//       for the SAME customer. `runMember` builds `{ ...input, signal }` once per member from the
//       one input the group was called with (pipe.ts:81).
//   (c) The workaround is N stitch objects with the id baked into the URL. It works — 100 distinct
//       ids — and it is the construction C3 measures the cost of.
//   (d) `all()` BOUNDS NOTHING: peak 100 in-flight over 100 members. Scenario 7 measured peak 8
//       over 8; at 100 the same non-bound is a different-sized problem.
//   (e) `all()` is FAIL-FAST and the successes are discarded: one 404 among 100 rejects the whole
//       group and hands back no data at all. There is deliberately no `allSettled` (pipe.ts:20-21).
//   (f) …and `.safe()` members cannot be composed in, because `Member` is gated on the `__stitch`
//       brand (pipe.ts:188-189) and `stitch.safe(input)` is a `Promise`, not a stitch.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c1-combinators.ts
import { stitch } from '../../../../packages/core/src/index';
import { all } from '../../../../packages/core/src/pipe';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { type Customer, FakeVendor, idsOf } from './fake-vendor';
import {
    check,
    checkPeak,
    checkRequests,
    checkSeq,
    finish,
    heading,
    note,
} from './harness';
import { accepted, probeSpellings, rejected } from './type-probe';
import { runOut } from './virtual-time';

const BASE = 'https://api.vendor.test';
const HOLD = 50;

/** The runtime context every measurement here is read off. */
function context(opts: { orders: number; customers: number }) {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: opts.orders,
        customers: opts.customers,
        holdMs: HOLD,
    });
    return { clock, vendor };
}

async function main(): Promise<void> {
    heading(
        'C1 — a runtime-length list of DIFFERENT inputs, through the combinators',
    );

    // ── (a) what the compiler admits ───────────────────────────────────────────────────────────
    // The runtime length is NOT the problem the capture expected it to be: `all` over a `.map()` is
    // a legal call. What does not exist is any spelling that varies the INPUT per member.
    {
        const results = probeSpellings([
            {
                label: 'all(ids.map(id => stitch(...)))  — runtime-length array of stitches',
                code: `void all(many);`,
            },
            {
                label: 'all(one, one, one)  — the bare-argument form',
                code: `void all(one, one, one);`,
            },
            {
                label: 'all(one, inputs)  — one stitch, a list of inputs',
                code: `void all(one, ids.map((id) => ({ params: { id } })));`,
            },
            {
                label: 'all.map(one, ids)  — a mapping combinator',
                code: `void all.map(one, ids);`,
            },
            {
                label: 'allSettled([...])  — a partial-failure combinator',
                code: `void allSettled(many);`,
            },
            {
                label: 'all(ids.map(id => () => one.safe({ params: { id } })))  — `.safe()` members',
                code: `void all(ids.map((id) => () => one.safe({ params: { id } })));`,
            },
            {
                label: 'all(many, { concurrency: 8 })  — a bound on the fan',
                code: `void all(many, { concurrency: 8 });`,
            },
        ]);
        checkSeq('(a) fan-out spellings that COMPILE', accepted(results), [
            'all(ids.map(id => stitch(...)))  — runtime-length array of stitches',
            'all(one, one, one)  — the bare-argument form',
        ]);
        check(
            '(a) spellings the compiler REFUSED',
            rejected(results).length,
            5,
        );
        note(
            '(a) → the runtime LENGTH is not the obstacle',
            '`membersFrom` (pipe.ts:226-229) reads a plain array; `all(ids.map(...))` compiles and runs. What is missing is per-member INPUT',
        );
    }

    // ── (b) THE WALL: one input, broadcast to every member ─────────────────────────────────────
    // The only way to give `all` a per-member id would be through the input, and there is one
    // input for the whole group. `runMember` (pipe.ts:75-86) spreads it into every member.
    {
        const { clock, vendor } = context({ orders: 100, customers: 100 });
        const fetchCustomer = stitch<Customer>({
            name: 'customer',
            url: `${BASE}/customers/{id}`,
            adapter: vendor.adapter(),
            clock,
        });
        // 100 members, built at runtime from the list — exactly the shape the scenario wants.
        const members = vendor.orders.map(() => fetchCustomer) as Stitch[];
        const group = all(members);
        const pending = group({ params: { id: 'cust-001' } });
        await runOut(clock, 5_000, 1_000);
        const values = (await pending) as unknown[];

        check('(b) members in the group', members.length, 100);
        check('(b) values returned', values.length, 100);
        checkRequests(
            '(b) 100 members, ONE input',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        check(
            '(b) DISTINCT ids that reached the server',
            vendor.distinctIds,
            1,
        );
        check('(b) requests for cust-001', vendor.requestsFor('cust-001'), 100);
        note(
            '(b) → 100 calls, one customer, 99 of them pure waste',
            '`runMember` builds `{ ...input, signal }` from the single group input (pipe.ts:81) — every member is handed the same `params`',
        );
    }

    // ── (c) the workaround: bake the id into N SEPARATE stitches ───────────────────────────────
    // This does express the scenario. The price is one `stitch()` object per row, which is the
    // construction whose resilience cost C3 measures.
    {
        const { clock, vendor } = context({ orders: 100, customers: 100 });
        const adapter = vendor.adapter();
        const members = idsOf(vendor.orders).map(
            (id) =>
                stitch<Customer>({
                    name: `customer:${id}`,
                    url: `${BASE}/customers/${id}`,
                    adapter,
                    clock,
                }) as Stitch,
        );
        const pending = all(members)();
        await runOut(clock, 5_000, 1_000);
        await pending;

        checkRequests(
            '(c) 100 stitches, id baked into each URL',
            vendor.customerRequests,
            vendor.distinctIds,
            100,
        );
        check(
            '(c) DISTINCT ids that reached the server',
            vendor.distinctIds,
            100,
        );
        note(
            '(c) → it works, and it costs 100 stitch objects',
            'each carries its own throttle/cache/circuit state — the trap C3 measures',
        );
    }

    // ── (d) `all()` bounds nothing, at 100 as at 8 ─────────────────────────────────────────────
    {
        const { clock, vendor } = context({ orders: 100, customers: 100 });
        const adapter = vendor.adapter();
        const members = idsOf(vendor.orders).map(
            (id) =>
                stitch<Customer>({
                    name: `customer:${id}`,
                    url: `${BASE}/customers/${id}`,
                    adapter,
                    clock,
                }) as Stitch,
        );
        const pending = all(members)();
        await runOut(clock, 5_000, 1_000);
        await pending;
        checkPeak(
            '(d) peak in-flight under `all()`',
            vendor.peakInFlight,
            undefined,
            100,
        );
        note(
            '(d) → scenario 7 measured peak 8 over 8 members',
            'the non-bound is the same; at 100 members it is a different-sized problem',
        );
    }

    // ── (e) fail-fast: one 404 discards 99 successes ───────────────────────────────────────────
    {
        const clock = manualClock();
        const vendor = new FakeVendor({
            clock,
            orders: 100,
            customers: 100,
            holdMs: HOLD,
            notFound: ['cust-050'], // one deleted customer among a hundred good ones
        });
        const adapter = vendor.adapter();
        const members = idsOf(vendor.orders).map(
            (id) =>
                stitch<Customer>({
                    name: `customer:${id}`,
                    url: `${BASE}/customers/${id}`,
                    adapter,
                    clock,
                }) as Stitch,
        );
        let failed = false;
        let message = '';
        let recovered: unknown = 'nothing';
        const pending = all(members)().then(
            (v) => {
                recovered = v;
            },
            (e: Error) => {
                failed = true;
                message = e.message;
            },
        );
        await runOut(clock, 5_000, 1_000);
        await pending;

        check('(e) the group REJECTED', failed, true);
        check('(e) the error message', message, 'HTTP 404');
        check(
            '(e) successes handed back to the caller',
            String(recovered),
            'nothing',
        );
        note(
            '(e) customers successfully fetched and then discarded',
            vendor.customerCalls.filter((c) => c.status === 200).length,
        );
        note(
            '(e) → `runAllArray` awaits `Promise.all` and rethrows (pipe.ts:133-137)',
            'there is deliberately no `allSettled` variant (pipe.ts:20-21)',
        );
    }

    // ── (f) …and you cannot hand `all` a `.safe()` member to get partial results ───────────────
    // The doc comment says "compose `.safe()` members by hand" (pipe.ts:21). `Member` is gated on
    // the `__stitch`/`__composable` BRAND (pipe.ts:188-189), and `stitch.safe(input)` returns a
    // `Promise<SafeResult>` — no brand. So the suggested composition is not a composition at all;
    // it is `Promise.allSettled` in user code, which is C4.
    {
        const results = probeSpellings([
            {
                label: 'all(one.safe, one.safe)',
                code: `void all(one.safe, one.safe);`,
            },
            {
                label: 'a plain async function as a member',
                code: `void all(async () => 1, async () => 2);`,
            },
        ]);
        check(
            '(f) `.safe()`-flavoured members that COMPILE',
            accepted(results).length,
            0,
        );
        checkSeq('(f) refused', rejected(results), [
            'all(one.safe, one.safe)',
            'a plain async function as a member',
        ]);
    }

    finish(
        'C1',
        'CONFIRMED, and the reason is narrower than the capture says. The RUNTIME LENGTH is not the obstacle: `all(ids.map(...))` compiles and runs, because `membersFrom` (pipe.ts:226-229) takes a plain array. THE INPUT IS. 100 members called with one input made 100 requests for ONE distinct id — 100 fetches of cust-001, 99 of them waste — because `runMember` spreads the single group input into every member (pipe.ts:75-86, `{ ...input, signal }`). Of seven candidate spellings only two compile (`all(array)` and `all(a, b, c)`); `all(one, inputs)`, `all.map`, `allSettled`, `.safe()` members and `all(members, { concurrency })` are all compile errors. The workaround — one `stitch()` per row with the id baked into the URL — does express it (measured: 100 distinct ids) and costs 100 stitch objects, which is the trap C3 measures. Two further non-bounds ride along: `all()` bounded nothing (peak 100 in-flight over 100 members, the same result scenario 7 got at 8), and it is FAIL-FAST — one 404 rejected the group with `HTTP 404` and handed back NOTHING, discarding 99 successful customer fetches. `Member` is brand-gated on `__stitch` (pipe.ts:188-189), so the doc\'s own suggestion to "compose `.safe()` members by hand" does not typecheck',
    );
}

void main();
