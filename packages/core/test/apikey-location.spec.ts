// apiKey's location model (CONTRACT.md P16/P22): ONE builder with three symmetric arms — `name`
// labels the key in every arm and `in` selects where it goes: header (default) / query / cookie.
// The cookie arm makes `in: 'cookie'` a first-class location (matching OpenAPI's three `in` values),
// so an OpenAPI `apiKey` cookie scheme maps to a real strategy instead of a not-auto-mapped warning.
import { stitch } from '../src';
import { apiKey } from '../src/auth';
import type { ApiKeyOptions } from '../src/auth';
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

describe('apiKey — location model (header / query / cookie)', () => {
    test("in: 'header' (default) writes the named header, lower-cased on the wire", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ name: 'X-My-Key', secret: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.headers['x-my-key']).toBe('tok');
    });

    test('header name defaults to x-api-key', async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ secret: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.headers['x-api-key']).toBe('tok');
    });

    test('the P15 scalar shorthand: apiKey(secret) ≡ apiKey({ secret })', async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        // A bare string and a thunk are both Secrets — the two non-envelope spellings.
        const literal = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey('tok-literal'),
        });
        await literal();
        expect(server.calls('/thing')[0]?.headers['x-api-key']).toBe(
            'tok-literal',
        );
        const thunked = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey(() => 'tok-thunk'),
        });
        await thunked();
        expect(server.calls('/thing')[1]?.headers['x-api-key']).toBe(
            'tok-thunk',
        );
    });

    test("in: 'query' appends the named param to the URL", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ in: 'query', name: 'access_token', secret: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.query['access_token']).toBe('tok');
    });

    test("in: 'cookie' sends the key as a cookie", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ in: 'cookie', name: 'sid', secret: 'tok' }),
        });
        await s();
        const call = server.calls('/thing')[0];
        expect(call?.headers['cookie']).toBe('sid=tok');
        expect(call?.cookies['sid']).toBe('tok');
    });

    test("in: 'cookie' merges with a cookie the request already carries", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            headers: { cookie: 'theme=dark' },
            auth: apiKey({ in: 'cookie', name: 'sid', secret: 'tok' }),
        });
        await s();
        const call = server.calls('/thing')[0];
        expect(call?.headers['cookie']).toBe('theme=dark; sid=tok');
        expect(call?.cookies).toMatchObject({ theme: 'dark', sid: 'tok' });
    });

    test("in: 'cookie' replaces a same-named cookie instead of duplicating it", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            headers: { cookie: 'sid=stale; theme=dark' },
            auth: apiKey({ in: 'cookie', name: 'sid', secret: 'fresh' }),
        });
        await s();
        const call = server.calls('/thing')[0];
        // exactly one `sid` — replaced in place, not appended — and the other cookie preserved
        expect(call?.headers['cookie']).toBe('sid=fresh; theme=dark');
        expect(call?.cookies['sid']).toBe('fresh');
    });
});

// P14/P16 — `ApiKeyOptions` is EXPORTED, like every sibling auth builder's option type
// (`BasicOptions`, `OAuth2Options`, `CookieSessionOptions`). Declared without `export` it inlined
// into `apiKey`'s emitted `.d.ts` as an anonymous shape, so a consumer could neither import nor
// extend it while its three siblings imported fine. This import IS the assertion — it does not
// compile without the export — and the composition below is the thing a consumer wanted it for.
describe('ApiKeyOptions is importable (P14/P16)', () => {
    test('a consumer can name, extend, and hand back the option type', async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        // Name it: a factory that takes the published envelope and fills in a house default.
        const vendorKey = (opts: ApiKeyOptions): ApiKeyOptions => ({
            in: 'header',
            name: 'X-Vendor-Key',
            ...opts,
        });
        // Extend it: the shape composes into a wider consumer-owned envelope.
        interface VendorAuthOptions extends ApiKeyOptions {
            label: string;
        }
        const authored: VendorAuthOptions = { secret: 'tok', label: 'prod' };
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey(vendorKey({ secret: authored.secret })),
        });
        await s();
        expect(server.calls('/thing')[0]?.headers['x-vendor-key']).toBe('tok');
    });
});
