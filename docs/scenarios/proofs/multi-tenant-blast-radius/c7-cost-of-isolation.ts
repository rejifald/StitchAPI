// C7 — the cost of the correct construction. If isolation requires per-tenant seams/stitches,
// what does 100 tenants actually cost, what is shared vs duplicated, and is there a leak?
//
// THE CAPTURE'S COST MODEL IS WRONG. It calls "one client instance per tenant" correct-but-
// unscalable — "4,000 pools, timers and caches". Measured here: 100 per-tenant seams cost ~1ms and
// ~7kb each, arm ZERO timers, and hold ZERO connection pools, because a seam owns none of those
// things — the adapter (and its pool) is a config value that per-tenant seams SHARE. The expensive
// construction from the literature is not the expensive construction here.
//
// The real costs are three, and all three are leaks rather than footprint:
//
//   • Breaker records NEVER EXPIRE. `circuit.onSuccess`/`onFailure` write with no TTL
//     (resilience.ts:382-403), so one key per tenant lives forever — measured still present after a
//     virtual YEAR of the tenant not existing (d).
//   • A rate-paced limiter key is never dropped from its in-process map. `release` only deletes a
//     key with no window bookkeeping (store.ts:249-254), so a `rate` throttle retains one entry per
//     tenant key for the life of the process (e).
//   • `seam.stitch()` — the ROOT builder — retains every stitch it ever made in the seam's registry
//     (seam.ts:138-141). `seam.as(p).stitch()` does not. Measured with `WeakRef` after a forced GC:
//     200/200 root-created alive, 0/200 principal-created (f).
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c7-cost-of-isolation.ts
import { seam } from '../../../../packages/core/src/index';
import {
    THROTTLE_LOCAL,
    createStoreThrottle,
} from '../../../../packages/core/src/store';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { FakeVendor } from './fake-vendor';
import { check, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const N = 100;
const CIRCUIT = { failures: 5, cooldown: '30s' } as const;

// A real GC, without needing a CLI flag — the retention question in (f) is not answerable by
// heap-size guessing, and `WeakRef` only tells the truth after a collection.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** Collect, yielding to the macrotask queue between passes so finalizers actually run. */
async function collect(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        gc();
        await new Promise((r) => setTimeout(r, 5));
    }
}
const heapKb = (): number => Math.round(process.memoryUsage().heapUsed / 1024);

async function main(): Promise<void> {
    heading('C7 — what 100 isolated tenants cost, and what leaks');

    // ── (a) 100 per-tenant SEAMS ───────────────────────────────────────────────────────────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const adapter = vendor.adapter(); // ONE adapter — the connection pool is shared by config
        await collect();
        const before = heapKb();
        const t0 = Date.now();
        const seams = Array.from({ length: N }, () =>
            seam({
                baseUrl: 'https://api.vendor.test',
                adapter,
                store,
                clock,
                throttle: { rate: '10/s' },
                circuit: CIRCUIT,
            }),
        );
        const elapsed = Date.now() - t0;
        await collect();
        const perSeamKb = (heapKb() - before) / N;

        check('(a) seams constructed', seams.length, N);
        check('(a) construction under 200ms', elapsed < 200, true);
        check('(a) timers armed', clock.pending(), 0);
        check('(a) under 40kb per seam', perSeamKb < 40, true);
        note('(a) construction time (ms)', elapsed);
        note('(a) heap per seam (kb)', perSeamKb.toFixed(1));
        note(
            '(a) → a seam owns no transport',
            '`adapter` is a config value (types.ts) and the 100 seams here share ONE; the "4,000 connection pools" cost the literature warns about is not a cost this construction has',
        );
    }

    // ── (b) the alternative shape: 1 seam + 100 per-tenant KEYED stitches ──────────────────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        await collect();
        const before = heapKb();
        const t0 = Date.now();
        const calls = Array.from({ length: N }, (_, i) =>
            s.as(`t${i}`).stitch({
                name: `items:t${i}`,
                path: '/v1/items',
                headers: { 'x-tenant': `t${i}` },
                throttle: { rate: '10/s' },
                circuit: { ...CIRCUIT, key: `items:t${i}` },
            }),
        );
        const elapsed = Date.now() - t0;
        await collect();
        const perTenantKb = (heapKb() - before) / N;
        check('(b) stitches constructed', calls.length, N);
        check('(b) construction under 200ms', elapsed < 200, true);
        check('(b) timers armed', clock.pending(), 0);
        check('(b) under 40kb per tenant', perTenantKb < 40, true);
        note('(b) construction time (ms)', elapsed);
        note('(b) heap per tenant (kb)', perTenantKb.toFixed(1));
        note(
            '(b) → the two shapes cost the same order of magnitude',
            'so the choice between them is about which resource each one isolates (C2/C5), not about scale',
        );
    }

    // ── (c) what 100 isolated tenants put in the store ─────────────────────────────────────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        const inFlight = Array.from({ length: N }, (_, i) =>
            s
                .as(`t${i}`)
                .stitch({
                    name: `items:t${i}`,
                    path: '/v1/items',
                    headers: { 'x-tenant': `t${i}` },
                    throttle: { rate: '10/s' },
                    circuit: { ...CIRCUIT, key: `items:t${i}` },
                })({})
                .safe(),
        );
        await clock.advance(60_000);
        await Promise.all(inFlight);
        check(
            '(c) breaker keys after ONE call each',
            store.keys('circuit:').length,
            N,
        );
        check('(c) rate-counter keys', store.keys('rl:').length, N);
        check('(c) → store keys per tenant', store.keys().length / N, 2);
        note(
            "(c) → at 500 customers × 8 connections (the capture's number)",
            `that is ${(4000 * 2).toLocaleString('en-US')} keys in the shared store, of which half never expire — see (d)`,
        );
    }

    // ── (d) THE LEAK: breaker records have no TTL ───────────────────────────────────────────────
    // A customer churns out. Their per-tenant breaker key stays in Redis forever, because
    // `circuit.onSuccess`/`onFailure` call `store.set(key, record)` with no `ttl`
    // (resilience.ts:382-403), and the store treats a missing ttl as "live forever" (store.ts:45).
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        await s
            .as('churned')
            .stitch({
                path: '/v1/items',
                headers: { 'x-tenant': 'churned' },
                circuit: { ...CIRCUIT, key: 'items:churned' },
            })({})
            .safe();
        const born = store.live('circuit:').length;
        await clock.advance(365 * 24 * 60 * 60 * 1000); // a virtual year of not existing
        const stillThere =
            (await store.get('circuit:items:churned')) !== undefined;
        check('(d) breaker keys written', born, 1);
        check('(d) still resident after a virtual YEAR', stillThere, true);
        check('(d) live circuit keys', store.live('circuit:').length, 1);
        note(
            '(d) → the rate counter DOES expire (`rate.per + 100` ms, store.ts:203-206)',
            'the breaker record does not; a per-tenant breaker is one immortal key per tenant per endpoint, and nothing in the library sweeps them',
        );
    }

    // ── (e) …and the in-process limiter state for a rate-paced key is never dropped ────────────
    // Measured on the primitive directly, since the engine's instances are internal. `release`
    // deletes a key only when it carries no window bookkeeping (store.ts:249-254) — true for a
    // concurrency-only limiter, never for a rate-paced one.
    {
        const clock = manualClock();
        const store = probeStore();
        const paced = createStoreThrottle({ rate: '10/s' }, store, clock);
        const pacedLocal = (
            paced as unknown as Record<symbol, Map<string, unknown>>
        )[THROTTLE_LOCAL]!;
        for (let i = 0; i < N; i++) {
            await paced.acquire(`items:t${i}`);
            paced.release(`items:t${i}`);
        }
        check(
            '(e) rate-paced limiter: entries retained after release',
            pacedLocal.size,
            N,
        );

        const capped = createStoreThrottle({ concurrency: 2 }, store, clock);
        const cappedLocal = (
            capped as unknown as Record<symbol, Map<string, unknown>>
        )[THROTTLE_LOCAL]!;
        for (let i = 0; i < N; i++) {
            await capped.acquire(`items:t${i}`);
            capped.release(`items:t${i}`);
        }
        check(
            '(e) concurrency-only limiter: entries retained',
            cappedLocal.size,
            0,
        );
        note(
            '(e) → the retention is deliberate and documented (store.ts:243-254)',
            'dropping a rate-paced key mid-pace would reset its cursor and let the next acquire burst — but the consequence for a per-TENANT key is unbounded growth in a long-lived process',
        );
    }

    // ── (f) THE OTHER LEAK: `seam.stitch()` retains; `seam.as(p).stitch()` does not ────────────
    // The registry exists for lifecycle/introspection and is only populated by the ROOT builder
    // (seam.ts:136-141). Caching one ROOT-created stitch per tenant — the obvious optimisation —
    // pins every one of them for the life of the seam.
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        const M = 200;
        const rootRefs = Array.from(
            { length: M },
            (_, i) =>
                new WeakRef<Stitch>(
                    s.stitch({ name: `root:${i}`, path: '/v1/items' }),
                ),
        );
        const principalRefs = Array.from(
            { length: M },
            (_, i) =>
                new WeakRef<Stitch>(
                    s
                        .as(`t${i}`)
                        .stitch({ name: `principal:${i}`, path: '/v1/items' }),
                ),
        );
        await collect();
        const aliveRoot = rootRefs.filter(
            (r) => r.deref() !== undefined,
        ).length;
        const alivePrincipal = principalRefs.filter(
            (r) => r.deref() !== undefined,
        ).length;
        check('(f) root-created stitches still reachable', aliveRoot, M);
        check(
            '(f) principal-created stitches still reachable',
            alivePrincipal,
            0,
        );

        await s.close();
        await collect();
        check(
            '(f) root-created still reachable after `seam.close()`',
            rootRefs.filter((r) => r.deref() !== undefined).length,
            0,
        );
        note(
            '(f) → `runtime.register` is set only when `principal === undefined` (seam.ts:136-141)',
            'so the per-request shape (`seam.as(id).stitch(...)`) is the one that does NOT leak, and the only way to free a root registry is `close()`, which also closes the store',
        );
    }

    finish(
        'C7',
        "CHEAP IN FOOTPRINT, LEAKY IN STATE — and the capture's cost model does not apply. 100 per-tenant seams constructed in single-digit ms at well under 40kb each, arming ZERO timers, because a seam owns no transport: `adapter` is a config value and all 100 shared one, so the \"4,000 connection pools\" the literature warns about is not a cost this construction has. 1 seam + 100 per-tenant KEYED stitches measured the same order of magnitude, so the choice between the two shapes is about which resource each isolates (C2/C5), not about scale. The real price is THREE pieces of state that are never freed. (1) Breaker records have NO TTL (resilience.ts:382-403 writes with no `ttl`; store.ts:45 treats that as live-forever): a churned tenant's key was still resident after a virtual YEAR — at the capture's 4,000 connections that is 4,000 immortal keys, and nothing in the library sweeps them, while the rate counter beside it does expire. (2) A rate-paced limiter retains one in-process map entry per key for the life of the process — 100/100 after acquire+release, versus 0/100 for a concurrency-only limiter (store.ts:243-254). (3) `seam.stitch()` pins every stitch it creates in the seam registry: measured with WeakRef after a forced GC, 200/200 root-created still reachable versus 0/200 created through `seam.as(p).stitch()`, and the only release is `seam.close()` — which also closes the store. The per-request shape is the one that does not leak",
    );
}

void main();
