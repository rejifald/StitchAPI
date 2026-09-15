// `OAuth2Options.client` — the P24 fold of `clientId`/`clientSecret`/`clientAuth` into one named,
// exported `OAuth2ClientOptions` envelope (`{ id, secret, via }`). The three used to sit flat and
// were exempted from lint R8 as "an RFC 6749 mirror". They were not one: RFC 6749 §2.3.1 names the
// client authentication METHODS and defines no `clientAuth` parameter at all, and `OAuth2Options`
// has no identity mapping to protect either — every member is TRANSLATED into a snake_case wire
// key where the token-request body is built, which is the translated house contract of P18's
// second half, not a mirror.
//
// Both directions are pinned here: the new spelling works on the wire in both client-auth modes,
// and the old flat spellings are COMPILE errors. The type-level assertions are enforced by
// `check:types` — an unused `@ts-expect-error` would itself fail — not at runtime; those closures
// are never invoked.
import { stitch } from '../src';
import { oauth2 } from '../src/auth';
import type { OAuth2ClientOptions } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

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

const okToken = { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 };
const tokenBody = (i = 0): URLSearchParams =>
    new URLSearchParams(String(server.calls('/token')[i]!.body));

test('`client: { id, secret }` reaches the wire as client_id/client_secret', async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { ok: true },
    });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            client: { id: 'cid', secret: 'csecret' },
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    // The camelCase envelope is TRANSLATED at the form-body builder — the very fact that made the
    // "RFC 6749 mirror" exemption wrong, so it is worth asserting rather than assuming.
    const body = tokenBody();
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csecret');
});

test("`client.via: 'basic'` moves the same pair into the Basic header", async () => {
    server.route('POST', '/token', { body: okToken });
    server.route('GET', '/data', { body: { ok: true } });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            client: { id: 'cid', secret: 'csecret', via: 'basic' },
        }),
    });

    await data();

    const headers = server.calls('/token')[0]!.headers;
    expect(headers['authorization']).toBe(
        `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(tokenBody().get('client_secret')).toBeNull();
});

test('the flat `clientId`/`clientSecret`/`clientAuth` spellings are gone (alias-free break, P19)', () => {
    const rejected = () => [
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            client: { id: 'cid', secret: 'csecret' },
            // @ts-expect-error — folded into `client.id` (P24); no alias was kept (P19).
            clientId: 'cid',
        }),
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            client: { id: 'cid', secret: 'csecret' },
            // @ts-expect-error — folded into `client.secret` (P24); no alias was kept (P19).
            clientSecret: 'csecret',
        }),
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            client: { id: 'cid', secret: 'csecret' },
            // @ts-expect-error — folded into `client.via` (P24); no alias was kept (P19).
            clientAuth: 'basic',
        }),
    ];
    expect(typeof rejected).toBe('function');
});

test('`client` is required and `client: {}` is a compile error (P20 without `AtLeastOne`)', () => {
    const rejected = () => [
        // @ts-expect-error — `client` is required: there is no default client identity.
        oauth2({ tokenUrl: 'https://auth.example.com/token' }),
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            // @ts-expect-error — the opaque `client: {}` is rejected; `id` and `secret` are required.
            client: {},
        }),
        // `AtLeastOne<OAuth2ClientOptions>` would have made each of the next two legal by
        // re-optionalising whichever required member its arm did not pick — which is precisely why
        // the slot is a plain required `OAuth2ClientOptions` instead.
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            // @ts-expect-error — `secret` is required; a client id alone cannot authenticate.
            client: { id: 'cid' },
        }),
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            // @ts-expect-error — `id` is required; a secret alone names no client.
            client: { secret: 'csecret' },
        }),
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            // @ts-expect-error — `via` alone is not a client; it tunes one.
            client: { via: 'basic' },
        }),
    ];
    expect(typeof rejected).toBe('function');
});

test('`client.auth` is rejected — the P2 collision with `StitchConfig.auth` (no alias)', () => {
    // `auth` is already spent on `StitchConfig.auth`, which holds an `AuthStrategy` OBJECT. One
    // token for two concepts over two value-spaces is what P2 forbids, so the client-authentication
    // member is `via`. This pins the rename the only way that survives a refactor: `auth` must be
    // an EXCESS property here, not a quietly-accepted second spelling (P19 — no alias, `rc`).
    const rejected = () =>
        oauth2({
            tokenUrl: 'https://auth.example.com/token',
            client: {
                id: 'cid',
                secret: 'csecret',
                // @ts-expect-error — renamed to `client.via` (P2); no alias was kept (P19).
                auth: 'basic',
            },
        });
    expect(typeof rejected).toBe('function');
});

test('`OAuth2ClientOptions` is exported and authorable on its own (P14)', () => {
    // A named, exported envelope is one a consumer can hold in a variable and pass in — the whole
    // point of P14 over an anonymous inline shape.
    const client: OAuth2ClientOptions = {
        id: () => 'cid',
        secret: () => 'csecret',
        via: 'post',
    };
    const strategy = oauth2({
        tokenUrl: 'https://auth.example.com/token',
        client,
    });
    expect(strategy.name).toBe('oauth2');
    expect(strategy.scheme).toMatchObject({ type: 'oauth2' });
});
