// C4 — can resilience be tested with NO vendor at all?
//
// This is the claim the testing kit is built for, and it is the one it answers best. Attempt
// counts, circuit transitions and throttle spacing are all assertable offline, deterministically,
// with zero real waiting: `mockAdapter` supplies the responses, `manualClock` supplies the time,
// and `collectStitchEvents` drains the event stream into something you can compare.
//
// The interesting part is where the event stream STOPS carrying what you would want to assert.
// Measured: a `progress` event carries `waited` for a throttle wait and for a stream reconnect, but
// NOT for a retry backoff — so "the second attempt waited 2000ms" is not readable from events. It
// is recoverable, but only by reading `clock.now()` yourself, which means the backoff assertion is
// the one resilience assertion the kit does not hand you.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c4-resilience-events.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/test-clock';
import { collectStitchEvents } from '../../../../packages/core/src/test-events';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import type { StitchEvent } from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import { BASE } from './vendor';

/** Drain an event stream while driving the clock, so a backoff resolves without real waiting. */
async function drainUnderClock<T>(
    gen: AsyncIterable<StitchEvent<T>>,
    clock: { advance(ms: number): Promise<void> },
    stepMs: number,
    steps: number,
): Promise<StitchEvent<T>[]> {
    const events: StitchEvent<T>[] = [];
    const it = gen[Symbol.asyncIterator]();
    for (;;) {
        const nextP = it.next();
        // Race the pull against the clock: whichever the engine is waiting on, advancing frees it.
        let settled = false;
        void nextP.then(() => {
            settled = true;
        });
        for (let i = 0; i < steps && !settled; i++) await clock.advance(stepMs);
        const r = await nextP;
        if (r.done) break;
        events.push(r.value);
    }
    return events;
}

async function main(): Promise<void> {
    heading('C4 (a) — attempt counts, with no vendor');
    {
        const clock = manualClock();
        const api = mockAdapter([
            {
                match: '/flaky',
                respond: [
                    { status: 503 },
                    { status: 503 },
                    { body: { ok: true } },
                ],
            },
        ]);
        const call = stitch({
            url: `${BASE}/flaky`,
            adapter: api,
            retry: { attempts: 3, backoff: { curve: 'expo', base: 1000 } },
            clock,
        });
        const events = await drainUnderClock(call().stream(), clock, 1000, 20);
        const c = await collectStitchEvents(
            (async function* () {
                for (const e of events) yield e;
            })(),
        );
        checkSeq('the event spine', c.types, [
            'start',
            'progress',
            'progress',
            'progress',
            'progress',
            'progress',
            'result',
            'done',
        ]);
        check('requests the transport saw', api.callCount(), 3);
        check(
            'the `result` event reports attempts',
            (c.events.find((e) => e.type === 'result') as { attempts: number })
                .attempts,
            3,
        );
        check('done.ok', c.done?.ok, true);
        checkSeq(
            'the progress phases',
            c.events
                .filter((e) => e.type === 'progress')
                .map((e) => (e as { phase: string }).phase),
            ['request', 'retry', 'request', 'retry', 'request'],
        );
        note(
            '(a) → attempts are assertable three ways: `mockAdapter.callCount()`, `result.attempts`, and the count of `progress{phase:"request"}` events',
            '',
        );
    }

    heading('C4 (b) — backoff DELAYS: what the events carry');
    {
        const clock = manualClock();
        const api = mockAdapter([
            {
                match: '/flaky',
                respond: [
                    { status: 503 },
                    { status: 503 },
                    { body: { ok: true } },
                ],
            },
        ]);
        const call = stitch({
            url: `${BASE}/flaky`,
            adapter: api,
            retry: {
                attempts: 3,
                backoff: { curve: 'expo', base: 1000 },
                respect: false,
            },
            clock,
        });
        // Record VIRTUAL time at each request the transport receives — the honest measurement of
        // spacing, since the events do not carry it.
        const at: number[] = [];
        const spy = mockAdapter([
            {
                match: '/flaky',
                respond: (c) => {
                    at.push(clock.now());
                    return c.index < 2
                        ? { status: 503 }
                        : { body: { ok: true } };
                },
            },
        ]);
        const spied = stitch({
            url: `${BASE}/flaky`,
            adapter: spy,
            retry: {
                attempts: 3,
                backoff: { curve: 'expo', base: 1000 },
                respect: false,
            },
            clock,
        });
        void spied.safe();
        await clock.advance(100_000);

        const events = await drainUnderClock(call().stream(), clock, 1000, 40);
        const retryProgress = events.filter(
            (e) => e.type === 'progress' && e.phase === 'retry',
        ) as { waited?: number; detail?: string }[];
        check('retry `progress` events', retryProgress.length, 2);
        checkSeq(
            '…and the `waited` each carries',
            retryProgress.map((e) => e.waited),
            [undefined, undefined],
        );
        checkSeq(
            '…what they DO carry',
            retryProgress.map((e) => e.detail),
            ['status 503', 'status 503'],
        );
        checkSeq('virtual time at each request', at, [0, 1000, 3000]);
        checkSeq(
            'the gaps, derived',
            at.slice(1).map((t, i) => t - (at[i] as number)),
            [1000, 2000],
        );
        note(
            '(b) → the `expo` curve is EXACT under a manual clock — 1000 then 2000 — but it is readable only from `clock.now()`. `progress{phase:"retry"}` carries `detail` and no `waited`, so the backoff delay is the one resilience number the event stream does not report (engine.ts:682-688 omits it; engine.ts:641 and :1486 set it for throttle and reconnect)',
            '',
        );
    }

    heading('C4 (c) — throttle spacing DOES carry `waited`');
    {
        const clock = manualClock();
        const api = mockAdapter([{ respond: { body: { ok: true } } }]);
        const call = stitch({
            url: `${BASE}/paced`,
            adapter: api,
            throttle: '2/s', // a 500ms minimum spacing
            clock,
        });
        const seen: number[] = [];
        const waits: (number | undefined)[] = [];
        for (let i = 0; i < 3; i++) {
            void (async () => {
                for await (const e of call().stream()) {
                    if (e.type === 'progress' && e.phase === 'throttled') {
                        waits.push(e.waited);
                    }
                    if (e.type === 'progress' && e.phase === 'request')
                        seen.push(clock.now());
                }
            })();
        }
        await clock.advance(5000);
        checkSeq('virtual time at each request', seen, [0, 500, 1000]);
        checkSeq('the `waited` the throttle reported', waits, [500, 1000]);
        note(
            "(c) → `'2/s'` is a 500ms minimum spacing (ADR 0023), and both the spacing and the reported wait are exact. This is the assertion the kit does hand you",
            '',
        );
    }

    heading(
        'C4 (d) — circuit transitions: closed -> open -> half-open -> closed',
    );
    {
        const clock = manualClock();
        let mode: 'fail' | 'heal' = 'fail';
        const api = mockAdapter([
            {
                respond: () =>
                    mode === 'fail' ? { status: 500 } : { body: { ok: true } },
            },
        ]);
        const call = stitch({
            url: `${BASE}/breaker`,
            adapter: api,
            circuit: { failures: 2, cooldown: 30_000 },
            clock,
        });
        const transitions: string[] = [];

        await call.safe();
        transitions.push(`after 1 failure: calls=${String(api.callCount())}`);
        await call.safe();
        transitions.push(`after 2 failures: calls=${String(api.callCount())}`);

        const blocked = await call.safe();
        transitions.push(
            `while OPEN: calls=${String(api.callCount())} err=${blocked.error?.name ?? ''}`,
        );

        await clock.advance(30_000);
        mode = 'heal';
        const probe = await call.safe();
        transitions.push(
            `after cooldown: calls=${String(api.callCount())} ok=${String(probe.ok)}`,
        );

        const after = await call.safe();
        transitions.push(
            `once CLOSED: calls=${String(api.callCount())} ok=${String(after.ok)}`,
        );

        checkSeq('the full transition trace', transitions, [
            'after 1 failure: calls=1',
            'after 2 failures: calls=2',
            'while OPEN: calls=2 err=StitchError',
            'after cooldown: calls=3 ok=true',
            'once CLOSED: calls=4 ok=true',
        ]);
        check(
            'the open circuit blocked the request entirely',
            blocked.error?.message,
            'circuit open',
        );
        note(
            '(d) → every transition is assertable by `callCount()` alone: the OPEN state is visible because the transport count does NOT move. No vendor, no waiting',
            '',
        );
    }

    heading(
        'C4 (e) — what a `done` event actually carries under a manual clock',
    );
    {
        const clock = manualClock();
        const api = mockAdapter([{ respond: { body: { ok: true } } }]);
        const call = stitch({ url: `${BASE}/x`, adapter: api, clock });
        const c = await collectStitchEvents(call());
        const done = c.events.find((e) => e.type === 'done') as {
            elapsed: number;
            attempts: number;
            at: number;
        };
        check('done.attempts', done.attempts, 1);
        check('done.elapsed under a manual clock', done.elapsed, 0);
        check('clock.now()', clock.now(), 0);
        note('done.at (a wall-clock epoch read)', done.at);
        note(
            "(e) → `elapsed` is wall-clock (C2 row 9), so under `manualClock` it reads 0 no matter how much virtual time the call consumed. An assertion like `expect(done.elapsed).toBeGreaterThan(3000)` after advancing 5s FAILS — the kit's own duration field cannot see the kit's own clock",
            '',
        );
    }

    heading('C4 (f) — the CollectedEvents surface');
    {
        const api = mockAdapter([{ respond: { status: 500, body: { e: 1 } } }]);
        const call = stitch({ url: `${BASE}/bad`, adapter: api });
        const c = await collectStitchEvents(call());
        checkSeq('fields', Object.keys(c).sort(), [
            'deltas',
            'done',
            'drifts',
            'error',
            'events',
            'result',
            'types',
        ]);
        check('error.message', c.error?.message, 'HTTP 500');
        check('error.status', c.error?.status, 500);
        check('done.ok', c.done?.ok, false);
        check('result', c.result, undefined);
        note(
            '(f) → `collectStitchEvents` accepts the `StitchResult` directly (no `.stream()` call needed) and reduces it to 7 fields. `error` is flattened to `{message,status}`; the full event is still in `events`',
            '',
        );
    }

    finish(
        'C4',
        'CONFIRMED, WITH ONE GAP AND ONE TRAP. Resilience is fully testable with no vendor and no real waiting. Attempt counts: assertable three ways (`mockAdapter.callCount()` = 3, `result.attempts` = 3, five `progress` events phased `request,retry,request,retry,request`). Circuit transitions: the whole closed->open->half-open->closed trace is readable from `callCount()` — 1, 2, 2 (blocked, a plain `StitchError` whose message is "circuit open" — the breaker has no distinct error NAME to assert on), 3 (probe after `advance(30_000)`), 4 — because an open circuit does not move the transport count. Throttle spacing: exact, and self-reporting — requests at virtual 0/500/1000 for `\'2/s\'`, with `progress{phase:"throttled"}.waited` reading 500 then 1000. THE GAP: retry backoff delays are exact under the clock (requests at virtual 0/1000/3000, gaps 1000 and 2000 for an `expo` base-1000 curve) but are NOT in the event stream — `progress{phase:"retry"}` carries `detail: "status 503"` and `waited: undefined`, where the throttle and reconnect paths do set `waited`. You can assert the backoff, but only by reading `clock.now()` yourself. THE TRAP: `done.elapsed` is wall-clock, so it reads 0 after any amount of virtual time — the kit\'s own duration field cannot see the kit\'s own clock',
    );
}

void main();
