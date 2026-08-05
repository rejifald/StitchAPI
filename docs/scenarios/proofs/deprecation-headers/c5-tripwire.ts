// C5 — the deliberate tripwire: can a call be made to FAIL after a chosen sunset date and not
// before, on an injected clock? Which seam?
//
// Yes, and the seam is `Surface.interpret` — the same one C1 found the headers on. It returns
// `SurfaceOutcome`, and the `{ ok: false, message, status }` arm fails the call, so reading the
// header and rendering the verdict happen in one place with the stitch's own `clock` in scope
// (`cfg.clock`, measured below).
//
// The library treats a surface-rejected 200 correctly on both axes that matter for a tripwire:
// it does NOT burn retry attempts (no `retry: true` on the outcome, so no re-attempt), and it does
// NOT count against the circuit breaker — `classifyStatus` rules on the STATUS, and a 200 the
// surface rejected is an application-level verdict on a healthy transport (surface.ts:124-141).
// Both measured, because a tripwire that opens a breaker takes down the endpoints that are fine.
//
// RFC 9745 is explicit that deprecation is a hint, not a guarantee, so this is never a default.
// It is for a deadline you have decided to enforce — and the grace-period variant in (g) enforces
// one you chose rather than one the vendor chose.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c5-tripwire.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Clock,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { deprecationSurface, readNotice } from './deprecation';
import { BASE, DAY, endpoint, headersFor, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';

const USERS = endpoint('users');
const CLEAN = endpoint('payments');
/** The instant `users` stops answering, per its `Sunset` header. */
const SUNSET = Date.parse('2026-01-01T00:00:00Z');

/** One call against `users` through the tripwire surface, on a clock pinned to `at`. */
async function callAt(
    at: number,
): Promise<{ ok: boolean; message: string | undefined }> {
    const r = await stitch({
        name: 'users',
        url: `${BASE}/v1/users`,
        adapter: serving(USERS),
        kind: deprecationSurface({ failAfterSunset: true }),
        clock: manualClock(at),
        retry: { attempts: 1 },
    }).safe();
    return { ok: r.ok, message: r.error?.message };
}

async function main(): Promise<void> {
    heading('C5 — fail after a chosen sunset, and not before');

    // ── (a) the crossing ─────────────────────────────────────────────────────────────────────
    {
        const before = await callAt(SUNSET - DAY);
        const after = await callAt(SUNSET + DAY);
        check('(a) one day BEFORE sunset — ok', before.ok, true);
        check('(a) …with no error', before.message, undefined);
        check('(a) one day AFTER sunset — ok', after.ok, false);
        check(
            '(a) …and the message names the endpoint and the date',
            after.message,
            'users: sunset passed (2026-01-01T00:00:00.000Z)',
        );
        note(
            '(a) → same stitch, same vendor, same 200 on the wire. The only thing that changed is the clock',
        );
    }

    // ── (b) the boundary is exact, to the millisecond ────────────────────────────────────────
    {
        const spine = await Promise.all(
            [SUNSET - 1, SUNSET, SUNSET + 1].map(async (t) =>
                (await callAt(t)).ok ? 'ok' : 'FAILED',
            ),
        );
        checkSeq('(b) [sunset-1ms, sunset, sunset+1ms]', spine, [
            'ok',
            'FAILED',
            'FAILED',
        ]);
        note(
            '(b) → `>=` at the boundary, which is the right reading of "the resource is expected to become unresponsive AT this instant"',
        );
    }

    // ── (c) `cfg.clock` really is the stitch's injected clock ───────────────────────────────
    {
        let sawInSurface = -1;
        const probe: Surface = {
            id: 'clock-probe',
            interpret: (res, cfg) => {
                sawInSurface = cfg.clock?.now() ?? -1;
                return { ok: true, data: res.body };
            },
        };
        const clock: Clock = manualClock(SUNSET - 5 * DAY);
        await stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: serving(USERS),
            kind: probe,
            clock,
        })();
        check(
            '(c) `cfg.clock.now()` inside `interpret`',
            sawInSurface,
            clock.now(),
        );
        check(
            '(c) …which is 5 days before sunset',
            SUNSET - sawInSurface,
            5 * DAY,
        );
        note(
            '(c) → `ResolvedStitchConfig` carries `clock` (types.ts:1582), so the tripwire never reads wall-clock time and a test never waits',
        );
    }

    // ── (d) a clean endpoint is never tripped ────────────────────────────────────────────────
    {
        const r = await stitch({
            name: 'payments',
            url: `${BASE}/v1/payments`,
            adapter: serving(CLEAN),
            kind: deprecationSurface({ failAfterSunset: true }),
            clock: manualClock(SUNSET + 365 * DAY),
        }).safe();
        check("(d) a year past the OTHER endpoint's sunset", r.ok, true);
        check(
            '(d) …because it announced none',
            readNotice(headersFor(CLEAN)),
            null,
        );
    }

    // ── (e) the tripwire does NOT burn retry attempts ────────────────────────────────────────
    {
        let requests = 0;
        const r = await stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: async () => {
                requests += 1;
                return {
                    status: 200,
                    headers: headersFor(USERS),
                    body: USERS.body,
                };
            },
            kind: deprecationSurface({ failAfterSunset: true }),
            clock: manualClock(SUNSET + DAY),
            retry: { attempts: 5, backoff: { curve: 'fixed', base: 0 } },
        }).safe();
        check('(e) ok', r.ok, false);
        check('(e) requests made, with 5 attempts allowed', requests, 1);
        note(
            '(e) → the `{ ok: false, message }` arm is terminal. `SurfaceOutcome` has a separate `{ ok: false, retry: true }` arm (surface.ts:34-37) for body-aware retry, and not asking for it means not getting it',
        );
    }

    // ── (f) …and it does NOT open the circuit breaker ────────────────────────────────────────
    // A tripwire that trips the breaker would fast-fail every OTHER call sharing the key, which is
    // the opposite of what a deprecation guard is for.
    {
        let requests = 0;
        const call = stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: async () => {
                requests += 1;
                return {
                    status: 200,
                    headers: headersFor(USERS),
                    body: USERS.body,
                };
            },
            kind: deprecationSurface({ failAfterSunset: true }),
            clock: manualClock(SUNSET + DAY),
            retry: { attempts: 1 },
            circuit: { failures: 2, cooldown: '30s', key: 'tripwire-test' },
        });
        const outcomes: string[] = [];
        for (let i = 0; i < 5; i += 1) {
            const r = await call.safe();
            outcomes.push(r.error?.message ?? 'ok');
        }
        check('(f) requests that reached the vendor', requests, 5);
        checkSeq(
            '(f) distinct outcomes over 5 calls past a `failures: 2` breaker',
            [...new Set(outcomes)],
            ['users: sunset passed (2026-01-01T00:00:00.000Z)'],
        );
        note(
            '(f) → five consecutive failures and the breaker never opened, so no "circuit open" ever replaced the real message. `classifyStatus` rules on the STATUS and the transport was healthy the whole time (surface.ts:124-141)',
        );
    }

    // ── (g) the deadline you chose, not the one the vendor chose ─────────────────────────────
    // A 14-day grace: fail while there is still time to fix it, in a staging environment, rather
    // than on the morning the endpoint disappears.
    {
        const grace = 14 * DAY;
        const early: Surface = {
            id: 'sunset-grace',
            interpret: (res, cfg) => {
                const n = readNotice(res.headers);
                if (n?.sunsetAt == null) return { ok: true, data: res.body };
                const left = n.sunsetAt - (cfg.clock?.now() ?? 0);
                if (left <= grace)
                    return {
                        ok: false,
                        message: `${cfg.name ?? 'stitch'}: sunset in ${String(Math.round(left / DAY))} days — under the ${String(grace / DAY)}-day grace`,
                        status: res.status,
                    };
                return { ok: true, data: res.body };
            },
        };
        const at = async (t: number): Promise<string> => {
            const r = await stitch({
                name: 'users',
                url: `${BASE}/v1/users`,
                adapter: serving(USERS),
                kind: early,
                clock: manualClock(t),
                retry: { attempts: 1 },
            }).safe();
            return r.error?.message ?? 'ok';
        };
        checkSeq(
            '(g) 20 / 14 / 10 days out',
            [
                await at(SUNSET - 20 * DAY),
                await at(SUNSET - 14 * DAY),
                await at(SUNSET - 10 * DAY),
            ],
            [
                'ok',
                'users: sunset in 14 days — under the 14-day grace',
                'users: sunset in 10 days — under the 14-day grace',
            ],
        );
        note(
            '(g) → the countdown is in the failure message, so the thing that breaks the build also says how long you had',
        );
    }

    // ── (h) what the failure looks like on every accessor ────────────────────────────────────
    {
        const events: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'error') events.push(`error:${e.message}`);
                else events.push(e.type);
            },
        };
        const call = stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: serving(USERS),
            kind: deprecationSurface({ failAfterSunset: true }),
            clock: manualClock(SUNSET + DAY),
            retry: { attempts: 1 },
            trace: sink,
        });
        const safe = await call.safe();
        check(
            '(h) `.safe()` message',
            safe.error?.message,
            'users: sunset passed (2026-01-01T00:00:00.000Z)',
        );
        check(
            "(h) `.safe()` status — the vendor's, preserved",
            safe.error?.status,
            200,
        );
        checkSeq('(h) event spine of a tripped call', events, [
            'start',
            'progress',
            'error:users: sunset passed (2026-01-01T00:00:00.000Z)',
            'done',
        ]);
        let threw = '';
        try {
            await call();
        } catch (e) {
            threw = (e as Error).message;
        }
        check(
            '(h) the bare await throws',
            threw,
            'users: sunset passed (2026-01-01T00:00:00.000Z)',
        );
        note(
            '(h) → a `status: 200` on a `StitchError` is the honest record: the transport succeeded and a policy rejected it. Anything reading `error.status >= 500` will not see this, which is the point',
        );
    }

    finish(
        'C5',
        'YES, EXACTLY, AND THE SEAM IS `Surface.interpret`. Its `{ ok: false, message, status }` arm fails the call, and `cfg.clock` is the stitch\'s injected clock, so the crossing is deterministic to the millisecond: `[sunset-1ms, sunset, sunset+1ms]` measured `["ok","FAILED","FAILED"]`, and the same stitch against the same 200 passed a day before and failed a day after. The failure message names the endpoint and the date (`users: sunset passed (2026-01-01T00:00:00.000Z)`), reaches `.safe()`, the thrown error and the `error` event, and carries `status: 200` — the honest record that the transport was fine and a policy rejected it. Two behaviours make it safe to deploy, both measured: it does NOT burn retry attempts (5 attempts configured, 1 request made — the `{ ok: false, retry: true }` arm is opt-in) and it does NOT open the circuit breaker (5 consecutive trips past `failures: 2` and every message was still the real one, because `classifyStatus` rules on the status and the transport was healthy). A clean endpoint a year past someone else\'s sunset never trips. The grace-period variant enforces a deadline YOU chose and puts the countdown in the message (`sunset in 10 days — under the 14-day grace`)',
    );
}

void main();
