// apiKey's location model (CONTRACT.md P16/P22): ONE builder with three symmetric arms — `name`
// labels the key in every arm and `in` selects where it goes: header (default) / query / cookie.
// The cookie arm makes `in: 'cookie'` a first-class location (matching OpenAPI's three `in` values),
// so an OpenAPI `apiKey` cookie scheme maps to a real strategy instead of a not-auto-mapped warning.
import { stitch } from '../src';
import { apiKey } from '../src/auth';
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
            auth: apiKey({ name: 'X-My-Key', value: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.headers['x-my-key']).toBe('tok');
    });

    test('header name defaults to x-api-key', async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ value: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.headers['x-api-key']).toBe('tok');
    });

    test("in: 'query' appends the named param to the URL", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ in: 'query', name: 'access_token', value: 'tok' }),
        });
        await s();
        expect(server.calls('/thing')[0]?.query['access_token']).toBe('tok');
    });

    test("in: 'cookie' sends the key as a cookie", async () => {
        server.route('GET', '/thing', { body: { ok: true } });
        const s = stitch({
            baseUrl: server.url,
            path: '/thing',
            auth: apiKey({ in: 'cookie', name: 'sid', value: 'tok' }),
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
            auth: apiKey({ in: 'cookie', name: 'sid', value: 'tok' }),
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
            auth: apiKey({ in: 'cookie', name: 'sid', value: 'fresh' }),
        });
        await s();
        const call = server.calls('/thing')[0];
        // exactly one `sid` — replaced in place, not appended — and the other cookie preserved
        expect(call?.headers['cookie']).toBe('sid=fresh; theme=dark');
        expect(call?.cookies['sid']).toBe('fresh');
    });
});
