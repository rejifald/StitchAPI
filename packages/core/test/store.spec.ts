// Proves the pluggable store (DESIGN.md §13): a SHARED store makes session and throttle
// state shared across separate stitches (simulating two workers sharing Redis); the default
// in-memory store keeps them independent.
import { memoryStore, stitch } from '../src';
import type { Clock, Stitch } from '../src';
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
        const inProcess = await grants((c) =>
            createThrottle({ rate: '2/s' }, c),
        );

        // No two grants closer than the declared 500ms — the burst is gone. Before the fix
        // '120/m' granted all five at once (59500 ×5) and '2/s' granted two.
        for (const at of [perSecond, perMinute])
            for (let i = 1; i < at.length; i++)
                expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBe(500);

        // And the window length no longer changes the answer: one declared spacing, one limiter,
        // store-backed or not.
        expect(perMinute).toEqual(perSecond);
        expect(perSecond).toEqual(inProcess);
        expect(perSecond).toEqual([59_500, 60_000, 60_500, 61_000, 61_500]);
    });

    // The companion to the test above. That fix's bound is PER-PROCESS, so this pins what it does
    // and does not buy a FLEET: two `createStoreThrottle` instances over one store stand in for
    // two workers sharing Redis. The mid-window residue is a known, deferred gap — pinned here so
    // it is a decision on the record rather than a surprise, and so the fleet-wide GCRA cell
    // `createStoreThrottle` defers has a test to break when it lands.
    test('a fleet over one store: the shared budget holds at a window boundary; mid-window the residue is bounded by process count', async () => {
        const fleet = async (
            rate: string,
            procs: number,
            each: number,
            start: number,
        ): Promise<{ p: number; t: number }[]> => {
            const clock = manualClock(start);
            const store = memoryStore();
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

        // 1. AT a window boundary every slot is still in the future, so the shared counter binds
        //    and two processes draw from ONE budget: 500ms apart fleet-wide, not 500ms apart each.
        //    This is what the store is for, and the property a per-process cursor could most
        //    easily have broken.
        const atBoundary = await fleet('2/s', 2, 3, 0);
        expect(atBoundary.map((x) => x.t)).toEqual([
            0, 500, 1000, 1500, 2000, 2500,
        ]);

        // 2. MID-window, every slot up to `now` is already stale, and a stale slot cannot pace
        //    anybody — only each process's own cursor can.
        const midWindow = await fleet('120/m', 2, 3, 59_500);

        //    a. Each process still honours the declared spacing internally. That is the invariant
        //       the cursor buys, and the one that was violated outright before it.
        for (const p of [0, 1]) {
            const mine = midWindow.filter((x) => x.p === p).map((x) => x.t);
            for (let i = 1; i < mine.length; i++)
                expect((mine[i] ?? 0) - (mine[i - 1] ?? 0)).toBe(500);
        }

        //    b. So the instantaneous burst is bounded by the PROCESS COUNT rather than by how many
        //       slots the window had left unclaimed. One process used to drain all of them into a
        //       single instant; two processes now put exactly two calls there.
        const perInstant = new Map<number, number>();
        for (const { t } of midWindow)
            perInstant.set(t, (perInstant.get(t) ?? 0) + 1);
        expect(Math.max(...perInstant.values())).toBe(2);

        //    c. And here is the residue itself, asserted rather than described: through the stale
        //       prefix the fleet emits at 2× the declared rate (N× for N workers), recovering only
        //       once the slots catch up with the clock. Closing this needs the fleet-wide GCRA
        //       cell — when that lands, THIS is the assertion that should fail.
        expect(midWindow.map((x) => x.t)).toEqual([
            59_500, 59_500, 60_000, 60_000, 60_500, 60_500,
        ]);
    });
});
