// Proves the pluggable store (DESIGN.md §13): a SHARED store makes session and throttle
// state shared across separate stitches (simulating two workers sharing Redis); the default
// in-memory store keeps them independent.
import { memoryStore, stitch } from '../src';
import type { Stitch } from '../src';
import { cookieSession, env } from '../src/auth';
import { createThrottle } from '../src/resilience';
import { createStoreThrottle } from '../src/store';
import type { Throttle } from '../src/store';
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

    // ADR 0023. The test above fires every acquire AT ONCE and asserts on the TAIL, which is
    // where the bug it was written for lived. Both defects fixed here hid in what it does not
    // look at: the head of the schedule, and arrivals spread over more than one window. The
    // acceptance criterion is therefore total admitted against budget — the only measure that
    // catches a limiter letting calls through early rather than bunching them late.
    test('the same rate spelled two ways admits the same number of calls', async () => {
        // '2/s' and '120/m' are one rate: spacing 500ms either way. They differ only in `per`,
        // which used to set the counter's window AND the schedule origin — so `'120/m'` admitted
        // ~10x its budget (a full minute of credit on a cold key) and `'2/s'` ~3x (a fresh
        // origin every second, run through the previous second's pending grants).
        const DURATION = 4000;
        const BUDGET = 8; // 4s at 2/s
        const admitted = async (rate: string): Promise<number> => {
            const t = createStoreThrottle({ rate }, memoryStore());
            const start = Date.now();
            let granted = 0;
            const inflight: Promise<void>[] = [];
            // Spread arrivals so they land across SEVERAL windows — all-at-once puts every
            // caller on one counter and cannot see a rollover at all.
            while (Date.now() - start < DURATION) {
                inflight.push(
                    t.acquire('k').then(() => {
                        if (Date.now() - start <= DURATION) granted++;
                    }),
                );
                await new Promise((r) => setTimeout(r, 50));
            }
            await Promise.race([
                Promise.all(inflight),
                new Promise((r) => setTimeout(r, 50)),
            ]);
            return granted;
        };

        const [short, long] = await Promise.all([
            admitted('2/s'),
            admitted('120/m'),
        ]);
        // Bounds are deliberately loose against real timers on a loaded CI box, and still nowhere
        // near the defect: it admitted 24 and 79 against this budget of 8, so a ceiling of 10
        // catches both with room to spare while absorbing a couple of calls' worth of drift.
        // A slow machine can only push grants LATER, i.e. below the ceiling, so this edge is safe.
        expect(short).toBeLessThanOrEqual(BUDGET + 2);
        expect(long).toBeLessThanOrEqual(BUDGET + 2);
        // And the two spellings agree, which is the property `per` leaking into grant times broke
        // — they differed by 55 (24 vs 79) before, so ±2 is a real assertion, not a formality.
        expect(Math.abs(short - long)).toBeLessThanOrEqual(2);
    }, 30000);

    test('a cold key does not open with a burst, however long its window', async () => {
        // The opening burst was `count` slots — every slot already elapsed in the window before
        // the first call. `count` scales with `per`, so a long window bursted harder: '600/m'
        // released the whole batch at once while '10/s', the same rate, released 1-3. Both must
        // now admit exactly one call without waiting. (Spacing 100ms so 20 calls cost ~2s.)
        const openingBurst = async (rate: string): Promise<number> => {
            const t = createStoreThrottle({ rate }, memoryStore());
            const start = Date.now();
            const at = await Promise.all(
                Array.from({ length: 20 }, async () => {
                    await t.acquire('k');
                    return Date.now() - start;
                }),
            );
            return at.filter((ms) => ms < 50).length; // half a spacing
        };

        // ≤2 rather than exactly 1, for the same CI-drift reason: the defect released the entire
        // batch of 20 at once, so this still fails loudly if the anchor regresses.
        expect(await openingBurst('10/s')).toBeLessThanOrEqual(2);
        expect(await openingBurst('600/m')).toBeLessThanOrEqual(2);
    }, 30000);
});
