// Pins issue #146: cookieSession host-owned lifecycle hooks (onRefresh / onAuthFailure).
//
// A host that owns durable, CATEGORISED auth state (active / backoff / failed / unauthenticated)
// can't drive its state machine off StitchAPI's per-call single-flight refresh — the stitch owns
// recovery and never tells the host *why* a login failed. These hooks close that gap: `onRefresh`
// fires after every (re)login attempt with its outcome; `onAuthFailure` fires when no cookie was
// captured, with a category (unauthenticated / rate-limited / network / unknown) the host maps to
// its own status. The hooks fire ONCE per actual login attempt (inside the single-flight-guarded
// `doRefresh`), never per coalesced waiter, and a throwing hook never crashes the call.
//
// These standalone stitches share ONE session across all callers, so they pass `tenancy: 'app'`
// explicitly — the fail-closed default `'principal'` would throw (no seam binds a principal).
import {
    type AuthFailureResult,
    type RefreshResult,
    cookieSession,
    env,
    stitch,
} from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-cookie-session-hooks-${process.pid}.jsonl`,
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
    process.env['CSH_USER'] = 'u';
    process.env['CSH_PASS'] = 'p';
});

const loginInput = () => ({
    body: { u: env('CSH_USER')(), p: env('CSH_PASS')() },
});

const loginStitch = (baseUrl: string) =>
    stitch({
        method: 'POST',
        baseUrl,
        path: '/login',
        bodyType: 'form',
    });

test('onRefresh fires with { ok: true, status: 200 } after a successful cold login', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'ABC' },
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const refreshes: RefreshResult[] = [];
    const failures: AuthFailureResult[] = [];

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onRefresh: (r) => {
                refreshes.push(r);
            },
            onAuthFailure: (f) => {
                failures.push(f);
            },
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });

    expect(refreshes).toEqual([{ ok: true, status: 200 }]);
    expect(failures).toEqual([]); // a successful login never reports a failure
});

test('onRefresh fires ONCE (not per-waiter) under concurrent cold callers sharing one login', async () => {
    server.route('POST', '/login', {
        // Hold the first login in flight long enough that every concurrent cold
        // caller has already taken the cache-miss branch — making the race
        // deterministic, the same trick the single-flight token test uses.
        delayMs: 50,
        setCookie: { name: 'sid', value: 'ABC' },
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    let refreshCount = 0;

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onRefresh: () => {
                refreshCount++;
            },
        }),
    });

    // Fire 5 cold calls at once — none awaited before the others start.
    const results = await Promise.all(Array.from({ length: 5 }, () => data()));

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
    expect(server.callCount('/login')).toBe(1); // single-flight: one real login
    expect(refreshCount).toBe(1); // ...so the hook fires once, not per waiter
}, 10000);

test("onAuthFailure fires category 'unauthenticated' when the login returns 401 and sets no cookie", async () => {
    // No setCookie + a 401 status: the login responded but captured nothing, and 401 is a
    // `refreshOn` status → the host hears "the creds were rejected".
    server.route('POST', '/login', {
        statuses: [401],
        body: { error: 'bad creds' },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const failures: AuthFailureResult[] = [];
    const refreshes: RefreshResult[] = [];

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onAuthFailure: (f) => {
                failures.push(f);
            },
            onRefresh: (r) => {
                refreshes.push(r);
            },
        }),
    });

    // /data still 401s (no cookie was ever captured), so the call itself fails — the point of this
    // test is the categorised hook, not the call's success.
    await expect(data()).rejects.toThrow();

    expect(failures).toEqual([
        { phase: 'apply', status: 401, category: 'unauthenticated' },
    ]);
    // onRefresh still fired, reporting the failed outcome.
    expect(refreshes).toEqual([{ ok: false, status: 401 }]);
});

test("onAuthFailure fires category 'rate-limited' + retryAfter when the login returns 429 with Retry-After", async () => {
    server.route('POST', '/login', {
        statuses: [429],
        retryAfter: 7, // seconds → 7000ms
        body: { error: 'slow down' },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const failures: AuthFailureResult[] = [];

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onAuthFailure: (f) => {
                failures.push(f);
            },
        }),
    });

    await expect(data()).rejects.toThrow();

    expect(failures).toEqual([
        {
            phase: 'apply',
            status: 429,
            category: 'rate-limited',
            retryAfter: 7000,
            // The @deprecated `retryAfterMs` alias is co-set for back-compat (CONTRACT.md P17).
            retryAfterMs: 7000,
        },
    ]);
});

test("onAuthFailure fires category 'network' + error when the login stitch throws", async () => {
    // Point the login at a dead address (a port that refuses connections) so `__raw` throws before
    // any response — the transport-failure path, distinct from an HTTP error status.
    const deadUrl = 'http://127.0.0.1:1'; // port 1 is not listening

    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const failures: AuthFailureResult[] = [];
    const refreshes: RefreshResult[] = [];

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({
            login: loginStitch(deadUrl),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onAuthFailure: (f) => {
                failures.push(f);
            },
            onRefresh: (r) => {
                refreshes.push(r);
            },
        }),
    });

    await expect(data()).rejects.toThrow();

    expect(failures).toHaveLength(1);
    const f = failures[0]!;
    expect(f.phase).toBe('apply');
    expect(f.category).toBe('network');
    expect(f.status).toBeUndefined(); // no response, so no status
    expect(f.error).toBeInstanceOf(Error); // the thrown transport error rides along
    // onRefresh still reports the failed outcome (no status, since nothing responded).
    expect(refreshes).toEqual([{ ok: false }]);
});

test('a throwing hook does not crash the stitch call', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'ABC' },
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
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
            onRefresh: () => {
                throw new Error('host bookkeeping blew up');
            },
        }),
    });

    // The hook throws on a SUCCESSFUL login, but the cookie was still captured and replayed,
    // so the call must succeed regardless — a buggy host hook can't take the stitch down.
    await expect(data()).resolves.toEqual({ ok: true });
    expect(server.callCount('/login')).toBe(1);
});

test('hooks are absent → cookieSession behaves exactly as before (additive, no regression)', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'ABC' },
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
            login: loginStitch(server.url),
            cookie: 'sid',
            loginInput,
            tenancy: 'app',
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    expect(server.callCount('/login')).toBe(1);
    const req = server.calls('/data')[0]!;
    expect(req.cookies['sid']).toBe('ABC');
});
