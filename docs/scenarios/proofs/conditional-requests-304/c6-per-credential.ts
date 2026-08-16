// C6 — per-credential keying. GitHub mints ETags per token; replaying principal A's validator on
// principal B's request is a correctness bug, and on a server whose validators are content-derived
// it is a DATA LEAK: the 304 comes back and a client that then serves its stored body hands B what
// A fetched.
//
// Two stores are in play and they are governed by completely different things:
//
//   • the built-in `cache` — `tenancy: 'principal'` is the DEFAULT and fail-closed (types.ts:1147),
//     folding the seam-bound principal into the key (cache.ts:398, 451-457). Measured below in both
//     directions, including what `tenancy: 'app'` costs.
//   • the ETag store, which is user code — `tenancy` does not know it exists. Nothing keys it for
//     you, and the seam that CAN key it is not obvious: `ResolvedStitchConfig` carries no
//     `principal` (it lives on `AuthContext`, engine.ts:1032), so neither `Surface.buildRequest` nor
//     `Surface.interpret` can read it. `buildRequest` cannot even see the credential HEADER, because
//     it runs at engine.ts:253, before `cfg.auth.apply` at engine.ts:649.
//
// The seams that DO see the resolved credential are `hooks.onRequest` (engine.ts:652) and
// `Surface.execute` (engine.ts:666) — both downstream of auth. All four positions are measured.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c6-per-credential.ts
import { bearer } from '../../../../packages/core/src/auth';
import { seam, stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Adapter,
    AdapterRequest,
} from '../../../../packages/core/src/types';
import { clockStore } from './clock-store';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

interface Entry {
    etag: string;
    body: unknown;
}

/** The resolved `Authorization` header, or `''`. Case-insensitive: the engine never normalises. */
const credOf = (headers: Record<string, string>): string => {
    for (const [k, v] of Object.entries(headers))
        if (k.toLowerCase() === 'authorization') return v;
    return '';
};

/** An `execute` revalidator over a SHARED store, keyed by `keyOf`. The whole claim is `keyOf`. */
function revalidating(
    transport: Adapter,
    store: Map<string, Entry>,
    keyOf: (req: AdapterRequest) => string,
): Surface {
    return {
        id: 'http+revalidate',
        execute: async (req) => {
            const key = keyOf(req);
            const entry = store.get(key);
            if (entry) req.headers['If-None-Match'] = entry.etag;
            const res = await transport(req);
            if (res.status === 304 && entry)
                return { ...res, body: entry.body };
            const etag = res.headers['etag'];
            if (res.status === 200 && etag !== undefined)
                store.set(key, { etag, body: res.body });
            return res;
        },
    };
}

async function main(): Promise<void> {
    heading('C6 — one principal’s validator must never answer for another');

    // ── (a) the built-in cache: `tenancy: 'principal'` (the default) isolates ─────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        const sm = seam({
            clock,
            adapter: api.adapter(),
            store: clockStore(clock),
        });
        const forUser = (p: string) =>
            sm.as(p).stitch({
                url: api.url,
                auth: bearer(`tok-${p}`),
                cache: { ttl: '60s' }, // tenancy defaults to 'principal'
            });
        const alice = forUser('alice');
        const bob = forUser('bob');
        const a = await alice.safe({});
        const b = await bob.safe({});
        check(
            '(a) alice sees',
            (a.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check(
            '(a) bob sees',
            (b.data as { viewer?: string }).viewer,
            'tok-bob',
        );
        check('(a) requests', api.requests, 2);
        check(
            '(a) their cache keys differ',
            (await alice.cache.keyOf({})) !== (await bob.cache.keyOf({})),
            true,
        );
    }

    // ── (b) …and `tenancy: 'app'` does not ────────────────────────────────────────────────────
    // Documented as "correct only for public, unauthenticated data" (types.ts:1140). Measured, on
    // authenticated data, it serves alice's private body to bob from ONE request.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        const sm = seam({
            clock,
            adapter: api.adapter(),
            store: clockStore(clock),
        });
        const forUser = (p: string) =>
            sm.as(p).stitch({
                url: api.url,
                auth: bearer(`tok-${p}`),
                cache: { ttl: '60s', tenancy: 'app' },
            });
        await forUser('alice').safe({});
        const b = await forUser('bob').safe({});
        check(
            '(b) bob receives viewer',
            (b.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check('(b) requests', api.requests, 1);
        note(
            '(b) → `tenancy: "app"` is a documented trade, not a bug',
            'recorded here because the same word does NOT protect the ETag store (case d)',
        );
    }

    // ── (c) where the principal and the credential are actually visible ───────────────────────
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        let cfgHasPrincipal = 'MISSING';
        let credInBuildRequest = 'MISSING';
        let credInExecute = 'MISSING';
        let credInOnRequest = 'MISSING';
        const transport = api.adapter();
        const probe: Surface = {
            id: 'probe',
            buildRequest: (cfg, _input, base) => {
                cfgHasPrincipal = String(
                    'principal' in cfg ? 'present' : 'absent',
                );
                credInBuildRequest = credOf(base.headers) || 'absent';
                return base;
            },
            execute: async (req) => {
                credInExecute = credOf(req.headers) || 'absent';
                return transport(req);
            },
            interpret: (res, cfg) =>
                verdictOf(res, cfg) ?? { ok: true, data: res.body },
        };
        const sm = seam({ clock });
        await sm
            .as('alice')
            .stitch({
                url: api.url,
                kind: probe,
                auth: bearer('tok-alice'),
                hooks: {
                    onRequest: (ctx) => {
                        credInOnRequest =
                            credOf(ctx.req?.headers ?? {}) || 'absent';
                    },
                },
            })
            .safe({});
        check(
            '(c) `principal` on the surface’s cfg',
            cfgHasPrincipal,
            'absent',
        );
        check('(c) credential in `buildRequest`', credInBuildRequest, 'absent');
        check(
            '(c) credential in `hooks.onRequest`',
            credInOnRequest,
            'Bearer tok-alice',
        );
        check(
            '(c) credential in `Surface.execute`',
            credInExecute,
            'Bearer tok-alice',
        );
        note(
            '(c) → only the two POST-AUTH seams can key an ETag store by credential',
            '`buildRequest` runs at engine.ts:253, before `cfg.auth.apply` at engine.ts:649',
        );
    }

    // ── (d) THE LEAK: a hand-rolled store keyed on the URL alone ──────────────────────────────
    // One line of difference from case (e). The server's validators are content-derived here (the
    // Apache/CDN default), so bob's request carrying alice's validator gets a 304 — and the client
    // serves alice's body. Nothing errors, nothing warns, and the rate-limit numbers look GREAT.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        const shared = new Map<string, Entry>();
        const kind = revalidating(
            api.adapter(),
            shared,
            (req) => `${req.method} ${req.url}`, // ← no credential in the key
        );
        const sm = seam({ clock });
        const forUser = (p: string) =>
            sm.as(p).stitch({ url: api.url, kind, auth: bearer(`tok-${p}`) });
        const a = await forUser('alice').safe({});
        const b = await forUser('bob').safe({});
        check(
            '(d) alice sees',
            (a.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check(
            '(d) bob receives',
            (b.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check('(d) ETag store entries', shared.size, 1);
        checkSeq(
            '(d) what the server saw',
            api.hits.map((h) => `${h.token}|${h.inm}→${h.status}`),
            ['tok-alice|(none)→200', 'tok-bob|"v1"→304'],
        );
        check('(d) billed', api.billed, 1);
        note(
            '(d) → BOB WAS SERVED ALICE’S PRIVATE BODY, and the metrics improved',
            'a 304 rate of 50% is exactly what a working revalidator looks like',
        );
    }

    // ── (e) the fix: fold the credential into the ETag store key ──────────────────────────────
    // `Surface.execute` sees the resolved `Authorization` header (case c), so ONE key expression
    // fixes it, with no per-principal plumbing at the call site.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock, etagScope: 'content' });
        const shared = new Map<string, Entry>();
        const kind = revalidating(
            api.adapter(),
            shared,
            (req) => `${req.method} ${req.url} ${credOf(req.headers)}`, // ← credential IS the key
        );
        const sm = seam({ clock });
        const forUser = (p: string) =>
            sm.as(p).stitch({ url: api.url, kind, auth: bearer(`tok-${p}`) });
        const alice = forUser('alice');
        const bob = forUser('bob');
        await alice.safe({});
        await bob.safe({});
        const a2 = await alice.safe({});
        const b2 = await bob.safe({});
        check('(e) ETag store entries', shared.size, 2);
        check(
            '(e) alice’s second poll',
            (a2.data as { viewer?: string }).viewer,
            'tok-alice',
        );
        check(
            '(e) bob’s second poll',
            (b2.data as { viewer?: string }).viewer,
            'tok-bob',
        );
        checkSeq(
            '(e) what the server saw',
            api.hits.map((h) => `${h.token}|${h.inm}→${h.status}`),
            [
                'tok-alice|(none)→200',
                'tok-bob|(none)→200',
                'tok-alice|"v1"→304',
                'tok-bob|"v1"→304',
            ],
        );
        check('(e) billed', api.billed, 2);
    }

    // ── (f) the OTHER correlation bug: a closure variable under concurrency ───────────────────
    // The `interpret` + `hooks.onRequest` pairing (C3 seam 1) has no channel between the two, so the
    // key has to live in a closure variable that `onRequest` writes and `interpret` reads. Two
    // CONCURRENT calls to different resources on one stitch interleave, and the store silently ends
    // up holding one entry instead of two — a revalidator that never revalidates.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const store = new Map<string, Entry>();
        let pendingKey = '';
        const correlated: Surface = {
            id: 'closure-correlated',
            interpret: (res, cfg) => {
                const key = pendingKey; // ← whatever the LAST onRequest happened to write
                if (res.status === 304)
                    return { ok: true, data: store.get(key)?.body };
                const failure = verdictOf(res, cfg);
                if (failure) return failure;
                const etag = res.headers['etag'];
                if (etag !== undefined)
                    store.set(key, { etag, body: res.body });
                return { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: correlated,
            adapter: api.adapter(),
            clock,
            hooks: {
                onRequest: (ctx) => {
                    if (!ctx.req) return;
                    pendingKey = `${ctx.req.method} ${ctx.req.url}`;
                    const entry = store.get(pendingKey);
                    if (entry) ctx.req.headers['If-None-Match'] = entry.etag;
                    else delete ctx.req.headers['If-None-Match'];
                },
            },
        });
        await Promise.all([
            issues.safe({ query: { page: 1 } }),
            issues.safe({ query: { page: 2 } }),
        ]);
        check('(f) ETag store entries after 2 concurrent calls', store.size, 1);
        await Promise.all([
            issues.safe({ query: { page: 1 } }),
            issues.safe({ query: { page: 2 } }),
        ]);
        check('(f) requests after 4 calls', api.requests, 4);
        check('(f) billed', api.billed, 3);
        note(
            '(f) → 3 of 4 polls paid full price, and nothing said why',
            'the `execute` seam has no such gap: the request and its response are one function call',
        );
    }

    finish(
        'C6',
        'SPLIT, and the split is the finding. For the built-in `cache`, YES: `tenancy: "principal"` is the fail-closed DEFAULT and it holds — measured 2 requests and two different derived keys for two seam-bound principals, each seeing their own `viewer`; flipping to `tenancy: "app"` serves alice’s private body to bob off 1 request (a documented trade, types.ts:1140, not a bug). For a hand-rolled ETag store, NO — `tenancy`/`vary` do not know it exists, and the seams that could key it are not the obvious ones: `ResolvedStitchConfig` carries no `principal` at all (it lives on `AuthContext`, engine.ts:1032), and `Surface.buildRequest` cannot even see the credential HEADER because it runs at engine.ts:253, BEFORE `cfg.auth.apply` at engine.ts:649 — measured `absent` in both positions. Only `hooks.onRequest` (engine.ts:652) and `Surface.execute` (engine.ts:666) see the resolved credential, measured `Bearer tok-alice` in both. The consequence, against a server with content-derived validators: a store keyed on `METHOD URL` alone leaks — measured `[tok-alice|(none)→200, tok-bob|"v1"→304]`, ONE store entry, and bob receiving `viewer: tok-alice`, with the rate-limit metrics IMPROVING as it happens. Adding the credential to the key expression fixes it in one term: measured 2 store entries, 4 requests, `[…alice→200, …bob→200, …alice 304, …bob 304]`, each principal seeing their own data. A second correlation bug rides alongside: the `interpret` + `hooks.onRequest` pairing has no channel between the two seams, so the key must live in a closure variable — measured under 2 concurrent calls to different resources, the store ends up with 1 entry instead of 2 and 3 of the next 4 polls pay full price',
    );
}

void main();
