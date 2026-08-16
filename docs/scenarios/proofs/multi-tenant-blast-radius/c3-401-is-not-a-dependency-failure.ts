// C3 — is a `401` counted as a circuit failure? It shouldn't be: it says the CREDENTIAL is bad, not
// the dependency. Can `verdict`/`acceptStatus` exclude it from the breaker WITHOUT also swallowing
// the error from the caller?
//
// YES, and the mechanism is more interesting than the capture expects. The engine routes on WHAT
// failed (engine.ts:807-833): a bad STATUS throws and the throw is what `attemptWithCircuit` counts
// as a failure, while a well-formed response the SURFACE rejected comes back as a returned
// `{ ok: false }` outcome — which reaches the caller as a failed call but records a circuit
// SUCCESS. So the two halves of "error the caller, spare the breaker" are already separated; the
// question is only how to get a 401 onto the second path.
//
// Two ways, both measured. Pure config: `verdict: { accept: [401], flag: <path> }` — `accept` moves
// the 401 off the status-failure path, `flag` fails it on body grounds. Or ~5 lines of surface:
// an `interpret` that rejects 401/403 itself, for a vendor whose error body has no usable flag.
//
// The capture's worry is real and is measured in (b): `accept` ALONE is the swallowing case — the
// call succeeds and the caller is handed the 401 error body as its DATA.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c3-401-is-not-a-dependency-failure.ts
import { seam, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Adapter } from '../../../../packages/core/src/types';
import { FakeVendor, blastRadius, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

const HEALTHY = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
const BAD = 'bad';
const CIRCUIT = { failures: 3, cooldown: '30s' } as const;

/**
 * USER CODE — the surface a multi-tenant integration wants: a 401/403 is a CREDENTIAL verdict, not
 * a transport verdict. It composes `verdictOf` (surface.ts:174) so the stitch's own `verdict`
 * config is still honoured, exactly as the http surface does.
 *
 * It only works paired with `verdict: { accept: [401, 403] }`: `accept` is what stops the ENGINE
 * throwing on the status before the surface is consulted (engine.ts:824), and this hook is what
 * turns the accepted response back into a failure the caller sees.
 */
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

function fixture(opts: {
    failBody?: unknown;
    failing?: Record<string, number>;
}) {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({
        clock,
        failing: opts.failing ?? { [BAD]: 401 },
        ...(opts.failBody !== undefined ? { failBody: opts.failBody } : {}),
    });
    return { clock, store, vendor };
}

/** Did the breaker ever record a failure? Reading the record beats inferring it from behaviour. */
async function circuitRecord(
    store: ReturnType<typeof probeStore>,
    key: string,
): Promise<{ failures: number; tripped: boolean }> {
    const r = (await store.get(key)) as
        { failures?: number; tripped?: boolean } | undefined;
    return { failures: r?.failures ?? 0, tripped: r?.tripped ?? false };
}

async function main(): Promise<void> {
    heading('C3 — keeping a credential failure off the dependency breaker');

    // ── (a) baseline: a 401 IS a circuit failure ───────────────────────────────────────────────
    {
        const { clock, store, vendor } = fixture({});
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
        });
        const call = (t: string) =>
            s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        for (let i = 0; i < 3; i++) await outcomeOf(() => call(BAD)({}));
        const rec = await circuitRecord(store, 'circuit:/v1/items');
        check('(a) failures recorded by three 401s', rec.failures, 3);
        check('(a) breaker tripped', rec.tripped, true);
        note(
            '(a) → a 401 reaches `attemptWithCircuit` as a THROW',
            '`classifyStatus` says 401 ≥ 400 and is not accepted, so the engine throws (engine.ts:824-831) and the catch records `circuit.onFailure()` (engine.ts:879-890)',
        );
    }

    // ── (b) `verdict.accept: [401]` alone — the breaker is spared and the ERROR IS SWALLOWED ───
    // Exactly the trade the capture worries about, and it is worse than "swallowed": the caller is
    // handed the vendor's error envelope as a successful RESULT, so a revoked credential looks like
    // data all the way up the stack.
    {
        const { clock, store, vendor } = fixture({});
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
            verdict: { accept: [401] },
        });
        const call = (t: string) =>
            s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        const bad: string[] = [];
        for (let i = 0; i < 4; i++)
            bad.push(await outcomeOf(() => call(BAD)({})));
        const r = await call(BAD)({}).safe();
        checkSeq('(b) the bad tenant, 4 calls', bad, ['ok', 'ok', 'ok', 'ok']);
        check('(b) the call reports ok', r.ok, true);
        check(
            '(b) → and its DATA is the 401 error body',
            JSON.stringify(r.data),
            '{"error":"invalid_token"}',
        );
        const rec = await circuitRecord(store, 'circuit:/v1/items');
        check('(b) circuit failures recorded', rec.failures, 0);
        note(
            '(b) → `accept` can only turn a failure into a SUCCESS (surface.ts:174-190)',
            'it spares the breaker by making the call succeed, which is not the trade a multi-tenant caller wants',
        );
    }

    // ── (c) `accept` + `flag`: pure config, error preserved, breaker spared ────────────────────
    // For any vendor whose error envelope carries an explicitly-falsy flag. `accept` moves the
    // status off the throw path; `flag` fails the call on BODY grounds, which is an
    // application-level rejection — and the engine deliberately keeps those off the breaker.
    {
        const { clock, store, vendor } = fixture({
            failBody: { ok: false, error: 'invalid_token' },
        });
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
            verdict: { accept: [401], flag: 'ok' },
        });
        const call = (t: string) =>
            s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        const bad: string[] = [];
        for (let i = 0; i < 5; i++)
            bad.push(await outcomeOf(() => call(BAD)({})));
        const healthy: string[] = [];
        for (const t of HEALTHY)
            healthy.push(await outcomeOf(() => call(t)({})));

        checkSeq(
            '(c) the bad tenant, 5 calls — still an ERROR',
            [...new Set(bad)],
            ['401'],
        );
        const r = await call(BAD)({}).safe();
        check(
            '(c) error status',
            (r.error as { status?: number })?.status,
            401,
        );
        check(
            '(c) error message',
            r.error?.message,
            'verdict.flag `ok` is false',
        );
        check('(c) → healthy tenants that FAILED', blastRadius(healthy), 0);
        const rec = await circuitRecord(store, 'circuit:/v1/items');
        check('(c) circuit failures recorded', rec.failures, 0);
        check('(c) breaker tripped', rec.tripped, false);
        note(
            '(c) → the split already exists in the engine (engine.ts:807-833)',
            'a bad STATUS throws and is counted; a response the SURFACE rejected returns `{ ok: false }`, fails the call, and records `circuit.onSuccess()` — "the transport is healthy, the payload is not"',
        );
    }

    // ── (d) the same result with a surface, for a vendor with no usable flag ───────────────────
    {
        const { clock, store, vendor } = fixture({});
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: CIRCUIT,
            verdict: { accept: [401, 403] },
        });
        const call = (t: string) =>
            s.as(t).stitch({
                path: '/v1/items',
                headers: { 'x-tenant': t },
                kind: credentialAware,
            });
        const bad: string[] = [];
        for (let i = 0; i < 5; i++)
            bad.push(await outcomeOf(() => call(BAD)({})));
        const healthy: string[] = [];
        for (const t of HEALTHY)
            healthy.push(await outcomeOf(() => call(t)({})));
        const r = await call(BAD)({}).safe();

        checkSeq('(d) the bad tenant, 5 calls', [...new Set(bad)], ['401']);
        check(
            '(d) error message names the credential',
            r.error?.message,
            'credential rejected (HTTP 401)',
        );
        check('(d) → healthy tenants that FAILED', blastRadius(healthy), 0);
        check(
            '(d) circuit failures recorded',
            (await circuitRecord(store, 'circuit:/v1/items')).failures,
            0,
        );
        note(
            '(d) → 5 lines of `Surface.interpret` (surface.ts:56-62), composing `verdictOf`',
            'needed only because `verdict.flag` requires an explicitly-falsy field in the error body; a bare `{ "error": "..." }` has none',
        );
    }

    // ── (e) …and it is SURGICAL: a real outage still opens the breaker ─────────────────────────
    // The exclusion has to be status-shaped, not a blanket "never trip". Under exactly the config
    // from (d), a 500 from the vendor trips it in 3.
    {
        const { clock, store, vendor } = fixture({ failing: {} });
        const down: Adapter = async () => ({
            status: 500,
            headers: {},
            body: { error: 'upstream' },
        });
        void vendor;
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: down,
            store,
            clock,
            circuit: CIRCUIT,
            verdict: { accept: [401, 403] },
        });
        const call = (t: string) =>
            s.as(t).stitch({
                path: '/v1/items',
                headers: { 'x-tenant': t },
                kind: credentialAware,
            });
        const spine: string[] = [];
        for (const t of ['t1', 't2', 't3', 't4'])
            spine.push(await outcomeOf(() => call(t)({})));
        checkSeq('(e) a genuine 500 outage', spine, [
            '500',
            '500',
            '500',
            '503',
        ]);
        check(
            '(e) breaker tripped on the real outage',
            (await circuitRecord(store, 'circuit:/v1/items')).tripped,
            true,
        );
        note(
            '(e) → the breaker still does its job',
            'only the credential statuses were moved off it; the 4th call fast-failed at 503 as designed',
        );
    }

    // ── (f) the interaction nobody sets out to configure: `retry` triples the 401s ─────────────
    // Without the exclusion, a `retry` policy that lists 401 turns one broken tenant's single call
    // into `attempts` circuit failures. Measured against the plain construction.
    {
        const { clock, store, vendor } = fixture({});
        const s = seam({
            baseUrl: 'https://api.vendor.test',
            adapter: vendor.adapter(),
            store,
            clock,
            circuit: { failures: 5, cooldown: '30s' },
            retry: {
                attempts: 3,
                on: [401, 500],
                backoff: { curve: 'fixed', base: 10 },
            },
        });
        const call = (t: string) =>
            s.as(t).stitch({ path: '/v1/items', headers: { 'x-tenant': t } });
        const p = call(BAD)({}).safe();
        await clock.advance(1000);
        await p;
        check(
            '(f) vendor requests for ONE logical call',
            vendor.forTenant(BAD).length,
            3,
        );
        check(
            '(f) circuit failures recorded by that one call',
            (await circuitRecord(store, 'circuit:/v1/items')).failures,
            1,
        );
        note(
            '(f) → the breaker counts the CALL, not the attempts',
            '`attemptWithCircuit` wraps the whole retry loop (engine.ts:846-893), so a retried 401 is one failure — but it is still 3 requests the vendor sees from a credential that will never work',
        );
    }

    finish(
        'C3',
        'YES, and the trade the capture fears is avoidable. Baseline first: three 401s recorded `failures: 3` and tripped the breaker, because a bad status reaches `attemptWithCircuit` as a THROW (engine.ts:824-831,879-890). `verdict: { accept: [401] }` ALONE is exactly the swallowing case — 4 of 4 calls measured "ok" and the caller was handed `{"error":"invalid_token"}` as its DATA, with 0 circuit failures. The construction that does both is `verdict: { accept: [401], flag: "ok" }`, PURE CONFIG: the bad tenant got StitchError status 401 (message "verdict.flag `ok` is false") on all 5 calls, 0 of 9 healthy tenants failed, and the breaker recorded 0 failures and never tripped. It works because the engine already routes on WHAT failed (engine.ts:807-833) — a bad STATUS throws and is counted, a response the SURFACE rejected returns `{ ok: false }`, fails the call and records a circuit SUCCESS. For a vendor whose 401 body carries no falsy flag, 5 lines of `Surface.interpret` composing `verdictOf` do the same ("credential rejected (HTTP 401)", 0 of 9 healthy failed, 0 circuit failures). The exclusion is surgical: under that same config a genuine 500 outage measured 500,500,500,503 and tripped the breaker as designed',
    );
}

void main();
