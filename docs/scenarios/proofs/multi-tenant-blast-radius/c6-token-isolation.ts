// C6 — token isolation. Confirm `oauth2({ tenancy: 'principal' })` keeps tenant tokens separate in
// the multi-tenant construction, and that one tenant's refresh storm doesn't disturb another
// tenant's in-flight calls.
//
// It does, on both counts, and this is the one axis where the library's answer is the correct one
// out of the box — the principal DOES reach the auth layer (`AuthContext.principal`,
// types.ts:1214-1219), which is exactly what the resilience layer lacks.
//
// The finding the capture does not draw out is the difference between a token and a CREDENTIAL.
// `tenancy: 'principal'` partitions the token CACHE; it does not give each customer their own
// client id/secret, because `Secret` is `string | (() => string)` (auth.ts:47) — a NILADIC thunk,
// with no `AuthContext` in scope. So a shared `oauth2()` mints every tenant's token from the SAME
// client credentials (e). The escape hatch is real and one line: a custom `AuthStrategy.apply(req,
// ctx)` DOES receive the context, so `ctx.principal` selects the credential (f).
//
// And the default is the wrong way round for this scenario: `tenancy` defaults to `'app'`
// (auth.ts:483-486), which serves every customer one shared token (b).
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c6-token-isolation.ts
import { oauth2 } from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { AuthStrategy } from '../../../../packages/core/src/types';
import { FakeIdp, FakeVendor, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

const TOKEN_URL = 'https://idp.vendor.test/token';

function fixture(opts: {
    tenancy?: 'principal' | 'app';
    failing?: Record<string, number>;
    auth?: AuthStrategy;
}) {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({ clock, failing: opts.failing ?? {} });
    const idp = new FakeIdp();
    const s = seam({
        baseUrl: 'https://api.vendor.test',
        adapter: vendor.adapter(),
        store,
        clock,
        auth:
            opts.auth ??
            oauth2({
                tokenUrl: TOKEN_URL,
                clientId: 'saas-app',
                clientSecret: 'shh',
                adapter: idp.adapter(),
                ...(opts.tenancy !== undefined
                    ? { tenancy: opts.tenancy }
                    : {}),
            }),
    });
    const call = (t: string) =>
        s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
    return { clock, store, vendor, idp, seam: s, call };
}

async function main(): Promise<void> {
    heading('C6 — per-tenant tokens in the multi-tenant construction');

    // ── (a) `tenancy: 'principal'` — one token per customer, cached per customer ───────────────
    {
        const { store, vendor, idp, call } = fixture({ tenancy: 'principal' });
        for (const t of ['t1', 't2', 't3', 't1']) await call(t)({}).safe();
        check('(a) calls made', vendor.calls.length, 4);
        check('(a) token requests', idp.mints, 3);
        checkSeq(
            '(a) the Authorization header each call carried',
            vendor.calls.map((c) => c.authorization),
            [
                'Bearer tok-saas-app-1',
                'Bearer tok-saas-app-2',
                'Bearer tok-saas-app-3',
                'Bearer tok-saas-app-1', // t1's SECOND call reused t1's token
            ],
        );
        check('(a) distinct vault keys', store.keys('vault:oauth2:').length, 3);
        check(
            "(a) …and each is the tokenUrl + '\\0' + principal",
            store.keys('vault:oauth2:').every((k) => k.includes('\u0000')),
            true,
        );
        note(
            '(a) → `keyFor(ctx)` folds `ctx.principal` in (auth.ts:485-499)',
            'the principal reaches the AUTH layer — this is the one place `seam.as()` is load-bearing at runtime',
        );
    }

    // ── (b) the DEFAULT is `'app'`, and it hands every customer the same token ─────────────────
    {
        const { store, vendor, idp, call } = fixture({});
        for (const t of ['t1', 't2', 't3']) await call(t)({}).safe();
        check('(b) token requests for 3 different customers', idp.mints, 1);
        checkSeq(
            '(b) headers',
            [...new Set(vendor.calls.map((c) => c.authorization))],
            ['Bearer tok-saas-app-1'],
        );
        check('(b) distinct vault keys', store.keys('vault:oauth2:').length, 1);
        note(
            "(b) → `OAuth2Options.tenancy` defaults to `'app'` (auth.ts:483-486)",
            'correct for client_credentials, wrong for a per-customer integration — and it is silent: nothing about the call site says whose token went out',
        );
    }

    // ── (c) `tenancy: 'principal'` fails CLOSED with no bound principal ────────────────────────
    // The safety property that makes (a) trustworthy: you cannot accidentally get an unscoped token.
    {
        const clock = manualClock();
        const store = probeStore();
        const vendor = new FakeVendor({ clock });
        const idp = new FakeIdp();
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            auth: oauth2({
                tokenUrl: TOKEN_URL,
                clientId: 'saas-app',
                clientSecret: 'shh',
                adapter: idp.adapter(),
                tenancy: 'principal',
            }),
        });
        const r = await s.stitch({ path: '/v1/items' })({}).safe(); // no `.as()`
        check('(c) unbound call ok?', r.ok, false);
        check(
            '(c) error mentions the fix',
            (r.error?.message ?? '').includes('seam.as('),
            true,
        );
        check('(c) token requests made', idp.mints, 0);
    }

    // ── (d) one tenant's refresh storm does not disturb another's ──────────────────────────────
    // The broken tenant 401s, which the strategy reads as "token rejected" and answers with a fresh
    // fetch + retry — repeatedly. Measure that the healthy tenant's token is untouched and its call
    // still succeeds.
    {
        const { vendor, idp, call } = fixture({
            tenancy: 'principal',
            failing: { broken: 401 },
        });
        await call('t1')({}).safe();
        const before = vendor.forTenant('t1').map((c) => c.authorization);
        const mintsAfterT1 = idp.mints;

        for (let i = 0; i < 5; i++) await outcomeOf(() => call('broken')({}));
        const stormMints = idp.mints - mintsAfterT1;

        const r = await call('t1')({}).safe();
        const after = vendor.forTenant('t1').map((c) => c.authorization);

        check('(d) token fetches the storm caused', stormMints, 6);
        check(
            '(d) requests the broken tenant made',
            vendor.forTenant('broken').length,
            10,
        );
        checkSeq('(d) t1 tokens, before and after the storm', after, [
            before[0]!,
            before[0]!,
        ]);
        check('(d) t1 still succeeds', r.ok, true);
        check(
            '(d) t1 vendor requests across the whole storm',
            vendor.forTenant('t1').length,
            2,
        );
        note(
            '(d) → the storm cost 6 token fetches and 10 vendor requests',
            "all of them charged to the broken tenant's own vault key; nothing crossed over",
        );
    }

    // ── (e) the CREDENTIAL cannot be per-tenant on a shared `oauth2()` ─────────────────────────
    // `tenancy` partitions the token cache. It does not choose which client id mints the token,
    // because the resolver takes no context.
    {
        const { idp, call } = fixture({ tenancy: 'principal' });
        for (const t of ['t1', 't2', 't3']) await call(t)({}).safe();
        checkSeq(
            '(e) client_ids the IdP saw for 3 different customers',
            [...new Set(idp.clientIds)],
            ['saas-app'],
        );
        const niladic: () => string = () => 'x';
        check(
            '(e) `Secret` thunk arity (a principal-aware resolver would take 1)',
            niladic.length,
            0,
        );
        note(
            '(e) → `Secret = string | (() => string)` (auth.ts:47)',
            'no `AuthContext` parameter, so `clientId`/`clientSecret`/`scope` are fixed per strategy instance — per-customer credentials need one strategy (hence one seam or one stitch) per customer',
        );
    }

    // ── (f) …and the escape hatch is one line, because `apply` DOES get the context ────────────
    {
        const perTenant: AuthStrategy = {
            name: 'per-tenant-bearer',
            apply(req, ctx) {
                req.headers['authorization'] =
                    `Bearer cred-for-${ctx.principal}`;
            },
        };
        const { vendor, call } = fixture({ auth: perTenant });
        for (const t of ['t1', 't2']) await call(t)({}).safe();
        checkSeq(
            '(f) a custom strategy reading `ctx.principal`',
            vendor.calls.map((c) => c.authorization),
            ['Bearer cred-for-t1', 'Bearer cred-for-t2'],
        );
        note(
            '(f) → `AuthStrategy.apply(req, ctx)` receives `AuthContext` (types.ts:1206-1233)',
            'this is the ONLY user-reachable hook in the library that can see the bound principal at call time — the resilience layer has no equivalent',
        );
    }

    finish(
        'C6',
        'CONFIRMED, and it is the one axis the library gets right by construction. `oauth2({ tenancy: "principal" })` on a shared seam with `.as()` per customer minted 3 tokens for 3 customers, wrote 3 distinct vault keys (tokenUrl + NUL + principal, auth.ts:485-499), and reused t1\'s token on t1\'s second call — 4 calls, 3 fetches. It fails CLOSED: the same config called without `.as()` errored with a message naming `seam.as(` and made 0 token requests. The refresh storm is contained: 5 doomed calls from a revoked tenant cost 6 token fetches and 10 vendor requests, all charged to that tenant\'s own key, while the healthy tenant carried the identical token before and after and still succeeded. TWO THINGS TO CARRY FORWARD. The DEFAULT is `tenancy: "app"` (auth.ts:483-486) — 3 different customers measured 1 token fetch and one shared Authorization header, which is a credential bleed nothing at the call site hints at. And `tenancy` partitions the token CACHE, not the CREDENTIAL: all 3 customers\' tokens were minted from client_id `saas-app`, because `Secret = string | (() => string)` (auth.ts:47) is a niladic thunk with no `AuthContext` in scope. Per-customer credentials need one strategy instance per customer — or the one-line escape hatch, a custom `AuthStrategy.apply(req, ctx)` reading `ctx.principal`, which measured `Bearer cred-for-t1` / `cred-for-t2`. That hook is the only user-reachable place in the library that sees the bound principal at call time',
    );
}

void main();
