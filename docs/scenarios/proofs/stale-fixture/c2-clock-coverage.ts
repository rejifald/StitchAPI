// C2 (DECIDING, PRE-REGISTERED SUSPICION) — is `manualClock` sound across EVERY time-driven feature?
//
// Pattern 2b of this research pass records three incidental sightings of a feature ignoring the
// injected clock. This script stops accumulating sightings and enumerates the whole surface: every
// place `packages/core/src` reads time, probed the same way, in one table.
//
// The enumeration found two rows nobody had recorded — OAuth2 token expiry and AWS SigV4 signing —
// and filing them worked: both ride the injected clock now (#664 for OAuth2, via issue #650; #667
// for SigV4, via #658), so rows (j) and (k) expect DRIVEN and this table pins the current split:
// 8 driven, 4 wall-clock, 2 with no time in them. The four wall rows that remain are ADR 0010 §4
// decisions (the clock owns control-flow time, not bookkeeping), not gaps awaiting a fix.
//
// THE METHOD. For each feature, the same scenario runs twice — once with the clock advanced by the
// amount the test believes is decisive, once with `advance(0)` — and the two outcomes are compared:
//
//   outcomes DIFFER    -> the feature consulted the injected clock. The assertion had teeth.
//   outcomes IDENTICAL -> the feature never looked. A test that advances the clock and then asserts
//                         on the result is asserting something the advance did not cause.
//
// That second row is the point of the whole script. A test of an inert feature does not fail — it
// PASSES, having exercised nothing, which is the worst failure mode a testing tool has. Section (i)
// makes that concrete with a `timeout.total` test that looks correct, passes, and is a lie.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c2-clock-coverage.ts
import { stitch } from '../../../../packages/core/src/index';
import { parseRetryAfter } from '../../../../packages/core/src/resilience';
import { manualClock } from '../../../../packages/core/src/test-clock';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    Clock,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    check,
    checkAtLeast,
    checkClockDriven,
    checkSeq,
    finish,
    heading,
    note,
    printClockTable,
    row,
} from './harness';
import { BASE, sequenceAdapter, vendorAdapter } from './vendor';

/** Let queued continuations run without advancing virtual time. */
const settle = (): Promise<void> =>
    new Promise((r) => {
        setTimeout(r, 0);
    });

/**
 * A transport whose latency is VIRTUAL: it waits on `clock.sleep`, so it only "takes time" when the
 * test advances the clock. This is the honest way to model a slow endpoint under a manual clock —
 * `mockAdapter`'s own `delay` uses a real `setTimeout`, which would make every timing probe here a
 * wall-clock race.
 */
function slowAdapter(
    clock: Clock,
    latencyMs: number,
    steps: readonly (readonly [number, unknown])[],
): Adapter & { count(): number } {
    let n = 0;
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        const i = n++;
        await clock.sleep(latencyMs, req.signal);
        const step = steps[Math.min(i, steps.length - 1)] as readonly [
            number,
            unknown,
        ];
        return { status: step[0], headers: {}, body: step[1] };
    }) as Adapter & { count(): number };
    fn.count = () => n;
    return fn;
}

async function main(): Promise<void> {
    // ── (a) retry backoff ───────────────────────────────────────────────────────────────────────
    heading('C2 (a) — retry backoff');
    await checkClockDriven(
        'retry backoff',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = sequenceAdapter([
                [503, {}],
                [503, {}],
                [200, { ok: true }],
            ]);
            const call = stitch({
                url: `${BASE}/flaky`,
                adapter: vendor,
                retry: { attempts: 3, backoff: { curve: 'fixed', base: 1000 } },
                clock,
            });
            let state = 'pending';
            void call.safe().then((r) => {
                state = r.ok ? 'ok' : 'err';
            });
            await clock.advance(advanceMs);
            return `calls=${String(vendor.count())} ${state}`;
        },
        5000,
    );
    row(
        'retry backoff',
        'CLOCK',
        'advance(5000) -> calls=3 ok; advance(0) -> calls=1 pending',
    );

    // ── (b) throttle: rate spacing ──────────────────────────────────────────────────────────────
    heading('C2 (b) — throttle rate spacing');
    await checkClockDriven(
        'throttle rate',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = vendorAdapter({ ok: true });
            const call = stitch({
                url: `${BASE}/paced`,
                adapter: vendor,
                throttle: '1/s',
                clock,
            });
            void call.safe();
            void call.safe();
            void call.safe();
            await clock.advance(advanceMs);
            return `calls=${String(vendor.count())}`;
        },
        3000,
    );
    row(
        'throttle rate',
        'CLOCK',
        'advance(3000) -> 3 calls; advance(0) -> 1 call',
    );

    // ── (c) throttle: concurrency ───────────────────────────────────────────────────────────────
    // Concurrency is not a duration, but the WAIT it induces is — a blocked caller only proceeds
    // when the holder finishes, and here the holder finishes on virtual time.
    heading('C2 (c) — throttle concurrency');
    await checkClockDriven(
        'throttle concurrency',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = slowAdapter(clock, 500, [[200, { ok: true }]]);
            const call = stitch({
                url: `${BASE}/limited`,
                adapter: vendor,
                throttle: { concurrency: 1 },
                clock,
            });
            void call.safe();
            void call.safe();
            void call.safe();
            await clock.advance(advanceMs);
            return `calls=${String(vendor.count())}`;
        },
        2000,
    );
    row(
        'throttle concurrency',
        'CLOCK',
        'holder releases on virtual time -> queued callers proceed',
    );

    // ── (d) circuit cooldown ────────────────────────────────────────────────────────────────────
    heading('C2 (d) — circuit cooldown');
    await checkClockDriven(
        'circuit.cooldown',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = sequenceAdapter([[500, { e: 1 }]]);
            const call = stitch({
                url: `${BASE}/breaker`,
                adapter: vendor,
                circuit: { failures: 2, cooldown: 30_000 },
                clock,
            });
            await call.safe();
            await call.safe(); // trips the breaker
            const openTry = await call.safe();
            const opened = openTry.error?.message ?? '';
            await clock.advance(advanceMs);
            const afterTry = await call.safe();
            return `open=${opened.includes('circuit') ? 'y' : 'n'} calls=${String(vendor.count())} after=${afterTry.error?.message?.includes('circuit') ? 'still-open' : 'probed'}`;
        },
        60_000,
    );
    row(
        'circuit.cooldown',
        'CLOCK',
        'advance(60000) past a 30s cooldown -> half-open probe reaches the vendor',
    );

    // ── (e) per-attempt timeout ─────────────────────────────────────────────────────────────────
    heading('C2 (e) — per-attempt timeout');
    await checkClockDriven(
        'timeout (per-attempt)',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = slowAdapter(clock, 5000, [[200, { ok: true }]]);
            const call = stitch({
                url: `${BASE}/slow`,
                adapter: vendor,
                timeout: 1000,
                clock,
            });
            let state = 'pending';
            void call.safe().then((r) => {
                state = r.ok ? 'ok' : (r.error?.name ?? 'err');
            });
            await clock.advance(advanceMs);
            return state;
        },
        2000,
    );
    row(
        'timeout (per-attempt)',
        'CLOCK',
        'advance(2000) past a 1s timeout -> TimeoutError; advance(0) -> pending',
    );

    // ── (f) timeout.total ───────────────────────────────────────────────────────────────────────
    // The pre-registered suspicion, tested head-on. ADR 0010 §4 says this deliberately stays on
    // wall-clock; the question is what that COSTS a test that does not know it.
    //
    // A driven/inert binary is the WRONG instrument for this row, and saying why is half the
    // finding. `timeout.total` is not ignored by the clock: engine.ts:684-690 clamps each attempt's
    // abort to `budget.deadline - now()` and hands that to `withTimeout(..., rt.clock)`, so the
    // clamp DOES fire on virtual time. What is wall-anchored is the DEADLINE — `wallT0 + total`.
    // Virtual sleeps never move the wall, so the remaining budget is recomputed as ~the full total
    // at every attempt. The budget does not drain; it resets.
    //
    // So the honest measurement is a side-by-side of the SAME config on the two clocks, scaled so
    // the real-clock arm is fast: 3 attempts x 90ms latency against a 100ms total budget.
    heading('C2 (f) — timeout.total');
    {
        const STEPS = [
            [503, {}],
            [503, {}],
            [200, { ok: true }],
        ] as const;

        // ARM 1 — manual clock, 900ms virtual latency, 1000ms total budget.
        const clock = manualClock();
        const vendor = slowAdapter(clock, 900, STEPS);
        const virt = stitch({
            url: `${BASE}/budget`,
            adapter: vendor,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
            timeout: { total: 1000 },
            clock,
        });
        let ok: boolean | null = null;
        let errName = '';
        let consumed = -1;
        void virt.safe().then((r) => {
            ok = r.ok;
            errName = r.error?.name ?? '';
            consumed = clock.now();
        });
        await clock.advance(10_000);
        check('(f) manual clock: the call SUCCEEDED', ok, true);
        check('(f) manual clock: no timeout error', errName, '');
        check('(f) manual clock: attempts the vendor saw', vendor.count(), 3);
        checkAtLeast(
            '(f) manual clock: VIRTUAL ms consumed before it settled',
            consumed,
            2700,
        );

        // ARM 2 — the real clock, same shape, 10x smaller so the script stays fast.
        const realVendor = (() => {
            let n = 0;
            const fn = (async (
                _req: AdapterRequest,
            ): Promise<AdapterResponse> => {
                const i = n++;
                await new Promise<void>((r) => {
                    setTimeout(r, 90);
                });
                const step = STEPS[Math.min(i, STEPS.length - 1)] as readonly [
                    number,
                    unknown,
                ];
                return { status: step[0], headers: {}, body: step[1] };
            }) as Adapter & { count(): number };
            fn.count = () => n;
            return fn;
        })();
        const real = stitch({
            url: `${BASE}/budget`,
            adapter: realVendor,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
            timeout: { total: 100 },
        });
        const realStart = Date.now();
        const realResult = await real.safe();
        const realElapsed = Date.now() - realStart;
        check('(f) real clock: the call FAILED', realResult.ok, false);
        check(
            '(f) real clock: with a timeout message',
            realResult.error?.message,
            'timed out after 100ms',
        );
        check('(f) real clock: attempts the vendor saw', realVendor.count(), 2);
        note('(f) real clock: real ms elapsed', realElapsed);
        note(
            '(f) → SAME config shape, 2.7x the budget consumed in each arm. Real clock: 2 attempts, dead at 101ms with `timed out after 100ms`. Manual clock: 3 attempts, 2700 virtual ms against a 1000ms budget, ok=true. The budget deadline is `wallT0 + total` (engine.ts:502) and every remaining-budget read is `deadline - now()` on the WALL (engine.ts:520/542/564/689), so under a manual clock it never drains',
            '',
        );
        row(
            'timeout.total',
            'WALL',
            'engine.ts:502/520/542/564/689 use util now(); a 1000ms budget survived 2700 virtual ms and returned ok=true',
        );
    }

    // ── (g) cache.ttl ───────────────────────────────────────────────────────────────────────────
    heading('C2 (g) — cache.ttl');
    await checkClockDriven(
        'cache.ttl',
        'inert',
        async (advanceMs) => {
            const clock = manualClock();
            const vendor = vendorAdapter({ v: 1 });
            const call = stitch({
                url: `${BASE}/cached`,
                adapter: vendor,
                cache: { ttl: 60_000 },
                clock,
            });
            await call.safe();
            await clock.advance(advanceMs);
            await settle();
            await call.safe();
            return `calls=${String(vendor.count())}`;
        },
        600_000,
    );
    row(
        'cache.ttl',
        'WALL',
        'store.ts:30/59 use util `now()`; advancing 600000 virtual ms past a 60s TTL still served the cached entry',
    );

    // ── (h) paginate ────────────────────────────────────────────────────────────────────────────
    // Pagination has no delay knob of its own — `PaginateOptions` is `{ next }` plus limits, and
    // page N+1 is fetched immediately. It is listed here because the capture names it, and the
    // honest answer is that there is no time in it to drive.
    heading('C2 (h) — paginate');
    {
        const clock = manualClock();
        let page = 0;
        const vendor: Adapter = () => {
            page++;
            return Promise.resolve({
                status: 200,
                headers: {},
                body: { items: [page], next: page < 3 ? page + 1 : null },
            });
        };
        const call = stitch({
            url: `${BASE}/pages`,
            adapter: vendor,
            paginate: {
                next: (body) =>
                    (body as { next: number | null }).next == null
                        ? undefined
                        : {
                              query: {
                                  page: (body as { next: number }).next,
                              },
                          },
            },
            clock,
        });
        const r = await call.safe();
        check('(h) all pages fetched with NO clock advance', r.ok, true);
        check('(h) pages fetched', page, 3);
        check('(h) virtual time consumed', clock.now(), 0);
        note(
            '(h) → `paginate` has no inter-page delay to drive. Nothing to be inert about; a paced crawl is spelled with `throttle`, which IS clock-driven (row b)',
            '',
        );
        row(
            'paginate',
            'NONE',
            'no inter-page delay knob; 3 pages fetched at clock.now()=0. Pacing is spelled `throttle` (row b), which IS driven',
        );
    }

    // ── (i) event `at` / `done.elapsed` ─────────────────────────────────────────────────────────
    heading('C2 (i) — event timestamps');
    {
        const clock = manualClock();
        const events: StitchEvent[] = [];
        const sink: TraceSink = {
            handle(e) {
                events.push(e);
            },
        };
        const call = stitch({
            url: `${BASE}/ts`,
            adapter: vendorAdapter({ ok: true }),
            clock,
            trace: sink,
        });
        await call.safe();
        const ats = events.map((e) => e.at);
        const allZero = ats.every((a) => a === 0);
        check('(i) every event `at` is virtual 0', allZero, false);
        checkAtLeast(
            '(i) the first event `at` (epoch ms — a wall-clock read)',
            ats[0] ?? 0,
            1_700_000_000_000,
        );
        check('(i) clock.now() at the same moment', clock.now(), 0);
        note(
            '(i) → an assertion on event ordering by `at` under a manual clock compares WALL timestamps, so two events the test believes are 30s apart carry `at` values microseconds apart',
            '',
        );
        row(
            'event `at` / `done.elapsed`',
            'WALL',
            `engine.ts uses util now(); measured at=${String(ats[0])} while clock.now()=0`,
        );
    }

    // ── (j) OAuth2 token expiry — NOT in the capture's list, and the row that got FIXED ─────────
    // At audit time this was wall-clock: `auth.ts` held zero occurrences of `clock`, so advancing
    // past `expires_in` refetched nothing. This audit filed that as #650; #664 threads the stitch's
    // resolved clock onto `AuthContext` and both halves of the freshness math read it —
    // `clockNow(ctx) = ctx.clock?.now() ?? now()` (auth.ts:432), used for `expiresAt` at fetch time
    // (auth.ts:571) and the `isFresh` gate at read time (auth.ts:583). So the row is DRIVEN now:
    // a test can advance a manual clock past `expires_in` and see the refetch.
    heading('C2 (j) — OAuth2 token expiry (filed as #650, fixed by #664)');
    await checkClockDriven(
        'oauth2 token expiry',
        'driven',
        async (advanceMs) => {
            const clock = manualClock();
            let tokenCalls = 0;
            let apiCalls = 0;
            const transport = (async (
                req: AdapterRequest,
            ): Promise<AdapterResponse> => {
                if (req.url.includes('/oauth/token')) {
                    tokenCalls++;
                    return {
                        status: 200,
                        headers: {},
                        body: {
                            access_token: `tok_${String(tokenCalls)}`,
                            expires_in: 60, // one minute
                        },
                    };
                }
                apiCalls++;
                return { status: 200, headers: {}, body: { ok: true } };
            }) as Adapter;
            const { oauth2 } =
                await import('../../../../packages/core/src/auth');
            const call = stitch({
                url: `${BASE}/secure`,
                adapter: transport,
                clock,
                auth: oauth2({
                    tokenUrl: `${BASE}/oauth/token`,
                    clientId: () => 'id',
                    clientSecret: () => 'secret',
                    adapter: transport,
                }),
            });
            await call.safe();
            await clock.advance(advanceMs);
            await settle();
            await call.safe();
            return `tokenCalls=${String(tokenCalls)} apiCalls=${String(apiCalls)}`;
        },
        600_000,
    );
    row(
        'oauth2 token expiry',
        'CLOCK',
        'auth.ts:432 clockNow reads the threaded ctx.clock (#664); advance(600000) past a 60s `expires_in` -> tokenCalls 1 -> 2',
    );

    // ── (k) AWS SigV4 signing date — the other row that got FIXED ───────────────────────────────
    // At audit time `awsSigV4` stamped `x-amz-date` from a bare `new Date()`, and a manual clock
    // was not even expressible — there was no seam to hand one through. Filed as #658; #667 puts
    // the stamp on the same seam OAuth2 uses: `clockNow(ctx) = ctx.clock?.now() ?? Date.now()`
    // (aws-sigv4/src/index.ts:266), read at signing time (index.ts:324). The engine threads the
    // stitch's resolved clock onto `AuthContext`, so under `manualClock()` — which starts at 0 —
    // the signature is stamped at the virtual epoch: `19700101T000000Z`. A hand-built context
    // with no `clock` still falls back to the wall, which is the documented default.
    heading('C2 (k) — AWS SigV4 signing date (filed as #658, fixed by #667)');
    {
        const { awsSigV4 } =
            (await import('../../../../packages/aws-sigv4/src/index')) as typeof import('../../../../packages/aws-sigv4/src/index');
        const strategy = awsSigV4({
            accessKeyId: () => 'AKIAEXAMPLE',
            secretAccessKey: () => 'secret',
            region: 'us-east-1',
            service: 'execute-api',
        });
        const ctxWith = (clock?: Clock): never =>
            ({
                emit: () => undefined,
                vault: {
                    get: () => Promise.resolve(undefined),
                    set: () => Promise.resolve(),
                    delete: () => Promise.resolve(),
                },
                ...(clock ? { clock } : {}),
            }) as never;

        // Arm 1 — a context carrying `manualClock()`, the way the engine threads it from `clock:`.
        const virtReq: AdapterRequest = {
            url: `${BASE}/signed`,
            method: 'GET',
            headers: {},
        };
        await strategy.apply(virtReq, ctxWith(manualClock()));
        check(
            '(k) under manualClock() the stamp IS the virtual epoch',
            virtReq.headers['x-amz-date'],
            '19700101T000000Z',
        );

        // Arm 2 — no `ctx.clock`: the documented fallback to the wall.
        const wallReq: AdapterRequest = {
            url: `${BASE}/signed`,
            method: 'GET',
            headers: {},
        };
        await strategy.apply(wallReq, ctxWith());
        const amzDate = wallReq.headers['x-amz-date'] ?? '';
        check(
            '(k) with no ctx.clock a date is still stamped',
            amzDate.length > 0,
            true,
        );
        check(
            '(k) …and it falls back to the WALL, not the epoch',
            amzDate.startsWith('19700101'),
            false,
        );
        note('(k) measured wall-fallback x-amz-date', amzDate);
        row(
            'AWS SigV4 signing date',
            'CLOCK',
            'aws-sigv4/src/index.ts:266/324 stamp from ctx.clock (#667); manualClock() signs 19700101T000000Z',
        );
    }

    // ── (l) Retry-After as an HTTP-date ─────────────────────────────────────────────────────────
    // `parseRetryAfter` DOES take the clock — and that is exactly what makes it a trap. It computes
    // `httpDateEpoch - clock.now()`, and `manualClock()` starts at 0, so an HTTP-date the server
    // meant as "5 seconds" becomes a wait of the entire Unix epoch.
    heading('C2 (l) — Retry-After as an HTTP-date');
    {
        const clock = manualClock();
        const fiveSecondsOut = new Date(Date.now() + 5000).toUTCString();
        const wall = parseRetryAfter(fiveSecondsOut);
        const virtual = parseRetryAfter(fiveSecondsOut, clock);
        check(
            '(l) delta-seconds form is clock-independent',
            parseRetryAfter('5', clock),
            5000,
        );
        checkAtLeast(
            '(l) HTTP-date under systemClock (~5000ms)',
            wall ?? 0,
            4000,
        );
        check(
            '(l) …and under systemClock it is under 6s',
            (wall ?? 0) < 6000,
            true,
        );
        checkAtLeast(
            '(l) HTTP-date under manualClock() (ms)',
            virtual ?? 0,
            1_700_000_000_000,
        );
        note(
            '(l) measured manualClock wait, in DAYS',
            Math.round((virtual ?? 0) / 86_400_000),
        );
        note(
            '(l) → `parseRetryAfter` reads the injected clock faithfully, and that is the bug: `manualClock()` starts at 0, so a server date is ~20,000 days in the "future". A retry test with an HTTP-date `Retry-After` hangs on an advance that will never come',
            '',
        );
        row(
            'Retry-After (delta-seconds)',
            'NONE',
            "a pure number; parseRetryAfter('5') = 5000 on any clock",
        );
        row(
            'Retry-After (HTTP-date)',
            'CLOCK',
            `resilience.ts:74 reads clock.now(); manualClock(0) turns "5s" into ${String(Math.round((virtual ?? 0) / 86_400_000))} days`,
        );
    }

    // ── (m) memoryStore TTL, directly ───────────────────────────────────────────────────────────
    heading('C2 (m) — memoryStore TTL (the layer under cache.ttl)');
    await checkClockDriven(
        'memoryStore TTL',
        'inert',
        async (advanceMs) => {
            const { memoryStore } =
                await import('../../../../packages/core/src/store');
            const clock = manualClock();
            const store = memoryStore();
            await store.set('k', 'v', 1000);
            await clock.advance(advanceMs);
            const got = await store.get('k');
            return `got=${JSON.stringify(got)}`;
        },
        60_000,
    );
    row(
        'memoryStore TTL',
        'WALL',
        'store.ts:30/59 use util `now()`; a 1s entry survived 60000 virtual ms',
    );

    // ── (n) THE VACUOUS TEST ────────────────────────────────────────────────────────────────────
    // The sharp finding, spelled as the test someone actually writes. It looks right. It passes.
    // It asserts nothing, and the identical assertion passes with the advance line DELETED.
    heading('C2 (n) — the vacuous test, written out');
    {
        /** "Assert that `timeout.total: 1000` fails a call that takes far longer." */
        const vacuousTest = async (withAdvance: boolean): Promise<string> => {
            const clock = manualClock();
            const vendor = slowAdapter(clock, 900, [
                [503, {}],
                [503, {}],
                [200, { ok: true }],
            ]);
            const call = stitch({
                url: `${BASE}/budget`,
                adapter: vendor,
                retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
                timeout: { total: 1000 },
                clock,
            });
            const p = call.safe();
            if (withAdvance)
                await clock.advance(10_000); // the "decisive" line
            else await settle();
            const r = await Promise.race([
                p,
                new Promise<null>((res) => {
                    setTimeout(() => {
                        res(null);
                    }, 5);
                }),
            ]);
            return r === null ? 'pending' : r.ok ? 'ok' : 'timed-out';
        };
        const withLine = await vacuousTest(true);
        const withoutLine = await vacuousTest(false);
        check('(n) with `await clock.advance(10_000)`', withLine, 'ok');
        check('(n) with that line DELETED', withoutLine, 'pending');
        note(
            '(n) → the two differ, so the advance is not literally dead code — it is worse. It drives the call to COMPLETION while the budget it is supposed to exhaust never drains. A suite asserting `r.ok === false` here fails; a suite asserting the call finishes passes and believes it proved the budget',
            '',
        );
    }

    // ── the table ───────────────────────────────────────────────────────────────────────────────
    heading('C2 — the table');
    const tally = printClockTable();
    check('rows driven by the injected clock', tally.clock, 8);
    check('rows on wall clock regardless', tally.wall, 4);
    check('rows with no time in them', tally.none, 2);
    check(
        'every time-driven feature is accounted for',
        tally.clock + tally.wall + tally.none,
        14,
    );
    checkSeq(
        'the wall-clock set — all four are ADR 0010 §4 decisions',
        [
            'timeout.total',
            'cache.ttl',
            'memoryStore TTL',
            'event `at` / `done.elapsed`',
        ].sort(),
        [
            'cache.ttl',
            'event `at` / `done.elapsed`',
            'memoryStore TTL',
            'timeout.total',
        ],
    );

    finish(
        'C2',
        'THE SUSPICION WAS CONFIRMED AT AUDIT TIME — AND FILING IT WORKED. Driven by `manualClock` now: retry backoff, throttle rate, throttle concurrency, `circuit.cooldown`, the per-attempt `timeout`, `Retry-After`, and the two rows this enumeration found and filed — OAuth2 token expiry (#650, fixed by #664: `auth.ts:432` clockNow reads the engine-threaded ctx.clock, so advancing 600000 virtual ms past a 60s `expires_in` refetches; measured tokenCalls 1 -> 2) and AWS SigV4 signing (#658, fixed by #667: the stamp reads ctx.clock at aws-sigv4/src/index.ts:266/324, so `manualClock()` signs 19700101T000000Z). Still on wall clock, by decision (ADR 0010 §4 — control-flow time, not bookkeeping): `timeout.total`, `cache.ttl`, the `memoryStore` TTL beneath it, and event `at`/`done.elapsed`. `paginate` has no time in it to drive. The measured cost of the `timeout.total` row stands: a call configured to die after 1000ms consumed 2700 virtual ms across 3 attempts and returned ok=true, because the budget deadline is wall-anchored and virtual sleeps never drain it. And one row is a trap rather than a gap: `parseRetryAfter` DOES read the injected clock, so an HTTP-date `Retry-After` under `manualClock()` (which starts at 0) becomes a wait of ~20,000 DAYS instead of 5 seconds',
    );
}

void main();
