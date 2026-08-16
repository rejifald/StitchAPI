// C2 — can the breaker be partitioned per tenant? Is `circuit.key` (types.ts:1088) static config,
// or can it vary per call? Does a bound principal influence it at all?
//
// The answers, all measured: `circuit.key` is a static `string` and nothing principal-derived
// compiles (a); the bound principal changes nothing (b); and partitioning DOES work — but only via
// the key STRING, either an explicit `circuit.key` (c) or a per-tenant `name` (d).
//
// THE CAPTURE'S WORKAROUND IS WRONG, and this is the most important thing in the file. It says "if
// [`key`] is static config, per-tenant breakers mean one stitch per tenant". One stitch per tenant
// does NOT partition the breaker: the state lives in the SEAM'S SHARED STORE under a key derived
// from the config, so 100 per-tenant stitch objects that resolve to the same `name`/`path` share
// one breaker — measured in (e). A per-tenant SEAM over a shared store doesn't do it either (f),
// and per-tenant `stitch()`es with a `url` and no `name` all collapse onto the literal key
// `circuit:stitch` (g). Isolation is a property of the key string, never of the object graph.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c2-partition-the-breaker.ts
import { seam, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { FakeVendor, blastRadius, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';
import { accepted, probeSpellings, rejected } from './type-probe';

const HEALTHY = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
const BAD = 'bad';
const CIRCUIT = { failures: 3, cooldown: '30s' } as const;

/** Drive one tenant past the threshold, then call every healthy tenant once. */
async function blast(
    call: (tenant: string) => Stitch,
): Promise<{ bad: string[]; healthy: string[] }> {
    const bad: string[] = [];
    for (let i = 0; i < 3; i++) bad.push(await outcomeOf(() => call(BAD)({})));
    const healthy: string[] = [];
    for (const t of HEALTHY) healthy.push(await outcomeOf(() => call(t)({})));
    return { bad, healthy };
}

async function main(): Promise<void> {
    heading('C2 — partitioning the breaker per tenant');

    // ── (a) what the compiler admits in the `circuit` envelope ─────────────────────────────────
    // Not a grep: each candidate is typechecked as a statement. A line that compiles is a spelling
    // that exists.
    {
        const results = probeSpellings([
            {
                label: 'circuit.key as a static string',
                code: `stitch({ url: 'https://x.test/y', circuit: { failures: 3, cooldown: '30s', key: tenantId } });`,
            },
            {
                label: 'circuit.key as a per-call function',
                code: `stitch({ url: 'https://x.test/y', circuit: { failures: 3, cooldown: '30s', key: () => tenantId } });`,
            },
            {
                label: 'circuit.keyOf (the P6 derivation spelling)',
                code: `stitch({ url: 'https://x.test/y', circuit: { failures: 3, cooldown: '30s', keyOf: () => tenantId } });`,
            },
            {
                label: "circuit.tenancy: 'principal'",
                code: `stitch({ url: 'https://x.test/y', circuit: { failures: 3, cooldown: '30s', tenancy: 'principal' } });`,
            },
        ]);
        checkSeq('(a) spellings that COMPILE', accepted(results), [
            'circuit.key as a static string',
        ]);
        check(
            '(a) spellings the compiler REFUSED',
            rejected(results).length,
            3,
        );
        note(
            '(a) → `CircuitOptions` is `{ failures?, cooldown?, key? }` with `key?: string` (types.ts:1072-1089)',
            'no derivation fn, no `tenancy`; the rejections are real compile errors from `NoUnknownNestedKeys` (types.ts:411-448), not silent no-ops',
        );
    }

    // ── (b) does `seam.as(principal)` influence the circuit key? ───────────────────────────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
        });
        await s.stitch({ path: '/v1/items' })({}).safe(); // root, no principal
        await s.as('t1').stitch({ path: '/v1/items' })({}).safe();
        await s.as('t2').stitch({ path: '/v1/items' })({}).safe();
        checkSeq(
            '(b) circuit keys for root + 2 principals',
            store.keys('circuit:'),
            ['circuit:/v1/items'],
        );
        note(
            '(b) → the principal reaches `AuthContext` and stops there',
            '`Runtime.principal` is threaded into `authCtx` (engine.ts:101-102) and read by `oauth2`/`cookieSession`/`cache`; `attemptWithCircuit` never sees it (engine.ts:846-893)',
        );
    }

    // ── (c) an explicit per-tenant `circuit.key` — this works ──────────────────────────────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock, failing: { [BAD]: 401 } });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
        });
        const call = (t: string) =>
            s.as(t).stitch({
                path: '/v1/items',
                headers: { 'x-tenant': t },
                circuit: { ...CIRCUIT, key: `items:${t}` },
            });
        const { bad, healthy } = await blast(call);
        checkSeq('(c) the bad tenant', bad, ['401', '401', '401']);
        check('(c) → healthy tenants that FAILED', blastRadius(healthy), 0);
        check('(c) distinct breaker keys', store.keys('circuit:').length, 10);
        check(
            '(c) the bad tenant has its own breaker',
            store.keys('circuit:').includes(`circuit:items:${BAD}`),
            true,
        );
        // …and it is genuinely OPEN for that tenant, which is the point of partitioning.
        check(
            '(c) the bad tenant now fast-fails',
            await outcomeOf(() => call(BAD)({})),
            '503',
        );
        note(
            '(c) → `circuit.key` IS the partition knob',
            'it is read once per call at `createCircuit(cfg.circuit, …)` (engine.ts:857-862), so a per-tenant stitch carrying a per-tenant key gives a per-tenant breaker',
        );
    }

    // ── (d) a per-tenant `name` does the same thing, implicitly ────────────────────────────────
    // `hostKey` falls back to `cfg.name ?? cfg.path` (engine.ts:140,273), so naming the stitch per
    // tenant partitions the breaker without touching `circuit` at all. Convenient, and a trap in
    // both directions — see (e).
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock, failing: { [BAD]: 401 } });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
        });
        const call = (t: string) =>
            s.as(t).stitch({
                name: `items:${t}`,
                path: '/v1/items',
                headers: { 'x-tenant': t },
            });
        const { healthy } = await blast(call);
        check('(d) healthy tenants that FAILED', blastRadius(healthy), 0);
        check('(d) distinct breaker keys', store.keys('circuit:').length, 10);
        note(
            '(d) → the partition is the NAME, which is also a trace/diagnostic label',
            'one string is doing two jobs; renaming a stitch for readability silently re-partitions its breaker',
        );
    }

    // ── (e) THE TRAP: one stitch per tenant does NOT partition ─────────────────────────────────
    // The capture's proposed workaround. 10 distinct `Stitch` objects, each bound to its own
    // principal, cached for the life of the process — and one breaker, because the KEY is the same.
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock, failing: { [BAD]: 401 } });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
        });
        const perTenant = new Map<string, Stitch>();
        const call = (t: string) => {
            let st = perTenant.get(t);
            if (!st) {
                st = s.as(t).stitch({
                    path: '/v1/items',
                    headers: { 'x-tenant': t },
                });
                perTenant.set(t, st);
            }
            return st;
        };
        const { healthy } = await blast(call);
        check('(e) distinct Stitch objects constructed', perTenant.size, 10);
        check('(e) distinct breaker keys', store.keys('circuit:').length, 1);
        check('(e) → healthy tenants that FAILED', blastRadius(healthy), 9);
        note(
            '(e) → "one stitch per tenant" is NOT the fix the capture assumes',
            "breaker state lives in the seam's SHARED store at `circuit:<key>` (resilience.ts:353); 10 objects resolving to the same `path` are 10 handles on one record",
        );
    }

    // ── (f) …and neither is one SEAM per tenant, if they share a store ─────────────────────────
    // The construction that looks most isolated of all — a whole seam per customer — and the
    // breaker is still shared, because a seam's identity is not in the circuit key.
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock, failing: { [BAD]: 401 } });
        const seams = new Map<string, ReturnType<typeof seam>>();
        const call = (t: string) => {
            let sm = seams.get(t);
            if (!sm) {
                sm = seam({
                    baseUrl: 'https://api.vendor.test',
                    adapter: vendor.adapter(),
                    store, // the shared/durable store a real deployment configures
                    clock,
                    circuit: CIRCUIT,
                });
                seams.set(t, sm);
            }
            return sm.as(t).stitch({
                path: '/v1/items',
                headers: { 'x-tenant': t },
            });
        };
        const { healthy } = await blast(call);
        check('(f) distinct seams constructed', seams.size, 10);
        check('(f) distinct breaker keys', store.keys('circuit:').length, 1);
        check('(f) → healthy tenants that FAILED', blastRadius(healthy), 9);
        note(
            '(f) → a per-tenant seam isolates the RATE bucket but not the BREAKER',
            'the bucket key carries the seam id (`seam:sN`, seam.ts:59) and the breaker key does not — see C5 (f) for the asymmetry measured side by side',
        );
    }

    // ── (g) the worst default: a `url`-only stitch keys on the literal string "stitch" ─────────
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock, failing: { [BAD]: 500 } });
        const made = new Map<string, Stitch>();
        const call = (t: string) => {
            let st = made.get(t);
            if (!st) {
                st = stitch({
                    url: 'https://api.vendor.test/v1/items',
                    adapter: vendor.adapter(),
                    headers: { 'x-tenant': t },
                    store, // one shared store, as a real deployment configures
                    clock,
                    circuit: CIRCUIT,
                });
                made.set(t, st);
            }
            return st;
        };
        const { healthy } = await blast(call);
        checkSeq(
            '(g) breaker keys for 10 url-only stitches',
            store.keys('circuit:'),
            ['circuit:stitch'],
        );
        check('(g) → healthy tenants that FAILED', blastRadius(healthy), 9);
        // And it is not per-endpoint either: a completely different call collides too.
        const other = stitch({
            url: 'https://api.vendor.test/v1/orders',
            adapter: vendor.adapter(),
            headers: { 'x-tenant': 'unrelated' },
            store,
            clock,
            circuit: CIRCUIT,
        });
        check(
            '(g) an UNRELATED endpoint on the same shared store',
            await outcomeOf(() => other({})),
            '503',
        );
        note(
            '(g) → `nameOf` is `cfg.name ?? cfg.path ?? "stitch"` (engine.ts:140)',
            'a `url`-only config has neither, so every such stitch sharing a store shares one process-wide breaker under the literal key `circuit:stitch`',
        );
    }

    // ── (h) what the correct partition costs to build at 100 tenants ───────────────────────────
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
        const t0 = Date.now();
        const calls = Array.from({ length: 100 }, (_, i) =>
            s.as(`t${i}`).stitch({
                path: '/v1/items',
                headers: { 'x-tenant': `t${i}` },
                circuit: { ...CIRCUIT, key: `items:t${i}` },
            }),
        );
        const elapsed = Date.now() - t0;
        await Promise.all(calls.map((c) => c({}).safe()));
        check(
            '(h) 100 per-tenant keyed stitches → distinct breakers',
            store.keys('circuit:').length,
            100,
        );
        check('(h) timers armed by constructing them', clock.pending(), 0);
        check('(h) construction under 100ms', elapsed < 100, true);
        note('(h) construction time (ms)', elapsed);
    }

    finish(
        'C2',
        'YES — but only through the key STRING, and the capture\'s workaround does not work. `circuit.key` is a static `string`: of four candidate spellings typechecked, only `key: <string>` compiles; `key: () => id`, `keyOf`, and `tenancy: \'principal\'` are compile errors (types.ts:1072-1089, NoUnknownNestedKeys types.ts:411-448). A bound principal changes nothing — root, `.as("t1")` and `.as("t2")` all touched the single key `circuit:/v1/items`. What DOES partition is a per-tenant `circuit.key` (10 keys, 0 of 9 healthy tenants failed, and the bad tenant\'s own breaker still opened → 503) or, implicitly, a per-tenant `name`, since `hostKey` falls back to `cfg.name ?? cfg.path` (engine.ts:140,273). THE CAPTURE SAYS "PER-TENANT BREAKERS MEAN ONE STITCH PER TENANT" AND THAT IS FALSE: 10 distinct Stitch objects, each `.as()`-bound, resolving to the same `path` produced 1 breaker key and 9 of 9 healthy tenants down; so did 10 separate SEAMS sharing one store. Worst of all, 10 `url`-only stitches on a shared store collapse onto the literal key `circuit:stitch` — where an unrelated endpoint also measured 503. Isolation is a property of the key string, never of the object graph. The correct partition is cheap: 100 keyed stitches built in under 100ms with 0 timers armed',
    );
}

void main();
