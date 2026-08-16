// C6 — is a 100-call fan-out ONE trace tree or a hundred unrelated roots? Does `linked` help when
// the members are created at runtime?
//
// A fan-out that shows up as 101 disconnected root spans is unreadable: you cannot ask "what did
// this order sync do", only "what did this one lookup do". The scenario's whole shape is `list →
// fan out → join`, and the trace should say so.
//
// MEASURED: a hundred roots by default, ONE tree with `linked` — and the shape `linked` draws is a
// 101-DEEP CHAIN, not a fan, which is a faithful record of nothing that happened.
//   (a) 100 bare calls after a list call → 101 distinct traceIds, 101 roots. Nothing relates them.
//   (b) `all()` → ONE traceId and a 100-wide fan. It is the right SHAPE and it is unusable here,
//       because the members share one input (C1).
//   (c) `linked` DOES take per-call input — `run(stitch, { params: { id } })` — so it is the only
//       construction that gives a runtime-length fan-out of DIFFERENT inputs one trace tree.
//       Measured: 1 traceId, 1 root, 101 spans.
//   (d) …and the shape is a CHAIN of depth 101, max fan-out 1, because `run` chains each call under
//       the PREVIOUS one (pipe.ts:360-367) whatever the concurrency. The calls really did run
//       concurrently (measured: peak 100 in flight) and the trace draws them as a queue.
//   (e) `linked` returns a `Promise`, not a `Composable` — confirming scenario 10 — so a fan-out
//       written this way cannot itself be a member of anything.
//   (f) Every span is named after the STITCH (`customer`, x100). The only per-call identity a sink
//       gets is the `url` on the `start` event (engine.ts:1071-1085); the `name` is useless here.
//
//   pnpm exec tsx docs/scenarios/proofs/n-plus-one-fanout/c6-trace.ts
import { stitch } from '../../../../packages/core/src/index';
import { all, linked } from '../../../../packages/core/src/pipe';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { type Customer, FakeVendor, type Order, idsOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { idFromUrl, recordingSink } from './trace-probe';
import { runOut } from './virtual-time';

const BASE = 'https://api.vendor.test';
const ORDERS = 100;
const HOLD = 50;

function context() {
    const clock = manualClock();
    const vendor = new FakeVendor({
        clock,
        orders: ORDERS,
        customers: ORDERS,
        holdMs: HOLD,
    });
    const trace = recordingSink();
    const adapter = vendor.adapter();
    const listOrders = stitch<{ data: Order[] }>({
        name: 'orders',
        url: `${BASE}/orders`,
        adapter,
        trace,
        clock,
    });
    const fetchCustomer = stitch<Customer>({
        name: 'customer',
        url: `${BASE}/customers/{id}`,
        adapter,
        trace,
        clock,
    });
    return { clock, vendor, trace, listOrders, fetchCustomer, adapter };
}

async function main(): Promise<void> {
    heading('C6 — the trace over `list -> fan out -> join`');

    // ── (a) the default: one root per call ─────────────────────────────────────────────────────
    {
        const { clock, trace, listOrders, fetchCustomer } = context();
        const listing = listOrders();
        await runOut(clock, 5_000, 1_000);
        const orders = (await listing).data;
        const pending = idsOf(orders).map((id) =>
            fetchCustomer({ params: { id } }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        await Promise.all(pending);

        check('(a) spans', trace.starts().length, 101);
        check('(a) DISTINCT trace trees', trace.traceIds().length, 101);
        check('(a) ROOT spans', trace.roots().length, 101);
        check('(a) max fan-out under any parent', trace.maxFanout(), 101);
        note(
            '(a) → every call mints its own root run',
            '`newRunContext()` with no parent (stitch.ts) — a fan-out is 101 unrelated traces, and nothing ties the lookups to the list that produced them',
        );
    }

    // ── (b) `all()` draws the right shape and cannot carry the inputs ──────────────────────────
    {
        const { clock, trace, fetchCustomer } = context();
        const members = Array.from({ length: ORDERS }, () => fetchCustomer);
        const pending = all(members as Stitch[])({
            params: { id: 'cust-001' },
        });
        await runOut(clock, 20_000, 1_000);
        await pending;

        check('(b) spans', trace.starts().length, 100);
        check('(b) DISTINCT trace trees', trace.traceIds().length, 1);
        check('(b) max fan-out under one parent', trace.maxFanout(), 100);
        check(
            '(b) DISTINCT ids in those 100 spans',
            new Set(trace.starts().map(idFromUrl)).size,
            1,
        );
        check('(b) ROOT spans among the members', trace.roots().length, 0);
        note(
            '(b) → the fan is real and the parent never emits',
            'the group run belongs to a `Composable`, which is not a stitch and produces no span; the 100 members all name a `parentSpanId` that appears nowhere in the trace',
        );
    }

    // ── (c) `linked` gives per-call input AND one tree ─────────────────────────────────────────
    // `ScopedRun` is `<O, I>(stitch: Stitch<O, I>, ...args)` (pipe.ts:355-361) — the stitch's OWN
    // input, per call. So this is the only construction that gets a runtime-length fan-out of
    // different inputs into a single trace.
    {
        const { clock, vendor, trace, listOrders, fetchCustomer } = context();
        const done = linked(async (run) => {
            const { data } = await run(listOrders);
            const rows = idsOf(data).map((id) =>
                run(fetchCustomer, { params: { id } }),
            );
            return Promise.all(rows);
        });
        await runOut(clock, 30_000, 1_000);
        const customers = await done;

        check('(c) rows joined', customers.length, 100);
        check('(c) spans', trace.starts().length, 101);
        check('(c) DISTINCT trace trees', trace.traceIds().length, 1);
        check('(c) ROOT spans', trace.roots().length, 1);
        check(
            '(c) DISTINCT ids in the customer spans',
            new Set(
                trace
                    .starts()
                    .filter((r) => r.name === 'customer')
                    .map(idFromUrl),
            ).size,
            100,
        );
        note(
            '(c) → one traceId over the list AND all 100 lookups',
            'the whole `list -> fan out -> join` is one queryable tree, with each lookup carrying its own id',
        );
        void vendor;
    }

    // ── (d) …and the shape it draws is a chain, not a fan ──────────────────────────────────────
    // `run` sets `prev` to the context it just minted (pipe.ts:362-367), so call i's parent is call
    // i-1 — whatever order they actually execute in. The calls here are all started before any is
    // awaited, so they genuinely ran concurrently.
    {
        const { clock, vendor, trace, listOrders, fetchCustomer } = context();
        const done = linked(async (run) => {
            const { data } = await run(listOrders);
            const rows = idsOf(data).map((id) =>
                run(fetchCustomer, { params: { id } }),
            );
            return Promise.all(rows);
        });
        await runOut(clock, 30_000, 1_000);
        await done;

        check('(d) max chain DEPTH', trace.maxDepth(), 101);
        check('(d) max FAN-OUT under any parent', trace.maxFanout(), 1);
        check(
            '(d) …while the calls really were concurrent: peak in-flight',
            vendor.peakInFlight,
            100,
        );
        note(
            '(d) → the trace says A->B->C->…, 101 deep',
            'a viewer renders 100 simultaneous lookups as a sequential queue; the depth is an artefact of CALL ORDER (pipe.ts:360-367), not of any dependency',
        );
    }

    // ── (e) `linked` is a Promise, not a Composable ────────────────────────────────────────────
    // Confirms scenario 10. It cannot be nested as a member, cannot be re-called, and cannot be
    // handed a different input later — it has already run by the time you hold it.
    {
        const { clock, listOrders } = context();
        const result = linked((run) => run(listOrders));
        await runOut(clock, 5_000, 1_000);
        await result;
        check('(e) `linked(...)` is thenable', typeof result.then, 'function');
        check(
            '(e) `linked(...)` carries the `__composable` brand?',
            (result as unknown as { __composable?: true }).__composable,
            undefined,
        );
        check(
            '(e) `linked(...)` is callable?',
            typeof (result as unknown),
            'object',
        );
    }

    // ── (f) what identifies a span ─────────────────────────────────────────────────────────────
    // One stitch called 100 times gives 100 spans with ONE name. `TraceContext.name` is therefore
    // no help; the `url` on the `start` event is the per-call identity, and it is only there
    // because the id is in the path.
    {
        const { clock, trace, fetchCustomer } = context();
        const pending = Array.from({ length: 5 }, (_, i) =>
            fetchCustomer({
                params: { id: `cust-00${String(i + 1)}` },
            }).safe(),
        );
        await runOut(clock, 20_000, 1_000);
        await Promise.all(pending);
        checkSeq(
            '(f) span NAMES',
            [...new Set(trace.starts().map((r) => r.name))],
            ['customer'],
        );
        checkSeq(
            '(f) ids recoverable from the start event url',
            trace.starts().map(idFromUrl),
            ['cust-001', 'cust-002', 'cust-003', 'cust-004', 'cust-005'],
        );
        note(
            '(f) → an id carried in a QUERY STRING or a BODY would also be on `start`',
            '`startEvt` stamps `url` and the full `input` (engine.ts:1071-1085), so the sink can always recover the discriminator — it is just never the span NAME',
        );
    }

    finish(
        'C6',
        'A HUNDRED ROOTS BY DEFAULT; ONE TREE WITH `linked`, WHICH THEN DRAWS THE WRONG SHAPE. A list call plus 100 bare lookups measured 101 spans in 101 DISTINCT TRACES, all roots — nothing relates a lookup to the list that produced its id. `all()` produces the right shape (1 trace, a 100-wide fan, 0 member roots) and cannot carry the scenario, because its members share one input: the 100 spans named ONE distinct id. `linked` IS the answer to the capture`s question, and the answer is yes with a caveat: `ScopedRun` takes the stitch`s OWN input per call (pipe.ts:355-361), so a runtime-length fan-out of DIFFERENT ids measured 1 traceId, 1 root and 101 spans covering the list and every lookup. THE CAVEAT IS THE SHAPE. `run` chains each call under the PREVIOUS one (pipe.ts:360-367), so the same run measured DEPTH 101 and MAX FAN-OUT 1 — a 101-deep chain — while the calls were genuinely concurrent (peak 100 in flight). A trace viewer renders 100 simultaneous lookups as a sequential queue, and the depth is an artefact of call order rather than of any dependency. Two riders. `linked(...)` is a `Promise`, not a `Composable` (no `__composable` brand), confirming scenario 10 — so a fan-out written this way cannot nest inside any combinator. And every span of a one-stitch fan-out carries the SAME name (`customer`, x100): the only per-call identity a sink gets is the `url`/`input` stamped on the `start` event (engine.ts:1071-1085)',
    );
}

void main();
