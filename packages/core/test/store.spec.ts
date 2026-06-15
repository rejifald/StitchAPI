// Proves the pluggable store (DESIGN.md §13): a SHARED store makes session and throttle
// state shared across separate stitches (simulating two workers sharing Redis); the default
// in-memory store keeps them independent.
import { cookieSession, env, memoryStore, stitch } from '../src';
import type { Stitch } from '../src';
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
            (ev.waitedMs ?? 0) > 0
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
            bodyType: 'form',
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
                scope: 'app', // standalone shared session (no principal bound)
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
                scope: 'app', // standalone shared session (no principal bound)
            }),
        });

        expect(await a()).toEqual({ r: 'a' });
        expect(await b()).toEqual({ r: 'b' });
        expect(server.callCount('/login')).toBe(1); // ONE login, reused via the shared store
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
            bodyType: 'form',
        });

        const a = stitch({
            baseUrl: server.url,
            path: '/a',
            auth: cookieSession({
                login,
                cookie: 'SID',
                key: 'svc',
                loginInput,
                scope: 'app', // standalone shared session (no principal bound)
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
                scope: 'app', // standalone shared session (no principal bound)
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
            throttle: { rate: '1/s', scope: 'host' },
        });
        const s2 = stitch({
            baseUrl: server.url,
            path: '/x',
            store,
            throttle: { rate: '1/s', scope: 'host' },
        });

        const [w1, w2] = await Promise.all([
            wasThrottled(s1),
            wasThrottled(s2),
        ]);
        expect(w1 + w2).toBe(1); // 1/s shared → exactly one of two concurrent calls is paced
    });

    test('scope:"host" pools the rate budget in-process WITHOUT a shared store', async () => {
        // throttle.mdx: "'host' pools the budget across every stitch hitting the same host."
        // Host-scoped state lives in a module-level registry (resilience.ts), so two separate
        // stitches with no shared store still draw from one 1/s budget — one of two concurrent
        // calls is paced. (GAP-AUDIT §1.4; supersedes the old "separate stores never share".)
        server.route('GET', '/y', { body: { ok: true } });
        const s1 = stitch({
            baseUrl: server.url,
            path: '/y',
            throttle: { rate: '1/s', scope: 'host' },
        });
        const s2 = stitch({
            baseUrl: server.url,
            path: '/y',
            throttle: { rate: '1/s', scope: 'host' },
        });

        const [w1, w2] = await Promise.all([
            wasThrottled(s1),
            wasThrottled(s2),
        ]);
        expect(w1 + w2).toBe(1); // pooled 1/s → exactly one of two concurrent calls is paced
    });

    test('scope:"stitch" (default) keeps separate budgets per instance', async () => {
        // The default scope is per-stitch: each instance keeps its own closure-local budget,
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
});
