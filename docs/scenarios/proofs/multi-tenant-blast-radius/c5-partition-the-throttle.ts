// C5 — DECIDING. Can the throttle be partitioned per tenant AT ALL? `ThrottleOptions.pool` is
// `'stitch' | 'host'` (types.ts:1039) — no `'principal'`. Try `seam.as()`, a per-tenant seam, a
// per-tenant stitch, `key`.
//
// THE CAPTURE'S HYPOTHESIS IS WRONG IN THE OPTIMISTIC DIRECTION. It says "the rate bucket looks
// un-partitionable by tenant", and it is partitionable — twice over. What is missing is only the
// DECLARATION: there is no `pool: 'principal'` and no `throttle.key` (a), so the partition has to
// be smuggled in through the limiter key, which the engine derives from the stitch's NAME
// (engine.ts:265-274) or, on a seam, from the SEAM ID (seam.ts:59). Both work, both measured at
// t=0 for the quiet tenant.
//
// And the asymmetry in (f) is the thing to put in the docs: a per-tenant SEAM isolates the rate
// bucket and NOT the breaker, while a per-tenant NAME isolates the breaker and only isolates the
// rate bucket if the throttle is declared on the MEMBER. The two resources are keyed by different
// rules, so one construction cannot be reasoned about — each has to be checked.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c5-partition-the-throttle.ts
import { seam } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { FakeVendor, blastRadius, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';
import { accepted, probeSpellings, rejected } from './type-probe';

const NOISY = 'noisy';
const QUIET = 'quiet';
const BURST = 20;
const RATE = '10/s';

/**
 * Fire `BURST` calls for the noisy tenant and ONE for the quiet tenant in the same tick, through
 * whatever per-tenant construction `build` returns, then run the clock out. The quiet tenant's
 * arrival time is the answer: 0 = isolated, 2000 = sharing one budget.
 */
async function race(
    build: (ctx: ReturnType<typeof context>) => (tenant: string) => Stitch,
) {
    const ctx = context();
    const call = build(ctx);
    const inFlight = [
        ...Array.from({ length: BURST }, () => call(NOISY)({}).safe()),
        call(QUIET)({}).safe(),
    ];
    await ctx.clock.advance(120_000);
    await Promise.all(inFlight);
    return ctx;
}

function context() {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({ clock });
    return { clock, store, vendor };
}

async function main(): Promise<void> {
    heading('C5 — partitioning the rate budget per tenant');

    // ── (a) what the compiler admits in the `throttle` envelope ────────────────────────────────
    {
        const results = probeSpellings([
            {
                label: "pool: 'stitch'",
                code: `stitch({ url: 'https://x.test/y', throttle: { rate: '10/s', pool: 'stitch' } });`,
            },
            {
                label: "pool: 'host'",
                code: `stitch({ url: 'https://x.test/y', throttle: { rate: '10/s', pool: 'host' } });`,
            },
            {
                label: "pool: 'principal'",
                code: `stitch({ url: 'https://x.test/y', throttle: { rate: '10/s', pool: 'principal' } });`,
            },
            {
                label: 'throttle.key',
                code: `stitch({ url: 'https://x.test/y', throttle: { rate: '10/s', key: tenantId } });`,
            },
            {
                label: "throttle.tenancy: 'principal'",
                code: `stitch({ url: 'https://x.test/y', throttle: { rate: '10/s', tenancy: 'principal' } });`,
            },
            {
                label: "seam-level pool: 'principal'",
                code: `seam({ baseUrl: 'https://x.test', throttle: { rate: '10/s', pool: 'principal' } });`,
            },
        ]);
        checkSeq('(a) throttle spellings that COMPILE', accepted(results), [
            "pool: 'stitch'",
            "pool: 'host'",
        ]);
        check(
            '(a) spellings the compiler REFUSED',
            rejected(results).length,
            4,
        );
        note(
            '(a) → the declaration genuinely does not exist',
            "`ThrottleOptions` is `{ rate?, concurrency?, pool?: 'stitch' | 'host', delegate?, on? }` (types.ts:1005-1049) — no `key`, no `tenancy`, no `'principal'` pool",
        );
    }

    // ── (b) the baseline this claim is measured against ────────────────────────────────────────
    {
        const { vendor, store } = await race((ctx) => {
            const s = seam({
                baseUrl: 'https://api.vendor.test',
                adapter: ctx.vendor.adapter(),
                store: ctx.store,
                clock: ctx.clock,
                throttle: { rate: RATE },
            });
            return (t) =>
                s
                    .as(t)
                    .stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        });
        checkSeq(
            '(b) shared seam + `.as()` — quiet arrival',
            vendor.arrivals(QUIET),
            [2000],
        );
        check('(b) distinct rate keys', store.keys('rl:').length, 1);
    }

    // ── (c) a per-tenant SEAM isolates the budget ──────────────────────────────────────────────
    // Even sharing one store: the bucket key carries the seam id (seam.ts:59), and each `seam()`
    // call mints a fresh one.
    {
        const { vendor, store } = await race((ctx) => {
            const seams = new Map<string, ReturnType<typeof seam>>();
            return (t) => {
                let sm = seams.get(t);
                if (!sm) {
                    sm = seam({
                        baseUrl: 'https://api.vendor.test',
                        adapter: ctx.vendor.adapter(),
                        store: ctx.store, // ONE shared store
                        clock: ctx.clock,
                        throttle: { rate: RATE },
                    });
                    seams.set(t, sm);
                }
                return sm
                    .as(t)
                    .stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
            };
        });
        checkSeq(
            '(c) per-tenant SEAM — quiet arrival',
            vendor.arrivals(QUIET),
            [0],
        );
        check('(c) distinct rate keys', store.keys('rl:').length, 2);
        note(
            '(c) → the partition is the SEAM ID, not the principal',
            '`seamBucket` keys on `seam:${seamId}` (seam.ts:51-69); two seams are two budgets even over one store',
        );
    }

    // ── (d) a per-tenant NAME + a MEMBER throttle isolates it too ──────────────────────────────
    // No seam-level throttle here: the member's own throttle is keyed by the engine's `hostKey`,
    // which falls back to `cfg.name` (engine.ts:140,273,614).
    {
        const { vendor, store } = await race((ctx) => {
            const s = seam({
                baseUrl: 'https://api.vendor.test',
                adapter: ctx.vendor.adapter(),
                store: ctx.store,
                clock: ctx.clock,
            });
            const made = new Map<string, Stitch>();
            return (t) => {
                let st = made.get(t);
                if (!st) {
                    st = s.as(t).stitch({
                        name: `items:${t}`,
                        path: '/v1/items',
                        headers: { 'x-tenant': t },
                        throttle: { rate: RATE },
                    });
                    made.set(t, st);
                }
                return st;
            };
        });
        checkSeq(
            '(d) per-tenant NAME + member throttle — quiet arrival',
            vendor.arrivals(QUIET),
            [0],
        );
        checkSeq('(d) rate keys', store.keys('rl:'), [
            `rl:items:${NOISY}:0`,
            `rl:items:${QUIET}:0`,
        ]);
    }

    // ── (e) THE TRAP: a per-tenant member throttle with the SAME name shares one counter ───────
    // 2 stitch objects, 2 in-process limiters — and one budget, because the counter lives in the
    // seam's shared store under the config-derived key. This is the construction that looks
    // isolated and is not.
    {
        const { vendor, store } = await race((ctx) => {
            const s = seam({
                baseUrl: 'https://api.vendor.test',
                adapter: ctx.vendor.adapter(),
                store: ctx.store,
                clock: ctx.clock,
            });
            const made = new Map<string, Stitch>();
            return (t) => {
                let st = made.get(t);
                if (!st) {
                    st = s.as(t).stitch({
                        path: '/v1/items', // no per-tenant name
                        headers: { 'x-tenant': t },
                        throttle: { rate: RATE },
                    });
                    made.set(t, st);
                }
                return st;
            };
        });
        checkSeq(
            '(e) same path, per-tenant member throttle — quiet arrival',
            vendor.arrivals(QUIET),
            [2000],
        );
        checkSeq('(e) rate keys', store.keys('rl:'), ['rl:/v1/items:0']);
        note(
            '(e) → each stitch got its OWN `createStoreThrottle` (seam.ts:97-103)',
            'and they all `increment` the same `rl:<name>:<window>` counter (store.ts:203-206), so the per-process objects are decoration',
        );
    }

    // ── (f) THE ASYMMETRY: the same construction isolates one resource and not the other ───────
    // One run, both resources measured. A per-tenant seam sharing a store: rate ISOLATED (the seam
    // id is in the key), breaker SHARED (it is not).
    {
        const ctx = context();
        ctx.vendor.fail('broken', 401);
        const seams = new Map<string, ReturnType<typeof seam>>();
        const call = (t: string) => {
            let sm = seams.get(t);
            if (!sm) {
                sm = seam({
                    baseUrl: 'https://api.vendor.test',
                    adapter: ctx.vendor.adapter(),
                    store: ctx.store,
                    clock: ctx.clock,
                    throttle: { rate: RATE },
                    circuit: { failures: 3, cooldown: '30s' },
                });
                seams.set(t, sm);
            }
            return sm
                .as(t)
                .stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        };
        // rate: the noisy burst against a quiet tenant.
        const inFlight = [
            ...Array.from({ length: BURST }, () => call(NOISY)({}).safe()),
            call(QUIET)({}).safe(),
        ];
        await ctx.clock.advance(120_000);
        await Promise.all(inFlight);
        // breaker: the broken tenant, then three healthy ones.
        for (let i = 0; i < 3; i++) {
            const p = outcomeOf(() => call('broken')({}));
            await ctx.clock.advance(1000);
            await p;
        }
        const healthy: string[] = [];
        for (const t of ['h1', 'h2', 'h3']) {
            const p = outcomeOf(() => call(t)({}));
            await ctx.clock.advance(1000);
            healthy.push(await p);
        }
        check(
            '(f) rate keys (one per seam) → ISOLATED',
            ctx.store.keys('rl:').length >= 2,
            true,
        );
        checkSeq(
            '(f) quiet tenant arrival → ISOLATED',
            ctx.vendor.arrivals(QUIET),
            [0],
        );
        checkSeq('(f) breaker keys → SHARED', ctx.store.keys('circuit:'), [
            'circuit:/v1/items',
        ]);
        check('(f) → healthy tenants that FAILED', blastRadius(healthy), 3);
        note(
            '(f) → one construction, two answers',
            'per-tenant seams isolate the rate budget (`seam:sN`) and NOT the breaker (`cfg.name ?? cfg.path`); nothing in the config surface says so',
        );
    }

    // ── (g) `pool: 'host'` collapses every partition, INCLUDING the breaker ────────────────────
    // The one declared pooling knob widens rather than narrows — and it silently re-keys the
    // circuit too, because `hostKey` reads `cfg.throttle?.pool` (engine.ts:265-274) and the circuit
    // uses `hostKey` as its fallback key (engine.ts:860).
    {
        const { vendor, store } = await race((ctx) => {
            const seams = new Map<string, ReturnType<typeof seam>>();
            return (t) => {
                let sm = seams.get(t);
                if (!sm) {
                    sm = seam({
                        baseUrl: 'https://api.vendor.test',
                        adapter: ctx.vendor.adapter(),
                        store: ctx.store,
                        clock: ctx.clock,
                        throttle: { rate: RATE, pool: 'host' },
                    });
                    seams.set(t, sm);
                }
                return sm.as(t).stitch({
                    name: `items:${t}`, // a per-tenant name, which now buys nothing
                    path: '/v1/items',
                    headers: { 'x-tenant': t },
                });
            };
        });
        checkSeq(
            "(g) `pool: 'host'` over per-tenant seams AND names — quiet arrival",
            vendor.arrivals(QUIET),
            [2000],
        );
        checkSeq('(g) rate keys', store.keys('rl:'), ['rl:api.vendor.test:0']);

        // …and the breaker moves with it.
        const ctx = context();
        ctx.vendor.fail('broken', 500);
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: ctx.vendor.adapter(),
            store: ctx.store,
            clock: ctx.clock,
            circuit: { failures: 3, cooldown: '30s' },
            throttle: { pool: 'host' }, // pooling declared for the RATE
        });
        const broken = s.as('broken').stitch({
            name: 'items:broken',
            path: '/v1/items',
            headers: { 'x-tenant': 'broken' },
        });
        const unrelated = s.as('other').stitch({
            name: 'orders:other', // a different endpoint AND a different tenant
            path: '/v1/orders',
            headers: { 'x-tenant': 'other' },
        });
        for (let i = 0; i < 3; i++) await outcomeOf(() => broken({}));
        checkSeq(
            '(g) breaker keys under `pool: host`',
            ctx.store.keys('circuit:'),
            ['circuit:api.vendor.test'],
        );
        check(
            '(g) → an unrelated endpoint for an unrelated tenant',
            await outcomeOf(() => unrelated({})),
            '503',
        );
        note(
            '(g) → `throttle.pool` silently re-keys the CIRCUIT',
            '`hostKey` reads `cfg.throttle?.pool === "host"` (engine.ts:265-274) and is the circuit\'s fallback key (engine.ts:860); a per-tenant `name` partition evaporates when someone tunes the rate pool',
        );
    }

    // ── (h) the seam id is a creation-ORDER counter, which does not survive two processes ──────
    // `seam:s1` in worker A and `seam:s1` in worker B are the same key in a shared Redis. The ids
    // are handed out by construction order (seam.ts:38,233), which is tenant order only by
    // accident, so per-tenant seams over a shared store cross-pollinate across the fleet.
    {
        const ctx = context();
        const order = ['zulu', 'alpha', 'mike'];
        for (const t of order) {
            const sm = seam({
                baseUrl: 'https://api.vendor.test',
                adapter: ctx.vendor.adapter(),
                store: ctx.store,
                clock: ctx.clock,
                throttle: { rate: RATE },
            });
            const p = sm
                .as(t)
                .stitch({ path: '/v1/items', headers: { 'x-tenant': t } })({})
                .safe();
            await ctx.clock.advance(1000);
            await p;
        }
        const ids = ctx.store
            .keys('rl:seam:')
            .map((k) => k.split(':')[2] ?? '')
            .map((s) => Number(s.slice(1)));
        check('(h) seams created', ids.length, 3);
        check(
            '(h) their ids are consecutive (creation order, not tenant)',
            ids[1] === ids[0]! + 1 && ids[2] === ids[1]! + 1,
            true,
        );
        check(
            '(h) does any id derive from the tenant name?',
            ctx.store
                .keys('rl:seam:')
                .some((k) => order.some((t) => k.includes(t))),
            false,
        );
        note(
            '(h) → `seamCounter` is a module-level counter (seam.ts:38,233)',
            "two processes each hand out s1, s2, s3 — so over a SHARED store, worker A's tenant-1 seam and worker B's tenant-7 seam are the same rate bucket",
        );
    }

    finish(
        'C5',
        'YES — the capture is wrong in the optimistic direction. What is missing is the DECLARATION, not the capability: of six candidate spellings typechecked, only `pool: "stitch"` and `pool: "host"` compile — `pool: "principal"`, `throttle.key` and `throttle.tenancy` are compile errors (types.ts:1005-1049). But the budget IS partitionable, two ways, both measured with the quiet tenant leaving at t=0 instead of t=2000: a per-tenant SEAM (the bucket key carries the seam id, `rl:seam:sN`, seam.ts:51-69 — and it holds even over ONE shared store), or a per-tenant `name` plus a MEMBER-level throttle (`rl:items:<tenant>`, engine.ts:140,273,614). TWO TRAPS. Per-tenant member throttles with the SAME name are 2 limiter objects over ONE store counter (`rl:/v1/items:0`, quiet at t=2000): the objects are decoration. And `pool: "host"` collapses every partition, per-tenant seams and per-tenant names alike, back to `rl:api.vendor.test` — while ALSO silently re-keying the CIRCUIT onto `circuit:api.vendor.test` (engine.ts:265-274,860), where an unrelated endpoint for an unrelated tenant measured 503. THE ASYMMETRY IS THE HEADLINE: in one run, per-tenant seams over a shared store isolated the rate budget (quiet at t=0) and SHARED the breaker (one key, 3 of 3 healthy tenants down). The two resources are keyed by different rules and neither construction can be reasoned about as a whole. Finally, seam ids are a creation-ORDER counter (measured consecutive, with no tenant derivation), so per-tenant seams over a shared durable store collide across processes',
    );
}

void main();
