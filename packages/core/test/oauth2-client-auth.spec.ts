// oauth2 `clientAuth`: how the client authenticates to the token endpoint (RFC 6749 §2.3.1).
// Default 'post' (client_secret_post) keeps id/secret in the form body; 'basic'
// (client_secret_basic) moves them into an HTTP Basic header — what providers like Kyivstar SMS
// require. Also covers the token-request escape hatches: `audience`, `params`, and `headers`.
import { stitch } from '../src';
import type { Stitch } from '../src';
import { env, oauth2 } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-oauth2-clientauth-${process.pid}.jsonl`,
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

// A stitch protected by an oauth2 token, with per-test knobs spread onto the strategy.
const protectedStitch = (
    path: string,
    extra: Record<string, unknown> = {},
): Stitch =>
    stitch({
        baseUrl: server.url,
        path,
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            clientId: env('OAUTH_CLIENT_ID'),
            clientSecret: env('OAUTH_CLIENT_SECRET'),
            ...extra,
        }),
    });

// The token POST body is form-encoded; parse it back into params for assertions.
const tokenBody = (i = 0): URLSearchParams =>
    new URLSearchParams(String(server.calls('/token')[i]!.body));
const tokenHeaders = (i = 0): Record<string, string> =>
    server.calls('/token')[i]!.headers;

const okToken = { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 };

test("clientAuth: 'basic' sends Basic <base64(id:secret)> and keeps creds out of the body", async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { ok: true },
    });

    const data = protectedStitch('/data', { clientAuth: 'basic' });
    await expect(data()).resolves.toEqual({ ok: true });
    await expect(data()).resolves.toEqual({ ok: true }); // reuse the cached token

    expect(server.callCount('/token')).toBe(1);

    // The token request authenticates with an HTTP Basic header...
    const expected = `Basic ${Buffer.from('cid:csecret').toString('base64')}`;
    expect(tokenHeaders()['authorization']).toBe(expected);
    // ...and the body carries grant_type/scope only — never the credentials.
    const body = tokenBody();
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBeNull();
    expect(body.get('client_secret')).toBeNull();
});

test("default clientAuth is 'post': creds in the body, no Authorization header on the token request", async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization' },
        body: { ok: true },
    });

    const data = protectedStitch('/data'); // no clientAuth → 'post'
    await expect(data()).resolves.toEqual({ ok: true });

    const body = tokenBody();
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csecret');
    expect(tokenHeaders()['authorization']).toBeUndefined();
});

test("clientAuth: 'basic' refreshes on a 401 like the post flow does", async () => {
    server.route('POST', '/token', {
        body: (i: number) => ({
            access_token: i === 0 ? 'STALE' : 'FRESH',
            token_type: 'Bearer',
            expires_in: 3600,
        }),
    });
    // First hit 401s (token rejected); after the forced refresh the retry succeeds.
    server.route('GET', '/data', { statuses: [401, 200], body: { ok: true } });

    const data = protectedStitch('/data', { clientAuth: 'basic' });
    await expect(data()).resolves.toEqual({ ok: true });

    expect(server.callCount('/token')).toBe(2); // initial fetch + forced refresh on 401
    // Both token requests use Basic auth.
    const expected = `Basic ${Buffer.from('cid:csecret').toString('base64')}`;
    expect(tokenHeaders(0)['authorization']).toBe(expected);
    expect(tokenHeaders(1)['authorization']).toBe(expected);
    const calls = server.calls('/data');
    expect(calls[0]!.headers['authorization']).toBe('Bearer STALE');
    expect(calls[1]!.headers['authorization']).toBe('Bearer FRESH');
});

test('audience is added to the token-request body', async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', { body: { ok: true } });

    const data = protectedStitch('/data', { audience: 'urn:my-api' });
    await data();

    expect(tokenBody().get('audience')).toBe('urn:my-api');
});

test('params merge into the body and can override grant_type', async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', { body: { ok: true } });

    const data = protectedStitch('/data', {
        params: { grant_type: 'urn:custom:grant', resource: 'urn:my:res' },
    });
    await data();

    const body = tokenBody();
    expect(body.get('grant_type')).toBe('urn:custom:grant'); // overrode the default
    expect(body.get('resource')).toBe('urn:my:res');
});

test('params can never shadow the resolved client_secret (post mode)', async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', { body: { ok: true } });

    const data = protectedStitch('/data', {
        params: { client_secret: 'HACKED', client_id: 'HACKED' },
    });
    await data();

    const body = tokenBody();
    expect(body.get('client_secret')).toBe('csecret'); // resolved creds applied last
    expect(body.get('client_id')).toBe('cid');
});

test('headers add to the token request but cannot clobber the basic Authorization header', async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', { body: { ok: true } });

    const data = protectedStitch('/data', {
        clientAuth: 'basic',
        headers: { 'X-Tenant': 'acme', authorization: 'must-not-win' },
    });
    await data();

    const headers = tokenHeaders();
    expect(headers['x-tenant']).toBe('acme');
    // The Basic credentials win — the caller header can't displace the client auth.
    expect(headers['authorization']).toBe(
        `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
});
