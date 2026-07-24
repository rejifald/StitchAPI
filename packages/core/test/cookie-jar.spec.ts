// Multi-cookie jar: with `cookie: '*'` (or `jar: true`) cookieSession captures the FULL
// Set-Cookie set from the login and replays every cookie on subsequent requests — not just
// one named cookie. A login that sets two cookies should make both ride along next time.
//
// These standalone stitches share ONE session across all callers, so they pass `tenancy: 'app'`
// explicitly — the fail-closed default `'principal'` would throw (no seam binds a principal).
import { cookieSession, env, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-cookiejar-${process.pid}.jsonl`,
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
    process.env['CJ_USER'] = 'u';
    process.env['CJ_PASS'] = 'p';
});

const loginInput = () => ({
    body: { u: env('CJ_USER')(), p: env('CJ_PASS')() },
});

const loginStitch = () =>
    stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/login',
        bodyType: 'form',
    });

test('cookie: "*" captures and replays every cookie the login set', async () => {
    server.route('POST', '/login', {
        setCookies: [
            { name: 'sid', value: 'ABC' },
            { name: 'csrf', value: 'XYZ' },
        ],
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(),
            cookie: '*',
            loginInput,
            tenancy: 'app',
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    expect(server.callCount('/login')).toBe(1);

    const req = server.calls('/data')[0]!;
    expect(req.cookies['sid']).toBe('ABC'); // both cookies from the jar replay together
    expect(req.cookies['csrf']).toBe('XYZ');
});

test('jar: true is equivalent to cookie: "*"', async () => {
    server.route('POST', '/login', {
        setCookies: [
            { name: 'sid', value: 'ABC' },
            { name: 'csrf', value: 'XYZ' },
        ],
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(),
            cookie: 'session', // only seeds the store key in jar mode
            jar: true,
            loginInput,
            tenancy: 'app',
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    const req = server.calls('/data')[0]!;
    expect(req.cookies['sid']).toBe('ABC');
    expect(req.cookies['csrf']).toBe('XYZ');
});

test('a single named cookie still replays only that one (regression)', async () => {
    server.route('POST', '/login', {
        setCookies: [
            { name: 'sid', value: 'ABC' },
            { name: 'csrf', value: 'XYZ' },
        ],
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    const req = server.calls('/data')[0]!;
    expect(req.cookies['sid']).toBe('ABC'); // captured
    expect(req.cookies['csrf']).toBeUndefined(); // NOT captured — named mode is scoped to one cookie
});
