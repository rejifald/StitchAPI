// Proves the pluggable store (DESIGN.md §13): a SHARED store makes session and throttle
// state shared across separate stitches (simulating two workers sharing Redis); the default
// in-memory store keeps them independent.
import { memoryStore, stitch } from '../src';
import type { Clock, Stitch, StitchStore } from '../src';
import { cookieSession, env } from '../src/auth';
import { createThrottle } from '../src/resilience';
import { createStoreThrottle } from '../src/store';
import type { Throttle } from '../src/store';
import { manualClock } from '../src/test-clock';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-store-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

const loginInput = () => ({
    body: { u: env('ST_USER')(), p: env('ST_PASS')() },
});

async function wasThrottled(s: Stitch): Promise<number> {
    let throttled = 0;
    for await (const ev of s.stream()) {
        if (
            ev.type === 'progress' &&
            ev.phase === 'throttled' &&
            (ev.waited ?? 0) > 0
        )
            throttled = 1;
    }
    return throttled;
}

describe('Pluggable store — sessions', () => {
    test('a SHARED store makes two stitches share one login', async () => {
        process.env['ST_USER'] = 'u';
        process.env['ST_PASS'] = 'p';
        server.route('POST', '/login', {
            setCookie: { name: 'SID', value: 'OK' },
            body: { ok: true },
        });
        server.route('GET', '/a', {
            requireCookie: { name: 'SID' },
            body: { r: 'a' },
        });
        server.route('GET', '/b', {
            requireCookie: { name: 'SID' },
            body: { r: 'b' },
        });
        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/login',
            wire: { body: 'form' },
        });
        const store = memoryStore();

        const a = stitch({
            baseUrl: server.url,
            path: '/a',
            store,
            auth: cookieSession({
                login,
                cookie: 'SID',
                key: 'svc',
                loginInput,
                tenancy: 'app', // standalone shared session (no principal bound)
            }),
        });
        const b = stitch({
            baseUrl: server.url,
            path: '/b',
            store,
            auth: cookieSession({
                login,
                cookie: 'SID',
                key: 'svc',
                loginInput,
                tenancy: 'app', // standalone shared session (no principal bound)
            }),
        });

        expect(await a()).toEqual({ r: 'a' });
        expect(await b()).toEqual({ r: 'b' });
        expect(server.callCount('/login')).toBe(1); // ONE login, reused via the shared store
        // The login posts a urlencoded body — pinned so a lost `wire.body` silently falls back
        // to JSON without a single test noticing.
        expect(server.calls('/login')[0]?.headers['content-type']).toMatch(
            /application\/x-www-form-urlencoded/,
        );
    });

    test('default (separate) stores → each stitch logs in independently', async () => {
        process.env['ST_USER'] = 'u';
        process.env['ST_PASS'] = 'p';
        server.route('POST', '/login', {
            setCookie: { name: 'SID', value: 'OK' },
            body: { ok: true },
        });
        server.route('GET', '/a', {
            requireCookie: { name: 'SID' },
            body: { r: 'a' },
        });
        server.route('GET', '/b', {
            requireCookie: { name: 'SID' },
            body: { r: 'b' },
        });
        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/login',
            wire: { body: 'form' },
        });

        const a = stitch({
            baseUrl: server.url,
            path: '/a',
            auth: cookieSession({
                login,
                cookie: 'SID',
                key: 'svc',
                loginInput,
                tenancy: 'app', // standalone shared session (no principal bound)
            }),
        });
        const b = stitch({
            baseUrl: server.url,
            path: '/b',
            auth: cookieSession({
                login,
                cookie: 'SID',
                key: 'svc',
                loginInput,
                tenancy: 'app', // standalone shared session (no principal bound)
            }),
        });

        await a();
        await b();
        expect(server.callCount('/login')).toBe(2); // separate in-memory stores → two logins
    });
});

describe('Pluggable store — throttle', () => {
    test('a SHARED store shares the rate budget across two stitches (one of two concurrent calls waits)', async () => {
        server.route('GET', '/x', { body: { ok: true } });
        const store = memoryStore();
        const s1 = stitch({
            baseUrl: server.url,
            path: '/x',
            store,
            throttle: { rate: '1/s', pool: 'host' },
        });
        const s2 = stitch({
            baseUrl: server.url,
            path: '/x',
            store,
            throttle: { rate: '1/s', pool: 'host' },
        });

        const [w1, w2] = await Promise.all([
            wasThrottled(s1),
            wasThrottled(s2),
        ]);
        expect(w1 + w2).toBe(1); // 1/s shared → exactly one of two concurrent calls is paced
    });

    test('pool:"host" pools the rate budget in-process WITHOUT a shared store', async () => {
        // throttle.mdx: "'host' pools the budget across every stitch hitting the same host."
        // Host-scoped state lives in a module-level registry (resilience.ts), so two separate
        // stitches with no shared store still draw from one 1/s budget — one of two concurrent
        // calls is paced. (GAP-AUDIT §1.4; supersedes the old "separate stores never share".)
        server.route('GET', '/y', { body: { ok: true } });
        const s1 = stitch({
            baseUrl: server.url,
            path: '/y',
            throttle: { rate: '1/s', pool: 'host' },
        });
        const s2 = stitch({
            baseUrl: server.url,
            path: '/y',
            throttle: { rate: '1/s', pool: 'host' },
        });

        const [w1, w2] = await Promise.all([
            wasThrottled(s1),
            wasThrottled(s2),
        ]);
        expect(w1 + w2).toBe(1); // pooled 1/s → exactly one of two concurrent calls is paced
    });

    test('pool:"stitch" (default) keeps separate budgets per instance', async () => {
        // The default pool is per-stitch: each instance keeps its own closure-local budget,
        // so two separate stitches (no shared store) on distinct names never pace each other.
        server.route('GET', '/z', { body: { ok: true } });
        const s1 = stitch({
            name: 'z1',
            baseUrl: server.url,
            path: '/z',
            throttle: { rate: '1/s' },
        });
        const s2 = stitch({
            name: 'z2',
            baseUrl: server.url,
            path: '/z',
            throttle: { rate: '1/s' },
        });

        const [w1, w2] = await Promise.all([
            wasThrottled(s1),
            wasThrottled(s2),
        ]);
        expect(w1 + w2).toBe(0); // independent per-stitch budgets → neither waits
    });

    test('a store-backed throttle even-spaces overflow grants, like the in-process limiter', async () => {
        // GAP-AUDIT §2.11: attaching a store must NOT switch pacing to bursty fixed-window.
        // Fire MORE calls than the window holds; the overflow grants land at/after the next
        // window boundary, so they are in the future regardless of where in the window the burst
        // begins — making the even spacing observable without aligning to the clock.
        const rate = '5/s'; // count 5, spacing = 200ms
        const grantTimes = async (
            t: Throttle,
            key: string,
        ): Promise<number[]> => {
            const start = Date.now();
            const ats = await Promise.all(
                Array.from({ length: 8 }, async () => {
                    await t.acquire(key);
                    return Date.now() - start;
                }),
            );
            return ats.sort((a, b) => a - b);
        };

        const [inProcess, storeBacked] = await Promise.all([
            grantTimes(createThrottle({ rate }), 'k'),
            grantTimes(createStoreThrottle({ rate }, memoryStore()), 'k'),
        ]);

        // Even-spacing: consecutive overflow grants are ~200ms apart in BOTH limiters. The old
        // store throttle bunched every overflow grant at the window boundary (gap ≈ 0).
        for (const ats of [inProcess, storeBacked]) {
            const n = ats.length;
            expect((ats[n - 1] ?? 0) - (ats[n - 2] ?? 0)).toBeGreaterThan(120);
            expect((ats[n - 2] ?? 0) - (ats[n - 3] ?? 0)).toBeGreaterThan(120);
        }
    });

    // The even-spacing fix above covered the steady state; this is the COLD START. A process
    // joining mid-window claims slots whose scheduled times have already elapsed, and granting
    // each on claim drained them in one tick — a burst that scaled with the WINDOW rather than
    // the declared rate. `'2/s'` and `'120/m'` are both a 500ms spacing, but a one-minute window
    // left up to 119 elapsed slots to drain against one for `'2/s'`. It is a rolling deploy, a
    // new worker, a lambda — not the sustained-overload edge `createStoreThrottle` documents.
    test('a store-backed throttle does not burst when a process joins mid-window', async () => {
        // 59.5s is mid-window for BOTH rates: '2/s' is 500ms into its window, '120/m' 59.5s into
        // its own — so the two differ only in how much elapsed slack the window holds.
        const grants = async (
            make: (c: Clock) => Throttle,
        ): Promise<number[]> => {
            const clock = manualClock(59_500);
            const t = make(clock);
            const at: number[] = [];
            const all = Promise.all(
                Array.from({ length: 5 }, () =>
                    t.acquire('k').then(() => {
                        at.push(clock.now());
                    }),
                ),
            );
            await clock.advance(60_000);
            await all;
            return at;
        };

        const perSecond = await grants((c) =>
            createStoreThrottle({ rate: '2/s' }, memoryStore(), c),
        );
        const perMinute = await grants((c) =>
            createStoreThrottle({ rate: '120/m' }, memoryStore(), c),
        );
        // The widened denominator (ADR 0023 Decision 3) gives the same 500ms spacing a third
        // spelling, over a 500ms window — the shortest of the three, against the minute-long one
        // above. If the window length still leaked into behaviour, these two would disagree.
        const perHalfSecond = await grants((c) =>
            createStoreThrottle({ rate: '1/500ms' }, memoryStore(), c),
        );
        const inProcess = await grants((c) =>
            createThrottle({ rate: '2/s' }, c),
        );

        // No two grants closer than the declared 500ms — the burst is gone. Before the fix
        // '120/m' granted all five at once (59500 ×5) and '2/s' granted two.
        for (const at of [perSecond, perMinute, perHalfSecond])
            for (let i = 1; i < at.length; i++)
                expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBe(500);

        // And the window length no longer changes the answer: one declared spacing, one limiter,
        // store-backed or not, however the ratio is spelled. `'2/s'`, `'120/m'` and `'1/500ms'`
        // span windows from half a second to a minute and are byte-identical.
        expect(perMinute).toEqual(perSecond);
        expect(perHalfSecond).toEqual(perSecond);
        expect(perSecond).toEqual(inProcess);
        expect(perSecond).toEqual([59_500, 60_000, 60_500, 61_000, 61_500]);
    });

    // The companion to the test above. That fix's bound is PER-PROCESS, so this pins what it does
    // and does not buy a FLEET: two `createStoreThrottle` instances over one store stand in for
    // two workers sharing Redis. The mid-window residue is a known, deferred gap — pinned here so
    // it is a decision on the record rather than a surprise, and so the fleet-wide GCRA cell
    // `createStoreThrottle` defers has a test to break when it lands.
    // A store with the ADR 0024 pacing cursor withheld — every other verb intact. The fallback
    // path is not dead code: an eventually-consistent backend (Cloudflare KV) has no atomic
    // read-compute-write to build a cell from, so this is the only path it can take, and its
    // residues stay pinned rather than described.
    const withoutReserve = (): StitchStore => {
        const s = memoryStore();
        return {
            get: (k) => s.get(k),
            set: (k, v, ttl) => s.set(k, v, ttl),
            increment: (k, ttl) => s.increment(k, ttl),
        };
    };

    // Same idea for the ADR 0025 semaphore: every verb intact except the lease pair, so the
    // per-process fallback stays pinned rather than merely described. Cloudflare KV takes this
    // path for real.
    const withoutLeases = (): StitchStore => {
        const s = memoryStore();
        return {
            get: (k) => s.get(k),
            set: (k, v, ttl) => s.set(k, v, ttl),
            increment: (k, ttl) => s.increment(k, ttl),
            reserve: (k, spacing, at, ttl) => s.reserve!(k, spacing, at, ttl),
        };
    };

    // Run `calls` acquire/hold/release cycles spread over `procs` throttles sharing one store,
    // and report the peak number held at once. That peak IS the concurrency cap's meaning.
    const peakInFlight = async (
        store: StitchStore,
        procs: number,
        calls: number,
        opts: { concurrency: number; lease?: string },
    ): Promise<number> => {
        const ts = Array.from({ length: procs }, () =>
            createStoreThrottle(opts, store),
        );
        let held = 0;
        let peak = 0;
        await Promise.all(
            Array.from({ length: calls }, async (_, i) => {
                const t = ts[i % procs]!;
                await t.acquire('svc');
                peak = Math.max(peak, ++held);
                await new Promise((r) => setTimeout(r, 25));
                held--;
                t.release('svc');
            }),
        );
        return peak;
    };

    test('a fleet over one store paces on ONE schedule, wherever in a window it starts', async () => {
        const fleet = async (
            rate: string,
            procs: number,
            each: number,
            start: number,
            store: StitchStore = memoryStore(),
        ): Promise<{ p: number; t: number }[]> => {
            const clock = manualClock(start);
            const ts = Array.from({ length: procs }, () =>
                createStoreThrottle({ rate }, store, clock),
            );
            const at: { p: number; t: number }[] = [];
            const all: Promise<void>[] = [];
            // Round-robin, so slot allocation interleaves the way concurrent workers would.
            for (let i = 0; i < each; i++)
                for (let p = 0; p < procs; p++)
                    all.push(
                        ts[p]!.acquire('k').then(() => {
                            at.push({ p, t: clock.now() });
                        }),
                    );
            await clock.advance(180_000);
            await Promise.all(all);
            return at;
        };

        // 1. AT a window boundary: two processes draw from ONE budget — 500ms apart fleet-wide,
        //    not 500ms apart each. This always held; the counter's slots were in the future here,
        //    so even the fallback paced the fleet correctly.
        expect((await fleet('2/s', 2, 3, 0)).map((x) => x.t)).toEqual([
            0, 500, 1000, 1500, 2000, 2500,
        ]);

        // 2. MID-window is the case the counter could not reach: every slot up to `now` is already
        //    stale, and a stale slot paces nobody. The cursor is not a schedule of positions, so
        //    there is no "stale prefix" to inherit — `max(now, cell)` starts from the present and
        //    every process advances the same cell. Same 500ms fleet-wide, from a standing start
        //    59.5s into a one-minute window.
        const midWindow = await fleet('120/m', 2, 3, 59_500);
        expect(midWindow.map((x) => x.t)).toEqual([
            59_500, 60_000, 60_500, 61_000, 61_500, 62_000,
        ]);

        // 3. No instant carries more than one grant — the fleet-wide invariant, where the fallback
        //    could only bound a burst by the process count.
        const perInstant = new Map<number, number>();
        for (const { t } of midWindow)
            perInstant.set(t, (perInstant.get(t) ?? 0) + 1);
        expect(Math.max(...perInstant.values())).toBe(1);

        // 4. Three workers, same story: the fleet emits every 500ms regardless of how many
        //    processes share the cell. Under the fallback this was 3× the declared rate.
        expect((await fleet('120/m', 3, 2, 59_500)).map((x) => x.t)).toEqual([
            59_500, 60_000, 60_500, 61_000, 61_500, 62_000,
        ]);

        // 5. And the FALLBACK still behaves as documented, pinned against a store with `reserve`
        //    withheld — this is the path an eventually-consistent backend takes, so its residue is
        //    a live property, not history. Mid-window the fleet emits at N× the declared rate,
        //    recovering once the slots catch up with the clock.
        const noCell = await fleet('120/m', 2, 3, 59_500, withoutReserve());
        expect(noCell.map((x) => x.t)).toEqual([
            59_500, 59_500, 60_000, 60_000, 60_500, 60_500,
        ]);
        // Each process still honours the declared spacing internally — the bound the local cursor
        // buys, and the reason the residue is N× rather than unbounded.
        for (const p of [0, 1]) {
            const mine = noCell.filter((x) => x.p === p).map((x) => x.t);
            for (let i = 1; i < mine.length; i++)
                expect((mine[i] ?? 0) - (mine[i - 1] ?? 0)).toBe(500);
        }
    });

    // ADR 0025 — `concurrency` becomes fleet-wide when the store leases.
    test('a fleet over one store holds ONE concurrency budget', async () => {
        // Four workers, twelve calls, cap of 3. Per-process this is a cap of 3 EACH, so the peak
        // would be up to 12; fleet-wide it is 3 full stop. Nothing is configured to switch — the
        // throttle uses the lease verbs because `memoryStore` has them.
        const peak = await peakInFlight(memoryStore(), 4, 12, {
            concurrency: 3,
        });
        expect(peak).toBe(3);
    });

    test('without the lease verbs, concurrency stays PER-PROCESS', async () => {
        // The documented fallback, asserted rather than described: the same four workers each
        // enforce the cap alone, so the fleet runs at up to `concurrency × workers`. This is the
        // path an eventually-consistent backend takes, so it is a live property.
        const peak = await peakInFlight(withoutLeases(), 4, 12, {
            concurrency: 3,
        });
        expect(peak).toBeGreaterThan(3);
        expect(peak).toBeLessThanOrEqual(12);
    });

    test('a crashed holder frees its slot when the lease lapses', async () => {
        // The reason leases exist. Acquire and never release — a worker that died mid-call — then
        // show the slot comes back on its own, without anybody releasing it.
        const store = memoryStore();
        const dead = createStoreThrottle(
            { concurrency: 1, lease: '80ms' },
            store,
        );
        const live = createStoreThrottle(
            { concurrency: 1, lease: '80ms' },
            store,
        );
        await dead.acquire('svc'); // held, never released

        const start = Date.now();
        await live.acquire('svc');
        const waited = Date.now() - start;
        // It had to wait out the lease — proving the slot really was held — but not forever.
        expect(waited).toBeGreaterThanOrEqual(50);
        expect(waited).toBeLessThan(1_000);
    });

    test('a fleet-wide slot is reported as waited, so the throttled event still fires', async () => {
        // `waited` drives the `progress.throttled` event. Under leases the store owns the count,
        // so a blocked caller's wait is measured rather than predicted — this pins that it is
        // still reported, and that an uncontended acquire reports nothing.
        //
        // Measured means an uncontended acquire is near-zero, not exactly zero: one that straddles
        // a millisecond boundary reports 1. The tolerance is what separates "walked straight in"
        // from a real block, which below is ~60ms — the two cases are nowhere near each other.
        const store = memoryStore();
        const a = createStoreThrottle({ concurrency: 1 }, store);
        const b = createStoreThrottle({ concurrency: 1 }, store);

        const first = await a.acquire('svc');
        expect(first.waited).toBeLessThan(5); // uncontended

        const blocked = b.acquire('svc');
        await new Promise((r) => setTimeout(r, 60));
        a.release('svc');
        expect((await blocked).waited).toBeGreaterThan(0);
        b.release('svc');
    });

    test('a streaming (rateOnly) acquire takes no fleet-wide slot either', async () => {
        // ADR 0005 Decision 12 holds under leases: a long-lived stream must not pin a slot for
        // its whole life, which is also what keeps `lease` a crash timer rather than a call timer.
        const store = memoryStore();
        const t = createStoreThrottle({ concurrency: 1 }, store);
        await t.acquire('svc', { rateOnly: true });
        await t.acquire('svc', { rateOnly: true });
        // Neither took the single slot, so a normal acquire still walks straight in. Tolerance,
        // not exact zero, for the same reason as the sibling test above: `waited` is measured, so
        // an uncontended acquire across a millisecond boundary reports 1. Had a stream pinned the
        // slot, this acquire would have blocked for the whole lease — orders of magnitude away.
        const normal = await t.acquire('svc');
        expect(normal.waited).toBeLessThan(5);
    });
});
