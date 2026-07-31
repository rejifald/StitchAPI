// OAuth2 `client_credentials`: the strategy fetches a token from the token endpoint, caches
// it in the StitchStore (TTL from `expires_in`), reuses it across calls, refreshes it before
// expiry, and re-fetches when the resource server rejects it. The caller never sees the secret.
import { memoryStore, stitch } from '../src';
import type { Stitch, StitchStore } from '../src';
import { env, oauth2 } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-oauth2-${process.pid}.jsonl`,
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
    process.env['OAUTH_CLIENT_ID'] = 'cid';
    process.env['OAUTH_CLIENT_SECRET'] = 'csecret';
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stitch protected by an oauth2 client_credentials token, with knobs per test.
const protectedStitch = (
    path: string,
    extra: Record<string, unknown> = {},
    store?: StitchStore,
): Stitch =>
    stitch({
        baseUrl: server.url,
        path,
        ...(store ? { store } : {}),
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            clientId: env('OAUTH_CLIENT_ID'),
            clientSecret: env('OAUTH_CLIENT_SECRET'),
            ...extra,
        }),
    });

test('fetches one token, reuses it across calls, and sends it as a Bearer', async () => {
    server.route('POST', '/token', {
        body: { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 },
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { ok: true },
    });

    const data = protectedStitch('/data');
    await expect(data()).resolves.toEqual({ ok: true });
    await expect(data()).resolves.toEqual({ ok: true });

    expect(server.callCount('/token')).toBe(1); // one fetch, reused on the second call
    expect(server.callCount('/data')).toBe(2);

    // The token POST is a form-encoded client_credentials grant carrying the resolved id.
    const tokenReq = server.calls('/token')[0]!;
    expect(String(tokenReq.body)).toContain('grant_type=client_credentials');
    expect(String(tokenReq.body)).toContain('client_id=cid');
});

test('a SHARED store lets two stitches share one token', async () => {
    server.route('POST', '/token', {
        body: { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 },
    });
    server.route('GET', '/a', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { r: 'a' },
    });
    server.route('GET', '/b', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { r: 'b' },
    });

    const store = memoryStore();
    const a = protectedStitch('/a', {}, store);
    const b = protectedStitch('/b', {}, store);

    expect(await a()).toEqual({ r: 'a' });
    expect(await b()).toEqual({ r: 'b' });
    expect(server.callCount('/token')).toBe(1); // ONE token, shared via the store
});

test('refreshes the token after it expires', async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'T1' : 'T2',
            token_type: 'Bearer',
            expires_in: 1, // 1s TTL
        }),
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization' },
        body: { ok: true },
    });

    // skew 0 so the token stays usable until its real expiry, isolating the expiry path.
    const data = protectedStitch('/data', { refresh: { skew: 0 } });
    await data();
    await sleep(1100); // let the cached token (and its store TTL) expire
    await data();

    expect(server.callCount('/token')).toBe(2); // expired → re-fetched
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer T1');
    expect(calls[1]!.headers['authorization']).toBe('Bearer T2'); // the refreshed token
}, 10000);

test('refreshes proactively BEFORE expiry using refresh.skew', async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'T1' : 'T2',
            token_type: 'Bearer',
            expires_in: 2, // real expiry at +2s
        }),
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization' },
        body: { ok: true },
    });

    // With a 1.5s skew the token is treated as stale ~0.5s in, well before the 2s expiry.
    const data = protectedStitch('/data', { refresh: { skew: 1500 } });
    await data();
    await sleep(600);
    await data();

    expect(server.callCount('/token')).toBe(2); // refreshed early, not at the 2s boundary
    const calls = server.calls('/data');
    expect(calls[1]!.headers['authorization']).toBe('Bearer T2');
}, 10000);

test('re-fetches the token when the resource server rejects it (401)', async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'STALE' : 'FRESH',
            token_type: 'Bearer',
            expires_in: 3600,
        }),
    });
    // First hit 401s (token rejected); after the forced refresh the retry succeeds.
    server.route('GET', '/data', {
        statuses: [401, 200],
        body: { ok: true },
    });

    const data = protectedStitch('/data');
    await expect(data()).resolves.toEqual({ ok: true });

    expect(server.callCount('/token')).toBe(2); // initial fetch + forced refresh on 401
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer STALE');
    expect(calls[1]!.headers['authorization']).toBe('Bearer FRESH');
});

test('refresh accepts a bare status number (P24/P12): a 419 wall forces one refresh', async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'STALE' : 'FRESH',
            token_type: 'Bearer',
            expires_in: 3600,
        }),
    });
    // The resource rejects the stale token with 419 (not the default 401). `refresh: 419` — a bare
    // `StatusMatch` number, the P12 dominant-field shorthand for `{ on: 419 }` (CONTRACT.md P24;
    // `419` ≡ `[419]` per P7) — classifies it as the wall, so the strategy forces exactly one
    // refresh and the retry succeeds.
    server.route('GET', '/data', {
        statuses: [419, 200],
        body: { ok: true },
    });

    const data = protectedStitch('/data', { refresh: 419 });
    await expect(data()).resolves.toEqual({ ok: true });

    expect(server.callCount('/token')).toBe(2); // initial fetch + forced refresh on the 419 wall
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer STALE');
    expect(calls[1]!.headers['authorization']).toBe('Bearer FRESH');
});

test('the refresh envelope carries both `on` and `skew` (P24)', async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'STALE' : 'FRESH',
            token_type: 'Bearer',
            expires_in: 3600,
        }),
    });
    // Both facets folded into one envelope: `on: 419` classifies the wall (default is 401), and
    // `skew: 0` keeps the token usable until real expiry so ONLY the 419 forces the refresh.
    server.route('GET', '/data', { statuses: [419, 200], body: { ok: true } });

    const data = protectedStitch('/data', {
        refresh: { on: 419, skew: 0 },
    });
    await expect(data()).resolves.toEqual({ ok: true });

    expect(server.callCount('/token')).toBe(2); // initial + the forced 419 refresh
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer STALE');
    expect(calls[1]!.headers['authorization']).toBe('Bearer FRESH');
});
