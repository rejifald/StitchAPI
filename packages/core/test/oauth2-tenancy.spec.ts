// OAuth2 token tenancy (ADR 0002 §3). The default `'app'` shares one client_credentials token
// across every caller — the token is the application's identity, not a user's. Opting into
// `tenancy: 'principal'` folds the seam-bound principal into the token's vault key, so each tenant
// caches its own token and a missing principal fails closed (mirroring cookieSession's `scope`).
import { seam, stitch } from '../src';
import type { Seam } from '../src';
import { env, oauth2 } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-oauth2-tenancy-${process.pid}.jsonl`,
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

// A seam whose stitches authenticate with an oauth2 client_credentials token; tenancy per test.
const protectedSeam = (tenancy?: 'principal' | 'app'): Seam =>
    seam({
        baseUrl: server.url,
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            clientId: env('OAUTH_CLIENT_ID'),
            clientSecret: env('OAUTH_CLIENT_SECRET'),
            ...(tenancy ? { tenancy } : {}),
        }),
    });

test("default tenancy 'app' shares ONE token across principals", async () => {
    server.route('POST', '/token', {
        body: { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 },
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { ok: true },
    });

    const api = protectedSeam(); // default 'app'
    await expect(api.as('tenant-a').stitch('/data')()).resolves.toEqual({
        ok: true,
    });
    await expect(api.as('tenant-b').stitch('/data')()).resolves.toEqual({
        ok: true,
    });

    expect(server.callCount('/token')).toBe(1); // one app-wide token, shared across tenants
});

test("tenancy 'principal' caches a SEPARATE token per principal — no cross-tenant bleed", async () => {
    // The token endpoint hands out a distinct token per fetch, so we can prove isolation.
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'T-A' : 'T-B',
            token_type: 'Bearer',
            expires_in: 3600,
        }),
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization' },
        body: { ok: true },
    });

    const api = protectedSeam('principal');
    await api.as('tenant-a').stitch('/data')();
    await api.as('tenant-b').stitch('/data')();
    // tenant-a again: its own token is already cached, so NO new token fetch happens.
    await api.as('tenant-a').stitch('/data')();

    expect(server.callCount('/token')).toBe(2); // one fetch per principal; A reused on the 3rd call
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer T-A');
    expect(calls[1]!.headers['authorization']).toBe('Bearer T-B');
    expect(calls[2]!.headers['authorization']).toBe('Bearer T-A'); // A's token, never B's
});

test("tenancy 'principal' fails closed when no principal is bound", async () => {
    server.route('POST', '/token', {
        body: { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 },
    });
    server.route('GET', '/data', { body: { ok: true } });

    // A bare stitch (no seam, no principal) must refuse rather than silently share one app-wide
    // token — per-tenant auth can never quietly collapse to a shared credential.
    const bare = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            clientId: env('OAUTH_CLIENT_ID'),
            clientSecret: env('OAUTH_CLIENT_SECRET'),
            tenancy: 'principal',
        }),
    });

    await expect(bare()).rejects.toThrow(/requires a bound principal/);
    expect(server.callCount('/token')).toBe(0); // refused before any token request
});
