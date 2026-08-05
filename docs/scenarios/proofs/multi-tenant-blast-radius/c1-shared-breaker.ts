// C1 — DECIDING. One tenant's credential is revoked. With a `circuit` on the shared seam, does the
// breaker open and fail the HEALTHY tenants? Measure exactly: N healthy tenants, how many failed,
// with what error, and how many of them ever reached the vendor.
//
// The capture predicts the shape ("one revoked token, total outage") and it is right. Two things
// it does NOT predict, both measured here:
//
//   • The outage is SELF-SUSTAINING, not a `cooldown`-long blip. The breaker admits exactly ONE
//     trial call when it goes half-open (resilience.ts:375-379), and the tenant most likely to make
//     it is the broken one — it is the one retrying hardest. Its 401 re-opens the breaker before
//     any healthy tenant is admitted. Measured over 4 cooldown windows in (d): healthy is 503 in
//     every one of them.
//   • `seam.as(principal)` does not reach the resilience layer AT ALL. The breaker's key is
//     `hostKey(req, cfg)` — `cfg.name ?? cfg.path ?? 'stitch'` (engine.ts:140,265-274,860) — and (e)
//     measures the same key string for a root-created and a principal-bound stitch.
//
//   pnpm exec tsx docs/scenarios/proofs/multi-tenant-blast-radius/c1-shared-breaker.ts
import { seam } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeVendor, blastRadius, outcomeOf } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { probeStore } from './probe-store';

const HEALTHY = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
const BAD = 'bad';

/** The shared-surface construction a SaaS writes first: one seam, one breaker, `.as()` per customer. */
function sharedSeam(failing: Record<string, number> = { [BAD]: 401 }) {
    const clock = manualClock();
    const store = probeStore();
    const vendor = new FakeVendor({ clock, failing });
    const s = seam({
        baseUrl: 'https://api.vendor.test',
        adapter: vendor.adapter(),
        store,
        clock,
        circuit: { failures: 3, cooldown: '30s' },
    });
    const call = (tenant: string) =>
        s.as(tenant).stitch({
            path: '/v1/items',
            headers: { 'x-tenant': tenant },
        });
    return { clock, store, vendor, seam: s, call };
}

async function main(): Promise<void> {
    heading('C1 — one revoked credential, N healthy tenants');

    // ── (a) the blast radius, as a count ───────────────────────────────────────────────────────
    // The bad tenant fails its threshold; then nine healthy customers make one ordinary call each.
    {
        const { vendor, call } = sharedSeam();
        const bad: string[] = [];
        for (let i = 0; i < 3; i++)
            bad.push(await outcomeOf(() => call(BAD)({})));
        const healthy: string[] = [];
        for (const t of HEALTHY)
            healthy.push(await outcomeOf(() => call(t)({})));

        checkSeq('(a) the bad tenant, 3 calls', bad, ['401', '401', '401']);
        check('(a) healthy tenants called', HEALTHY.length, 9);
        check('(a) → how many of them FAILED', blastRadius(healthy), 9);
        checkSeq('(a) their outcomes', [...new Set(healthy)], ['503']);
        // They did not fail at the vendor — they never got there.
        check(
            '(a) healthy requests that reached the vendor',
            vendor.calls.filter((c) => c.tenant !== BAD).length,
            0,
        );
        note(
            '(a) → one customer whose refresh token was revoked',
            'took down 9 of 9 healthy customers, and their calls never left the process',
        );
    }

    // ── (b) what the healthy tenant's error actually is ────────────────────────────────────────
    // A 503 with a body-free `circuit open` message: nothing in it names the tenant that caused it,
    // so the on-call page for customer #7 says the vendor is down when the vendor is fine.
    {
        const { call } = sharedSeam();
        for (let i = 0; i < 3; i++) await outcomeOf(() => call(BAD)({}));
        const r = await call('t1')({}).safe();
        const err = r.error as (Error & { status?: number }) | undefined;
        check('(b) healthy call ok?', r.ok, false);
        check('(b) error name', err?.name, 'StitchError');
        check('(b) status', err?.status, 503);
        check('(b) message', err?.message, 'circuit open');
        check(
            '(b) does the error name the tenant that opened it?',
            JSON.stringify(err ?? {}).includes(BAD),
            false,
        );
        note(
            '(b) → `CircuitOpenError` carries `status = 503` (resilience.ts:251-257)',
            'surfaced to the caller as a StitchError with no attribution to the tenant that tripped it',
        );
    }

    // ── (c) the threshold is CONSECUTIVE failures, pooled across tenants ───────────────────────
    // Interleaving healthy traffic does reset the counter (`onSuccess` clears it,
    // resilience.ts:381-387) — so the breaker opens only when the bad tenant's calls happen to run
    // back-to-back. That is a scheduling accident, not a safety property: one tenant polling on a
    // timer is enough.
    {
        const { call } = sharedSeam();
        const interleaved: string[] = [];
        for (let i = 0; i < 3; i++) {
            interleaved.push(await outcomeOf(() => call(BAD)({})));
            interleaved.push(await outcomeOf(() => call('t1')({})));
        }
        checkSeq('(c) bad/healthy interleaved 3×', interleaved, [
            '401',
            'ok',
            '401',
            'ok',
            '401',
            'ok',
        ]);
        // …and now three of the bad tenant's calls in a row, which is all it takes.
        const burst: string[] = [];
        for (let i = 0; i < 3; i++)
            burst.push(await outcomeOf(() => call(BAD)({})));
        const after = await outcomeOf(() => call('t1')({}));
        check('(c) healthy tenant after 3 consecutive bad calls', after, '503');
        note(
            '(c) → the breaker counts CONSECUTIVE failures over one shared counter',
            'healthy traffic resets it, so whether the outage happens depends on interleaving — a tenant polling on a timer trips it reliably',
        );
    }

    // ── (d) THE FINDING THE CAPTURE MISSES: the outage does not end ────────────────────────────
    // `cooldown` elapses, the breaker goes half-open and admits ONE trial. The broken tenant is the
    // one hammering the endpoint, so it wins the probe, fails, and re-arms a fresh cooldown
    // (resilience.ts:389-404). Four windows, and no healthy tenant is ever admitted.
    {
        const { clock, call } = sharedSeam();
        for (let i = 0; i < 3; i++) await outcomeOf(() => call(BAD)({}));
        const rounds: string[] = [];
        for (let round = 0; round < 4; round++) {
            await clock.advance(30_000); // the full cooldown elapses
            await outcomeOf(() => call(BAD)({})); // the broken tenant takes the trial
            rounds.push(await outcomeOf(() => call('t1')({})));
        }
        checkSeq('(d) healthy tenant across 4 cooldown windows', rounds, [
            '503',
            '503',
            '503',
            '503',
        ]);
        check(
            '(d) virtual seconds elapsed, still failing',
            clock.now() / 1000,
            120,
        );
        note(
            '(d) → half-open admits exactly ONE trial (resilience.ts:375-379)',
            'the tenant most likely to take it is the broken one; its failure re-opens the breaker, so the outage is self-sustaining, not `cooldown`-long',
        );

        // The counter-case, so the mechanism is unambiguous: when a HEALTHY tenant happens to win
        // the probe, its success closes the breaker for everyone.
        const fresh = sharedSeam();
        for (let i = 0; i < 3; i++) await outcomeOf(() => fresh.call(BAD)({}));
        await fresh.clock.advance(30_000);
        const won = await outcomeOf(() => fresh.call('t1')({}));
        const next = await outcomeOf(() => fresh.call('t2')({}));
        checkSeq(
            '(d) when a HEALTHY tenant wins the probe',
            [won, next],
            ['ok', 'ok'],
        );
        note(
            '(d) → recovery is a race between the broken tenant and a healthy one',
            'and the broken tenant is retrying harder by construction',
        );
    }

    // ── (e) the key the breaker is actually stored under ───────────────────────────────────────
    // The measurement that decides C2 as well: the principal is nowhere in it.
    {
        const { store, call } = sharedSeam();
        await outcomeOf(() => call('t1')({}));
        await outcomeOf(() => call('t2')({}));
        checkSeq(
            '(e) circuit keys touched by 2 DIFFERENT tenants',
            store.keys('circuit:'),
            ['circuit:/v1/items'],
        );
        check(
            '(e) does the key contain a principal?',
            store
                .keys('circuit:')
                .some((k) => k.includes('t1') || k.includes('t2')),
            false,
        );
        note(
            '(e) → the breaker key is `circuit:` + `opts.key ?? hostKey(req, cfg)`',
            'resilience.ts:353 over engine.ts:860; `hostKey` is `cfg.name ?? cfg.path ?? "stitch"` (engine.ts:140,265-274) — `AuthContext.principal` never reaches it',
        );
    }

    finish(
        'C1',
        'CONFIRMED, and worse than the capture predicts. One tenant with a revoked credential and a `circuit: { failures: 3, cooldown: "30s" }` on the shared seam failed 9 of 9 healthy tenants — a blast radius of 100% — and 0 of their requests ever reached the vendor: they fast-failed in-process with `StitchError` status 503, message "circuit open", carrying nothing that names the tenant responsible. THE UNPREDICTED PART IS THAT THE OUTAGE DOES NOT END. Half-open admits exactly ONE trial call (resilience.ts:375-379) and the broken tenant is the one retrying hardest, so across 4 full cooldown windows (120 virtual seconds) the healthy tenant measured 503,503,503,503; recovery happens only when a healthy tenant happens to win the probe, which is a race, not a policy. `seam.as(principal)` does not participate: two different principals touched the single key `circuit:/v1/items`, because the breaker keys on `opts.key ?? hostKey(req, cfg)` = `cfg.name ?? cfg.path ?? "stitch"` (resilience.ts:353, engine.ts:140,265-274,860) and the principal never reaches the resilience layer',
    );
}

void main();
