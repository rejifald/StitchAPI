// Proves the pluggable store (DESIGN.md §13): a SHARED store makes session and throttle
// state shared across separate stitches (simulating two workers sharing Redis); the default
// in-memory store keeps them independent.
import { cookieSession, env, memoryStore, stitch } from '../src';
import type { Stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STITCH_TRACE_FILE = join(
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
        process.env.ST_USER = 'u';
        process.env.ST_PASS = 'p';
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
            }),
        });

        expect(await a()).toEqual({ r: 'a' });
        expect(await b()).toEqual({ r: 'b' });
        expect(server.callCount('/login')).toBe(1); // ONE login, reused via the shared store
    });

    test('default (separate) stores → each stitch logs in independently', async () => {
        process.env.ST_USER = 'u';
        process.env.ST_PASS = 'p';
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

    test('default (separate) stores do NOT share the rate budget', async () => {
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
        expect(w1 + w2).toBe(0); // independent windows → neither waits
    });
});
