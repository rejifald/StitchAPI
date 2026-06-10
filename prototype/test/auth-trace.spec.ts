import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We must control the JSONL trace path BEFORE importing `../src`: getTrace() reads
// STITCH_TRACE_FILE when each stitch is constructed. Capture the path so scenario 3
// can read the records back and prove zero-infra observability.
process.env.STITCH_TRACE_FILE = join(tmpdir(), `stitch-auth-${process.pid}.jsonl`);
const TRACE_FILE = process.env.STITCH_TRACE_FILE;

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { stitch, cookieSession, env } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => server.reset());

// ---------------------------------------------------------------------------
// AUTH-AS-BOUNDARY
// ---------------------------------------------------------------------------

// Scenario 1 — Auth-wall: auto-login, capability-not-credential.
// The `me` stitch is handed a *capability* (the cookieSession strategy), not a
// credential. The caller invokes `me()` with NO arguments and never sees a secret:
// the strategy auto-logs-in behind the wall, captures `sid`, and replays it.
test('auth-wall: me() auto-logs-in and never asks the caller for a secret', async () => {
    server.route('POST', '/login', { setCookie: { name: 'sid', value: 'GOOD' }, body: { ok: true } });
    server.route('GET', '/me', { requireCookie: { name: 'sid' }, body: { user: 'ada' } });

    const signIn = stitch({ method: 'POST', baseUrl: server.url, path: '/login' });

    // Set per the task. STITCH_USER/STITCH_PASS are inert here; the loginInput below
    // resolves DEMO_USER / DEMO_PASS at call time via env().
    process.env.STITCH_USER = 'u';
    process.env.STITCH_PASS = 'p';
    process.env.DEMO_USER = 'u';
    process.env.DEMO_PASS = 'p';

    const me = stitch({
        baseUrl: server.url,
        path: '/me',
        auth: cookieSession({
            login: signIn,
            cookie: 'sid',
            loginInput: () => ({
                body: { user: env('DEMO_USER')(), pass: env('DEMO_PASS')() },
            }),
        }),
    });

    // The caller passes NO secret (and no arguments at all) to me().
    await expect(me()).resolves.toEqual({ user: 'ada' });

    expect(server.callCount('/login')).toBe(1);

    const meReq = server.calls('/me')[0];
    expect(meReq?.cookies.sid).toBe('GOOD');
});

// Scenario 2 — Refresh on the 401 wall.
// First /data response is a 401 (the wall); cookieSession re-logs-in and replays.
// Expected: login runs twice (initial auto-login + post-401 refresh) and /data is
// hit twice (the 401, then the 200).
test('refresh on the 401 wall re-logs-in and retries the request', async () => {
    server.route('POST', '/login', { setCookie: { name: 'sid', value: 'GOOD' }, body: { ok: true } });
    server.route('GET', '/data', { statuses: [401, 200], body: { ok: true } });

    const signIn = stitch({ method: 'POST', baseUrl: server.url, path: '/login' });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: cookieSession({ login: signIn, cookie: 'sid', refreshOn: [401] }),
    });

    await expect(data()).resolves.toEqual({ ok: true });

    // If these counts differ, the assertion stays strict and we report the actuals
    // as a BUG rather than weakening the check.
    expect(server.callCount('/login')).toBe(2);
    expect(server.callCount('/data')).toBe(2);
});

// ---------------------------------------------------------------------------
// ZERO-INFRA TRACE
// ---------------------------------------------------------------------------

// Scenario 3 — Zero-infra JSONL trace.
// Running a plain stitch appends structured records to STITCH_TRACE_FILE with no
// external infrastructure. We read the file back and assert the lifecycle records
// (start / result / done) are present, each carrying a `name`.
test('zero-infra JSONL trace records start/result/done with a name', async () => {
    // Start from a clean slate so the assertion describes only this run.
    writeFileSync(TRACE_FILE, '');

    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ name: 'ping', baseUrl: server.url, path: '/ping' });
    await expect(ping()).resolves.toEqual({ ok: true });

    expect(existsSync(TRACE_FILE)).toBe(true);
    const records = readFileSync(TRACE_FILE, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { type: string; name: string });

    const byType = (type: string) => records.filter((r) => r.type === type);
    expect(byType('start').length).toBeGreaterThanOrEqual(1);
    expect(byType('result').length).toBeGreaterThanOrEqual(1);
    expect(byType('done').length).toBeGreaterThanOrEqual(1);

    // Every lifecycle record is self-describing: it names which stitch emitted it.
    for (const type of ['start', 'result', 'done']) {
        for (const rec of byType(type)) {
            expect(typeof rec.name).toBe('string');
            expect(rec.name.length).toBeGreaterThan(0);
        }
    }
    expect(byType('start')[0]?.name).toBe('ping');
});
