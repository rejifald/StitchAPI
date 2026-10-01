// Header NAMES are case-insensitive on the wire, but the bag they travel in is not. Every auth
// strategy reads and writes `req.headers` by one key (`cookie`, `authorization`, the lower-cased
// `apiKey` name), so a caller's `Cookie` / `X-API-Key` / `Authorization` was a DIFFERENT key to it:
// the strategy's pair landed beside the caller's, and `fetch` joined the two on the wire —
// `Cookie: tracking=xyz; SESSION=attacker; SESSION=sess_live`, `X-API-Key: FORGED, REAL`. That
// bypassed the cookie-fixation fix of #866 with nothing but a capital letter. The engine now folds
// every header name to lower case once, in `buildRequest`, before auth runs. These specs drive the
// real engine and read what the vendor actually received.
import { stitch } from '../src';
import type { AdapterRequest } from '../src';
import { apiKey, basic, bearer, cookieSession, env } from '../src/auth';
import { mockAdapter } from '../src/testing';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-header-casing-${process.pid}.jsonl`,
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
    process.env['HC_USER'] = 'u';
    process.env['HC_PASS'] = 'p';
    server.route('GET', '/data', { body: { ok: true } });
});

const sent = (): Record<string, string | string[] | undefined> =>
    server.calls('/data')[0]!.headers;

const credentialsOf = () => ({
    body: { u: env('HC_USER')(), p: env('HC_PASS')() },
});

const loginStitch = () =>
    stitch({
        method: 'POST',
        baseUrl: server.url,
        path: '/login',
        wire: { body: 'form' },
    });

describe('a forged cookie in any case is replaced, never joined (#866)', () => {
    test.each(['cookie', 'Cookie', 'COOKIE', 'cOoKiE'])(
        'cookieSession (named): input header %s',
        async (spelling) => {
            server.route('POST', '/login', {
                setCookies: [{ name: 'SESSION', value: 'sess_live_cookie' }],
                body: { ok: true },
            });
            const data = stitch({
                baseUrl: server.url,
                path: '/data',
                auth: cookieSession({
                    login: loginStitch(),
                    cookie: 'SESSION',
                    credentialsOf,
                    tenancy: 'app',
                }),
            });
            await data({
                headers: { [spelling]: 'tracking=xyz; SESSION=attacker' },
            });
            expect(sent()['cookie']).toBe(
                'tracking=xyz; SESSION=sess_live_cookie',
            );
        },
    );

    test.each(['Cookie', 'COOKIE'])(
        'cookieSession (jar mode): input header %s',
        async (spelling) => {
            server.route('POST', '/login', {
                setCookies: [
                    { name: 'sid', value: 'ABC' },
                    { name: 'csrf', value: 'XYZ' },
                ],
                body: { ok: true },
            });
            const data = stitch({
                baseUrl: server.url,
                path: '/data',
                auth: cookieSession({
                    login: loginStitch(),
                    cookie: '*',
                    credentialsOf,
                    tenancy: 'app',
                }),
            });
            await data({
                headers: { [spelling]: 'csrf=forged; theme=dark; sid=forged' },
            });
            expect(sent()['cookie']).toBe('csrf=XYZ; theme=dark; sid=ABC');
        },
    );

    test.each(['Cookie', 'COOKIE'])(
        'apiKey({ in: "cookie" }): input header %s',
        async (spelling) => {
            const data = stitch({
                baseUrl: server.url,
                path: '/data',
                auth: apiKey({ in: 'cookie', name: 'sid', secret: 'REAL' }),
            });
            await data({ headers: { [spelling]: 'theme=dark; sid=FORGED' } });
            expect(sent()['cookie']).toBe('theme=dark; sid=REAL');
        },
    );

    test('a Cookie in the stitch CONFIG is folded too, and the call input wins a clash', async () => {
        const data = stitch({
            baseUrl: server.url,
            path: '/data',
            headers: { Cookie: 'sid=FROM_CONFIG; a=1' },
            auth: apiKey({ in: 'cookie', name: 'sid', secret: 'REAL' }),
        });
        await data();
        expect(sent()['cookie']).toBe('sid=REAL; a=1');
        server.reset();
        server.route('GET', '/data', { body: { ok: true } });
        await data({ headers: { cookie: 'b=2' } });
        expect(sent()['cookie']).toBe('b=2; sid=REAL'); // input replaced the config header outright
    });
});

describe('a cookie NAME is matched case-insensitively when replaced', () => {
    // RFC 6265 calls names case-sensitive, but a vendor on ASP.NET reads `session` and `SESSION` as
    // one cookie, so an exact match would leave `session=forged` standing beside the real pair.
    test('apiKey: session=forged and Sid=forged2 do not survive next to SID', async () => {
        const data = stitch({
            baseUrl: server.url,
            path: '/data',
            auth: apiKey({ in: 'cookie', name: 'SID', secret: 'REAL' }),
        });
        await data({
            headers: { cookie: 'sid=forged; theme=dark; Sid=forged2' },
        });
        expect(sent()['cookie']).toBe('SID=REAL; theme=dark');
    });

    test('cookieSession: a lower-cased forged twin of the session cookie is replaced', async () => {
        server.route('POST', '/login', {
            setCookies: [{ name: 'SESSION', value: 'sess_live_cookie' }],
            body: { ok: true },
        });
        const data = stitch({
            baseUrl: server.url,
            path: '/data',
            auth: cookieSession({
                login: loginStitch(),
                cookie: 'SESSION',
                credentialsOf,
                tenancy: 'app',
            }),
        });
        await data({ headers: { cookie: 'session=attacker; theme=dark' } });
        expect(sent()['cookie']).toBe('SESSION=sess_live_cookie; theme=dark');
    });
});

describe('a credential header in any case is replaced, never joined', () => {
    test.each(['X-API-Key', 'X-Api-Key', 'x-api-key', 'X-API-KEY'])(
        'apiKey (header): input header %s',
        async (spelling) => {
            const data = stitch({
                baseUrl: server.url,
                path: '/data',
                auth: apiKey({ secret: 'REAL' }),
            });
            await data({ headers: { [spelling]: 'FORGED' } });
            expect(sent()['x-api-key']).toBe('REAL'); // not "FORGED, REAL"
        },
    );

    test('apiKey (header) under a custom name', async () => {
        const data = stitch({
            baseUrl: server.url,
            path: '/data',
            auth: apiKey({ name: 'X-Vendor-Key', secret: 'REAL' }),
        });
        await data({ headers: { 'x-VENDOR-key': 'FORGED' } });
        expect(sent()['x-vendor-key']).toBe('REAL');
    });

    test.each(['Authorization', 'AUTHORIZATION', 'authorization'])(
        'bearer: input header %s',
        async (spelling) => {
            const data = stitch({
                baseUrl: server.url,
                path: '/data',
                auth: bearer('REAL'),
            });
            await data({ headers: { [spelling]: 'Bearer FORGED' } });
            expect(sent()['authorization']).toBe('Bearer REAL');
        },
    );

    test('bearer and basic: a config-level Authorization is replaced too', async () => {
        const viaBearer = stitch({
            baseUrl: server.url,
            path: '/data',
            headers: { Authorization: 'Bearer FROM_CONFIG' },
            auth: bearer('REAL'),
        });
        await viaBearer();
        expect(sent()['authorization']).toBe('Bearer REAL');

        server.reset();
        server.route('GET', '/data', { body: { ok: true } });
        const viaBasic = stitch({
            baseUrl: server.url,
            path: '/data',
            headers: { AUTHORIZATION: 'Basic Rk9SR0VE' },
            auth: basic('u', 'p'),
        });
        await viaBasic({ headers: { Authorization: 'Basic Rk9SR0VE' } });
        expect(sent()['authorization']).toBe(
            `Basic ${Buffer.from('u:p').toString('base64')}`,
        );
    });
});

describe('what the adapter receives', () => {
    const seen = async (
        config: Record<string, unknown>,
        input?: Record<string, unknown>,
    ): Promise<AdapterRequest> => {
        let request: AdapterRequest | undefined;
        const call = stitch({
            url: 'https://x.test/a',
            adapter: (req) => {
                request = req;
                return Promise.resolve({ status: 200, headers: {}, body: {} });
            },
            ...config,
        });
        await call(input);
        return request!;
    };

    test('every header name arrives lower-cased; a later source wins a clash', async () => {
        const req = await seen(
            { headers: { 'X-Trace': 'config', Accept: 'application/json' } },
            { headers: { 'x-TRACE': 'input', 'X-Other': '1' } },
        );
        expect(req.headers).toEqual({
            'x-trace': 'input',
            accept: 'application/json',
            'x-other': '1',
        });
    });

    test('a caller-supplied Idempotency-Key in any case suppresses the generated one', async () => {
        const mine = await seen(
            { method: 'POST', idempotency: true },
            { headers: { 'IDEMPOTENCY-KEY': 'mine' } },
        );
        expect(mine.headers).toEqual({ 'idempotency-key': 'mine' });
        const generated = await seen({ method: 'POST', idempotency: true });
        expect(Object.keys(generated.headers)).toEqual(['idempotency-key']);
    });
});

// The same fold is what every other reader of the built request sees: a hook, a mock responder, a
// mock predicate, the spy. (BREAKING for a reader that looked a header up by its authored spelling.)
describe('hooks and mocks read lower-case names', () => {
    test('hooks.onRequest: ctx.req.headers is folded, and carries the credential the strategy wrote', async () => {
        let seenInHook: Record<string, string> | undefined;
        const call = stitch({
            url: 'https://x.test/a',
            headers: { 'X-Trace': 'config' },
            auth: apiKey({ secret: 'REAL' }),
            adapter: () =>
                Promise.resolve({ status: 200, headers: {}, body: {} }),
            hooks: {
                onRequest: ({ req }) => {
                    seenInHook = { ...req?.headers };
                },
            },
        });
        await call({ headers: { 'X-API-KEY': 'FORGED', 'x-TRACE': 'input' } });
        expect(seenInHook).toEqual({ 'x-trace': 'input', 'x-api-key': 'REAL' });
    });

    test('mockAdapter: a predicate, call.req and the spy see lower-case names', async () => {
        const seenByResponder: string[][] = [];
        const api = mockAdapter({
            match: (req) => req.headers['x-trace'] === '1',
            respond: ({ req }) => {
                seenByResponder.push(Object.keys(req.headers));
                return { body: { ok: true } };
            },
        });
        const call = stitch({
            url: 'https://x.test/a',
            adapter: api,
            headers: { 'X-Trace': '1', 'Content-Type': 'application/json' },
        });
        await call();
        expect(seenByResponder).toEqual([['x-trace', 'content-type']]);
        expect(api.callCount((req) => req.headers['x-trace'] === '1')).toBe(1);
        expect(api.lastRequest()?.headers['X-Trace']).toBeUndefined();
        expect(api.lastRequest()?.headers['x-trace']).toBe('1');
    });
});
