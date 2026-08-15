// C8 — state plainly, for each of the four shared resources, whether it ends up isolated per tenant
// and by what mechanism. Then run the whole construction and measure the blast radius.
//
// The one-line answer: TWO of the four are isolated by the principal, and TWO are isolated only by
// a string you have to remember to write.
//
//   token   → `oauth2({ tenancy: 'principal' })` + `seam.as(id)`   — the PRINCIPAL. Fail-closed.
//   cache   → `tenancy: 'principal'`, the DEFAULT                   — the PRINCIPAL. Fail-closed.
//   rate    → a per-tenant limiter KEY (member `name` or a per-tenant seam). No principal.
//   breaker → a per-tenant `circuit.key`. No principal.
//
// The split is exactly the auth/resilience line: `AuthContext.principal` (types.ts:1214-1219) is
// threaded to the auth strategies and the cache-key builder, and to nothing else. So the two
// resources whose isolation is a SECURITY property fail closed, and the two whose isolation is an
// AVAILABILITY property fail open — silently, with no type error and no warning.
//
// (e) is the honest caveat on the assembled answer: a global vendor quota and per-tenant fairness
// cannot both be had from the built-ins, because a seam-level throttle re-introduces exactly the
// coupling the per-tenant keys removed.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c8-four-resources.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { seam, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Stitch } from '../../../../packages/core/src/types';
import { FakeIdp, FakeVendor, blastRadius, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

const HEALTHY = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
const BAD = 'bad';
const NOISY = 'noisy';
const QUIET = 'quiet';

/** C3's surface: a 401/403 is a CREDENTIAL verdict, so it fails the CALL without failing the HOST. */
const credentialAware: Surface = {
    id: 'http',
    interpret: (res, cfg) => {
        if (res.status === 401 || res.status === 403)
            return {
                ok: false,
                message: `credential rejected (HTTP ${res.status})`,
                status: res.status,
            };
        return verdictOf(res, cfg) ?? { ok: true, data: res.body };
    },
};

/**
 * THE ASSEMBLED CONSTRUCTION. One seam carries everything genuinely shared — store, vault, clock,
 * adapter (and its connection pool), trace sink, the auth strategy, the credential-aware verdict.
 * Each tenant's member carries the three per-tenant STRINGS that do the isolating.
 */
function tenantAware(opts: { seamThrottle?: boolean } = {}) {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({ clock, failing: { [BAD]: 401 } });
    const idp = new FakeIdp();
    const s = seam({
        baseUrl: 'https://api.vendor.test',
        adapter: vendor.adapter(),
        store,
        clock,
        // token: per-tenant, fail-closed, by the PRINCIPAL.
        auth: oauth2({
            tokenUrl: 'https://idp.vendor.test/token',
            clientId: 'saas-app',
            clientSecret: 'shh',
            adapter: idp.adapter(),
            tenancy: 'principal',
        }),
        // a credential failure is not a dependency failure (C3).
        verdict: { accept: [401, 403] },
        // (e) toggles the global vendor quota on, to measure what declaring it costs.
        ...(opts.seamThrottle ? { throttle: { rate: '10/s' } } : {}),
    });
    const made = new Map<string, Stitch>();
    const call = (tenant: string): Stitch => {
        let st = made.get(tenant);
        if (!st) {
            st = s.as(tenant).stitch({
                // rate: the limiter key comes from the NAME (engine.ts:140,273).
                name: `items:${tenant}`,
                path: '/v1/items',
                headers: { 'x-tenant': tenant },
                kind: credentialAware,
                throttle: { rate: '10/s' },
                // breaker: the ONE knob that partitions it.
                circuit: {
                    failures: 3,
                    cooldown: '30s',
                    key: `items:${tenant}`,
                },
            });
            made.set(tenant, st);
        }
        return st;
    };
    return { clock, store, vendor, idp, seam: s, call };
}

/**
 * Every member here declares its own `rate`, so a SEQUENTIAL call needs the virtual clock moved
 * before it can be granted. `drive` fires the call, runs the clock past any pacing wait, and
 * returns the settled outcome — the ordering the breaker claims depend on, on an injected clock.
 */
/** Which per-tenant breakers are actually OPEN — the read that distinguishes "keyed" from "tripped". */
async function trippedBreakers(
    store: ReturnType<typeof probeStore>,
): Promise<string[]> {
    const open: string[] = [];
    for (const key of store.keys('circuit:')) {
        const r = (await store.get(key)) as { tripped?: boolean } | undefined;
        if (r?.tripped) open.push(key);
    }
    return open;
}

async function drive(
    clock: ReturnType<typeof manualClock>,
    call: () => PromiseLike<unknown>,
): Promise<string> {
    const p = outcomeOf(call);
    await clock.advance(1000);
    return p;
}

async function main(): Promise<void> {
    heading('C8 — the four shared resources, and the assembled answer');

    // ── (a) the blast radius of a revoked credential, end to end ───────────────────────────────
    {
        const { clock, store, vendor, call } = tenantAware();
        const bad: string[] = [];
        for (let i = 0; i < 5; i++)
            bad.push(await drive(clock, () => call(BAD)({})));
        const healthy: string[] = [];
        for (const t of HEALTHY)
            healthy.push(await drive(clock, () => call(t)({})));

        checkSeq(
            '(a) the broken tenant still gets a real error',
            [...new Set(bad)],
            ['401'],
        );
        check('(a) healthy tenants called', healthy.length, 9);
        check(
            '(a) → BLAST RADIUS (healthy tenants that failed)',
            blastRadius(healthy),
            0,
        );
        check(
            '(a) healthy requests that reached the vendor',
            vendor.calls.filter((c) => c.tenant !== BAD).length,
            9,
        );
        check(
            '(a) distinct breaker keys (one per tenant)',
            store.keys('circuit:').length,
            10,
        );
        checkSeq(
            '(a) → breakers that TRIPPED',
            await trippedBreakers(store),
            [],
        );
        note(
            '(a) → C1 measured 9 of 9 healthy tenants down under the naive construction',
            'the same failure under this one is 0 of 9, and the broken tenant is still told its credential is bad',
        );
    }

    // ── (b) …and a REAL outage still trips, per tenant ──────────────────────────────────────────
    // The exclusion must not have disarmed the breaker. A tenant hitting a genuinely broken
    // endpoint gets its own breaker opened; nobody else does.
    {
        const { clock, store, vendor, call } = tenantAware();
        vendor.fail('degraded', 500);
        const spine: string[] = [];
        for (let i = 0; i < 4; i++)
            spine.push(await drive(clock, () => call('degraded')({})));
        const others: string[] = [];
        for (const t of ['t1', 't2', 't3'])
            others.push(await drive(clock, () => call(t)({})));
        checkSeq('(b) the degraded tenant', spine, [
            '500',
            '500',
            '500',
            '503',
        ]);
        check('(b) → other tenants that failed', blastRadius(others), 0);
        check('(b) distinct breaker keys', store.keys('circuit:').length, 4);
        checkSeq('(b) → breakers that TRIPPED', await trippedBreakers(store), [
            'circuit:items:degraded',
        ]);
    }

    // ── (c) the noisy neighbour, under the same construction ───────────────────────────────────
    {
        const { clock, vendor, call } = tenantAware();
        const inFlight = [
            ...Array.from({ length: 20 }, () => call(NOISY)({}).safe()),
            call(QUIET)({}).safe(),
        ];
        await clock.advance(120_000);
        await Promise.all(inFlight);
        checkSeq(
            '(c) the quiet tenant left at (virtual ms)',
            vendor.arrivals(QUIET),
            [0],
        );
        check(
            '(c) the noisy tenant was still paced at its own 10/s',
            `${vendor.arrivals(NOISY)[0]}..${vendor.arrivals(NOISY).at(-1)}`,
            '0..1900',
        );
        note(
            '(c) → C4 measured the quiet tenant at t=2000 under the naive construction',
            'per-tenant limiter keys move it to t=0 while leaving the noisy tenant paced exactly as declared',
        );
    }

    // ── (d) the token, and the cache, on the principal ─────────────────────────────────────────
    {
        const { clock: tokenClock, store, vendor, idp, call } = tenantAware();
        for (const t of ['t1', 't2', 't1'])
            await drive(tokenClock, () => call(t)({}));
        check('(d) token fetches for 2 tenants over 3 calls', idp.mints, 2);
        check(
            '(d) distinct token vault keys',
            store.keys('vault:oauth2:').length,
            2,
        );
        checkSeq(
            '(d) the tokens that went out',
            vendor.calls.map((c) => c.authorization),
            [
                'Bearer tok-saas-app-1',
                'Bearer tok-saas-app-2',
                'Bearer tok-saas-app-1',
            ],
        );

        // The cache is the fourth resource, and its default is the safe one.
        const clock = manualClock();
        const cacheStore = probeStore();
        const v = new FakeVendor({ clock });
        const cs = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: v.adapter(),
            store: cacheStore,
            clock,
        });
        const cached = (t: string, tenancy: 'principal' | 'app') =>
            cs.as(t).stitch({
                name: 'me',
                path: '/v1/me',
                headers: { 'x-tenant': t },
                cache: { ttl: '60s', tenancy, fingerprint: { version: 'v1' } },
            });
        const p1 = await cached('t1', 'principal')({}).safe();
        const p2 = await cached('t2', 'principal')({}).safe();
        checkSeq(
            "(d) cache `tenancy: 'principal'` (the DEFAULT) — whose data each tenant got",
            [
                (p1.data as { tenant?: string })?.tenant,
                (p2.data as { tenant?: string })?.tenant,
            ],
            ['t1', 't2'],
        );
        const a1 = await cached('t1', 'app')({}).safe();
        const a2 = await cached('t2', 'app')({}).safe();
        checkSeq(
            "(d) cache `tenancy: 'app'` — whose data each tenant got",
            [
                (a1.data as { tenant?: string })?.tenant,
                (a2.data as { tenant?: string })?.tenant,
            ],
            ['t1', 't1'],
        );
        note(
            "(d) → `tenancy: 'app'` served t2 t1's response body",
            "the default is `'principal'` and fail-closed (types.ts:1136-1147), so this one only bites someone who opts out",
        );
    }

    // ── (e) THE CAVEAT: a global vendor quota re-couples the tenants ───────────────────────────
    // A real integration also has a quota with the VENDOR, not just fairness between customers. A
    // seam-level throttle expresses that — and a member's own throttle only ever TIGHTENS on top of
    // it (seam.ts:94-106), so declaring the global cap puts the noisy neighbour straight back.
    {
        const { clock, vendor, call } = tenantAware({ seamThrottle: true });
        const inFlight = [
            ...Array.from({ length: 20 }, () => call(NOISY)({}).safe()),
            call(QUIET)({}).safe(),
        ];
        await clock.advance(120_000);
        await Promise.all(inFlight);
        checkSeq(
            '(e) quiet arrival WITH a global seam quota',
            vendor.arrivals(QUIET),
            [2000],
        );
        note(
            '(e) → the two policies cannot both be declared',
            'a member throttle stacks tighten-only on the seam bucket (seam.ts:94-106); expressing "1000/m to the vendor AND 10/s per customer" needs the outer gate to be user code (`throttle.delegate`) or a per-tenant seam plus your own global limiter',
        );
    }

    // ── (f) the summary, printed as the table a docs page should carry ─────────────────────────
    {
        const rows: [string, string, string][] = [
            [
                'token',
                'isolated',
                "`oauth2({ tenancy: 'principal' })` + `seam.as(id)` — the PRINCIPAL, fail-closed",
            ],
            [
                'cache',
                'isolated',
                "`CacheOptions.tenancy` defaults to 'principal' — the PRINCIPAL, fail-closed",
            ],
            [
                'rate budget',
                'isolated ONLY by a key',
                'a per-tenant member `name` (+ member `throttle`) or a per-tenant seam — NOT the principal',
            ],
            [
                'circuit breaker',
                'isolated ONLY by a key',
                'a per-tenant `circuit.key` — NOT the principal, and not per-tenant objects',
            ],
        ];
        for (const [resource, verdict, how] of rows)
            note(`(f) ${resource.padEnd(15)} ${verdict}`, how);
        check(
            '(f) resources isolated by the bound principal',
            rows.filter(([, v]) => v === 'isolated').length,
            2,
        );
        check(
            '(f) resources isolated only by a hand-written key',
            rows.filter(([, v]) => v.includes('ONLY')).length,
            2,
        );
    }

    finish(
        'C8',
        'TWO OF THE FOUR ARE ISOLATED BY THE PRINCIPAL; TWO ARE ISOLATED ONLY BY A STRING YOU HAVE TO REMEMBER TO WRITE. Token: `oauth2({ tenancy: "principal" })` + `seam.as(id)` — 2 tenants over 3 calls measured 2 token fetches and 2 vault keys, fail-closed. Cache: `tenancy` defaults to "principal" — t1 and t2 got their own bodies, while opting into "app" served t2 t1\'s response. Rate budget: isolated only by a per-tenant limiter KEY (a member `name` plus a member `throttle`, or a per-tenant seam). Breaker: isolated only by a per-tenant `circuit.key`. The split is exactly the auth/resilience line — `AuthContext.principal` reaches the auth strategies and the cache-key builder and nothing else — so the two resources whose isolation is a SECURITY property fail closed, and the two whose isolation is an AVAILABILITY property fail open, silently. ASSEMBLED, IT WORKS: the same revoked credential that took down 9 of 9 healthy tenants in C1 took down 0 of 9 here, with the broken tenant still receiving a real 401 and all 9 healthy calls reaching the vendor; a genuine 500 still opened that tenant\'s OWN breaker (500,500,500,503) with 0 of 3 others affected; and the 20-call burst that pushed a quiet tenant to t=2000 in C4 measured t=0. ONE CAVEAT THE BUILT-INS CANNOT CLOSE: adding a seam-level `throttle` to express the GLOBAL vendor quota puts the noisy neighbour straight back (quiet at t=2000), because a member throttle stacks tighten-only on the seam bucket (seam.ts:94-106) — "1000/m to the vendor AND 10/s per customer" is not expressible in one construction',
    );
}

void main();
