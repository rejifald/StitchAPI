// `CookieSessionOptions.credentialsOf` — the derivation function that supplies the login call's
// credentials (CONTRACT.md P6: `key` is a value, `keyOf` is a function that produces one, so a
// callback that produces credentials is `credentialsOf`). It was `loginInput`, which named the
// slot it FEEDS rather than what it returns, and put a second `login`-prefixed member on the
// envelope beside the required `login` Stitch — a P24 prefix group that needed a lint carve-out to
// stay flat, for two members that are different value-kinds entirely. The rename dissolves it.
//
// Both directions are pinned here: the new spelling works and carries the bound principal, and the
// old spelling is a COMPILE error (enforced by `check:types` — an unused `@ts-expect-error` would
// itself fail — not at runtime; the closure is never invoked).
import { seam, stitch } from '../src';
import { cookieSession } from '../src/auth';
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

test('`credentialsOf` supplies the login body, and never the caller', async () => {
    server.route('POST', '/login', {
        setCookies: [{ name: 'sid', value: 'ABC' }],
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
            login: stitch({
                method: 'POST',
                baseUrl: server.url,
                path: '/login',
            }),
            cookie: 'sid',
            credentialsOf: () => ({ body: { u: 'alice', p: 's3cret' } }),
            tenancy: 'app',
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    expect(server.calls('/login')[0]?.body).toMatchObject({
        u: 'alice',
        p: 's3cret',
    });
});

test('`credentialsOf` receives the seam-bound principal', async () => {
    server.route('POST', '/login', {
        setCookies: [{ name: 'sid', value: 'ABC' }],
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const api = seam({ baseUrl: server.url });
    const data = api.as('tenant-7').stitch({
        path: '/data',
        auth: cookieSession({
            login: api.stitch({ method: 'POST', path: '/login' }),
            cookie: 'sid',
            credentialsOf: (principal) => ({ body: { u: principal } }),
        }),
    });

    await expect(data()).resolves.toEqual({ ok: true });
    expect(server.calls('/login')[0]?.body).toMatchObject({ u: 'tenant-7' });
    await api.close();
});

test('the old `loginInput` spelling is gone (alias-free break, P19)', () => {
    const rejected = () =>
        cookieSession({
            login: stitch({ baseUrl: 'https://x', path: '/login' }),
            cookie: 'sid',
            tenancy: 'app',
            // @ts-expect-error — renamed to `credentialsOf` (P6); no alias was kept (P19).
            loginInput: () => ({ body: {} }),
        });
    expect(typeof rejected).toBe('function');
});
