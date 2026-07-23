// ADR 0020 — `auth` accepts a declarative `AuthDescriptor` beside the strategy factories. These
// pin the two guarantees the ADR turns on: a descriptor produces byte-identical WIRE behaviour to
// the factory it sugars (all five strategies), and the intake-detection (Q6), atomic-`extends` slot
// (Q7), and `__config` redaction rules all hold. The apiKey factory's new symmetric `{ in, name,
// value }` shape (incl. `in: 'cookie'`) is exercised here too.
import {
    apiKey,
    basic,
    bearer,
    cookieSession,
    env,
    oauth2,
    stitch,
} from '../src';
import type { AuthConfig } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
    // Arm the ADR 0020 descriptor resolver. In real code a descriptor's credential is an `env()`
    // thunk, and calling `env()` arms the resolver (the seam that keeps the strategy factories OUT of
    // the lean `import { stitch }` bundle). These parity tests use literal secrets for clarity, so
    // trigger the same arming once here — exactly what a real `token: env('…')` descriptor does.
    void env('STITCH_ADR20_ARM');
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

// Drive the factory form then the descriptor form against ONE route and hand back the two recorded
// requests, so each parity test can assert they carry byte-identical credentials.
async function twoRequests(
    path: string,
    factory: AuthConfig,
    descriptor: AuthConfig,
) {
    server.route('GET', path, { body: { ok: true } });
    await stitch({ baseUrl: server.url, path, auth: factory })();
    await stitch({ baseUrl: server.url, path, auth: descriptor })();
    const calls = server.calls(path);
    return { factory: calls[0]!, descriptor: calls[1]! };
}

describe('ADR 0020 — declarative auth descriptors', () => {
    // ── descriptor → identical wire behaviour as its factory ────────────────
    describe('a descriptor produces the same request as its factory', () => {
        test('bearer', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-bearer',
                bearer('tok-123'),
                { strategy: 'bearer', token: 'tok-123' },
            );
            expect(descriptor.headers['authorization']).toBe('Bearer tok-123');
            expect(descriptor.headers['authorization']).toBe(
                factory.headers['authorization'],
            );
        });

        test('apiKey — header (default location + default name)', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-ak-h',
                apiKey({ value: 'sk-1' }),
                { strategy: 'apiKey', value: 'sk-1' },
            );
            expect(descriptor.headers['x-api-key']).toBe('sk-1');
            expect(descriptor.headers['x-api-key']).toBe(
                factory.headers['x-api-key'],
            );
        });

        test('apiKey — header with a custom name', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-ak-hn',
                apiKey({ name: 'X-Custom-Key', value: 'sk-2' }),
                {
                    strategy: 'apiKey',
                    in: 'header',
                    name: 'X-Custom-Key',
                    value: 'sk-2',
                },
            );
            expect(descriptor.headers['x-custom-key']).toBe('sk-2');
            expect(descriptor.headers['x-custom-key']).toBe(
                factory.headers['x-custom-key'],
            );
        });

        test('apiKey — query param', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-ak-q',
                apiKey({ in: 'query', name: 'access_token', value: 'sk-3' }),
                {
                    strategy: 'apiKey',
                    in: 'query',
                    name: 'access_token',
                    value: 'sk-3',
                },
            );
            expect(descriptor.query['access_token']).toBe('sk-3');
            expect(descriptor.query['access_token']).toBe(
                factory.query['access_token'],
            );
        });

        test('apiKey — cookie', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-ak-c',
                apiKey({ in: 'cookie', name: 'sid', value: 'sk-4' }),
                {
                    strategy: 'apiKey',
                    in: 'cookie',
                    name: 'sid',
                    value: 'sk-4',
                },
            );
            expect(descriptor.cookies['sid']).toBe('sk-4');
            expect(descriptor.cookies['sid']).toBe(factory.cookies['sid']);
        });

        test('basic', async () => {
            const { factory, descriptor } = await twoRequests(
                '/d-basic',
                basic({ user: 'ada', pass: 'pw' }),
                { strategy: 'basic', user: 'ada', pass: 'pw' },
            );
            // base64('ada:pw') — the exact same Basic credential either way.
            expect(descriptor.headers['authorization']).toMatch(/^Basic /);
            expect(descriptor.headers['authorization']).toBe(
                factory.headers['authorization'],
            );
        });

        test('oauth2 — fetches and attaches the same Bearer token', async () => {
            server.route('POST', '/token', {
                body: {
                    access_token: 'T1',
                    token_type: 'Bearer',
                    expires_in: 3600,
                },
            });
            // `requireHeader` gates the route: the call only resolves if `Bearer T1` was sent.
            server.route('GET', '/o-data', {
                requireHeader: { name: 'authorization', value: 'Bearer T1' },
                body: { ok: true },
            });
            const opts = {
                tokenUrl: `${server.url}/token`,
                clientId: 'cid',
                clientSecret: 'csecret',
            };
            const viaFactory = stitch({
                baseUrl: server.url,
                path: '/o-data',
                auth: oauth2(opts),
            });
            const viaDescriptor = stitch({
                baseUrl: server.url,
                path: '/o-data',
                auth: { strategy: 'oauth2', ...opts },
            });
            await expect(viaFactory()).resolves.toEqual({ ok: true });
            await expect(viaDescriptor()).resolves.toEqual({ ok: true });
            // Both passed the `Bearer T1` gate; each standalone stitch fetched its own token.
            expect(server.callCount('/o-data')).toBe(2);
        });

        test('cookieSession — captures and replays the same session cookie', async () => {
            server.route('POST', '/login', {
                setCookie: { name: 'sid', value: 'GOOD' },
                body: { ok: true },
            });
            server.route('GET', '/cs-data', {
                requireCookie: { name: 'sid' },
                body: { user: 'ada' },
            });
            const login = stitch({
                method: 'POST',
                baseUrl: server.url,
                path: '/login',
            });
            const opts = { login, cookie: 'sid', scope: 'app' as const };
            const viaFactory = stitch({
                baseUrl: server.url,
                path: '/cs-data',
                auth: cookieSession(opts),
            });
            const viaDescriptor = stitch({
                baseUrl: server.url,
                path: '/cs-data',
                auth: { strategy: 'cookieSession', ...opts },
            });
            await expect(viaFactory()).resolves.toEqual({ user: 'ada' });
            await expect(viaDescriptor()).resolves.toEqual({ user: 'ada' });
            const calls = server.calls('/cs-data');
            expect(calls[0]?.cookies['sid']).toBe('GOOD');
            expect(calls[1]?.cookies['sid']).toBe('GOOD');
        });
    });

    // ── detection: strategy vs descriptor vs neither (Q6) ───────────────────
    describe('intake detection (Q6)', () => {
        test('an object carrying BOTH `apply` and `strategy` is a strategy — apply wins', async () => {
            server.route('GET', '/both', { body: { ok: true } });
            // A hand-spliced object: a real `apply` that sets a sentinel header, plus a misleading
            // `strategy`/`token`. Detection must RUN `apply`, not resolve the bearer descriptor.
            // Structurally a valid strategy (it has `apply`) that also carries a `strategy` tag.
            // Its inferred type is assignable to `AuthConfig` as-is (a variable skips the literal's
            // excess-property check), so no cast is needed — and detection must still pick `apply`.
            const spliced = {
                strategy: 'bearer',
                token: 'should-be-ignored',
                apply(req: { headers: Record<string, string> }) {
                    req.headers['x-sentinel'] = 'from-apply';
                },
            };
            await stitch({
                baseUrl: server.url,
                path: '/both',
                auth: spliced,
            })();
            const c = server.calls('/both')[0];
            expect(c?.headers['x-sentinel']).toBe('from-apply');
            // The descriptor's bearer token was NOT applied.
            expect(c?.headers['authorization']).toBeUndefined();
        });

        test('auth with neither `apply` nor `strategy` throws at construction', () => {
            expect(() =>
                stitch({
                    baseUrl: server.url,
                    path: '/x',
                    auth: {} as unknown as AuthConfig,
                }),
            ).toThrow(/needs .apply. \(a strategy\) or .strategy./i);
        });

        test('an unknown `strategy` id throws at construction', () => {
            expect(() =>
                stitch({
                    baseUrl: server.url,
                    path: '/x',
                    auth: {
                        strategy: 'magic',
                        token: 'x',
                    } as unknown as AuthConfig,
                }),
            ).toThrow(/unknown auth strategy/i);
        });
    });

    // ── extends: auth is an atomic last-writer-wins slot, never deep-merged (Q7) ──
    describe('extends — auth is an atomic slot (Q7)', () => {
        test('a child descriptor replaces an inherited strategy wholesale (no blend)', async () => {
            server.route('GET', '/ext1', { body: { ok: true } });
            await stitch({
                extends: [{ auth: bearer('BASE') }],
                baseUrl: server.url,
                path: '/ext1',
                auth: { strategy: 'apiKey', name: 'X-Key', value: 'sk-child' },
            })();
            const c = server.calls('/ext1')[0];
            // Child wins entirely: the apiKey header is set, the inherited bearer is GONE.
            expect(c?.headers['x-key']).toBe('sk-child');
            expect(c?.headers['authorization']).toBeUndefined();
        });

        test('a child strategy replaces an inherited descriptor wholesale', async () => {
            server.route('GET', '/ext2', { body: { ok: true } });
            await stitch({
                extends: [
                    {
                        auth: {
                            strategy: 'apiKey',
                            name: 'X-Base',
                            value: 'sk-base',
                        },
                    },
                ],
                baseUrl: server.url,
                path: '/ext2',
                auth: bearer('CHILD'),
            })();
            const c = server.calls('/ext2')[0];
            expect(c?.headers['authorization']).toBe('Bearer CHILD');
            expect(c?.headers['x-base']).toBeUndefined();
        });

        test('two descriptors — last writer wins, fields never blend', async () => {
            server.route('GET', '/ext3', { body: { ok: true } });
            await stitch({
                extends: [
                    {
                        auth: {
                            strategy: 'apiKey',
                            name: 'X-Base',
                            value: 'sk-base',
                        },
                    },
                ],
                baseUrl: server.url,
                path: '/ext3',
                auth: {
                    strategy: 'apiKey',
                    in: 'query',
                    name: 'child_key',
                    value: 'sk-child',
                },
            })();
            const c = server.calls('/ext3')[0];
            // Only the child's query key; the base header name did NOT survive a field-merge.
            expect(c?.query['child_key']).toBe('sk-child');
            expect(c?.headers['x-base']).toBeUndefined();
            expect(c?.query['x-base']).toBeUndefined();
        });
    });

    // ── __config projection + redaction ─────────────────────────────────────
    describe('__config projection + redaction', () => {
        test('a descriptor surfaces the same authScheme as the factory, with no live auth', () => {
            const viaFactory = stitch({
                path: '/x',
                auth: apiKey({ in: 'cookie', name: 'sid', value: 'sk' }),
            });
            const viaDescriptor = stitch({
                path: '/x',
                auth: {
                    strategy: 'apiKey',
                    in: 'cookie',
                    name: 'sid',
                    value: 'sk',
                },
            });
            expect(viaDescriptor.__config.authScheme).toEqual({
                type: 'apiKey',
                in: 'cookie',
                name: 'sid',
            });
            expect(viaDescriptor.__config.authScheme).toEqual(
                viaFactory.__config.authScheme,
            );
            // The live, secret-bearing auth is stripped from the public config either way.
            expect(
                (viaDescriptor.__config as { auth?: unknown }).auth,
            ).toBeUndefined();
        });

        test('a descriptor never lands its secret (or the raw shell) on __config', () => {
            const s = stitch({
                path: '/x',
                auth: { strategy: 'bearer', token: 'super-secret-token' },
            });
            const json = JSON.stringify(s.__config);
            expect(json).not.toContain('super-secret-token');
            expect(json).not.toContain('strategy');
        });
    });

    // ── apiKey factory — symmetric { in, name, value } shape (ADR 0020 / #485) ──
    describe('apiKey factory — symmetric shape', () => {
        test('`name` sets the header name (symmetric with query/cookie)', async () => {
            server.route('GET', '/sym-h', { body: { ok: true } });
            await stitch({
                baseUrl: server.url,
                path: '/sym-h',
                auth: apiKey({ name: 'X-Sym', value: 'v' }),
            })();
            expect(server.calls('/sym-h')[0]?.headers['x-sym']).toBe('v');
        });

        test('the legacy `header` alias still names the header (back-compat)', async () => {
            server.route('GET', '/sym-legacy', { body: { ok: true } });
            await stitch({
                baseUrl: server.url,
                path: '/sym-legacy',
                auth: apiKey({ header: 'X-Legacy', value: 'v' }),
            })();
            expect(server.calls('/sym-legacy')[0]?.headers['x-legacy']).toBe(
                'v',
            );
        });

        test('`name` wins when both `name` and `header` are given', async () => {
            server.route('GET', '/sym-both', { body: { ok: true } });
            await stitch({
                baseUrl: server.url,
                path: '/sym-both',
                auth: apiKey({ name: 'X-Win', header: 'X-Lose', value: 'v' }),
            })();
            const c = server.calls('/sym-both')[0];
            expect(c?.headers['x-win']).toBe('v');
            expect(c?.headers['x-lose']).toBeUndefined();
        });

        test('in: cookie attaches name=value on the Cookie header (default name `session`)', async () => {
            server.route('GET', '/sym-c', { body: { ok: true } });
            await stitch({
                baseUrl: server.url,
                path: '/sym-c',
                auth: apiKey({ in: 'cookie', value: 'v' }),
            })();
            expect(server.calls('/sym-c')[0]?.cookies['session']).toBe('v');
        });
    });
});
