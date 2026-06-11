// Closes two gaps dogfooding surfaced: request body encoding (form / multipart, not just
// JSON) and content-aware auth refresh (a 200 that is actually a login page = a soft wall).
import { cookieSession, env, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STITCH_TRACE_FILE = join(
    tmpdir(),
    `stitch-encoding-${process.pid}.jsonl`,
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
});

describe('Body encoding', () => {
    test('form -> application/x-www-form-urlencoded (with escaping)', async () => {
        server.route('POST', '/login', { body: { ok: true } });
        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/login',
            bodyType: 'form',
        });

        await login({ body: { username: 'admin', password: 'p@ss & word' } });

        const call = server.calls('/login')[0];
        expect(call?.headers['content-type']).toMatch(
            /application\/x-www-form-urlencoded/,
        );
        const params = new URLSearchParams(String(call?.body));
        expect(params.get('username')).toBe('admin');
        expect(params.get('password')).toBe('p@ss & word'); // proves proper escaping round-trips
    });

    test('multipart -> multipart/form-data with a named file part + text fields', async () => {
        server.route('POST', '/upload', { body: { ok: true } });
        const upload = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/upload',
            bodyType: 'multipart',
        });

        const bytes = new Uint8Array([1, 2, 3, 4]);
        await upload({
            body: {
                category: 'movies',
                file: {
                    value: bytes,
                    filename: 'a.bin',
                    type: 'application/octet-stream',
                },
            },
        });

        const call = server.calls('/upload')[0];
        expect(call?.headers['content-type']).toMatch(
            /^multipart\/form-data; boundary=/,
        );
        const raw = String(call?.body);
        expect(raw).toContain('name="category"');
        expect(raw).toContain('movies');
        expect(raw).toContain('name="file"');
        expect(raw).toContain('filename="a.bin"');
    });

    test('json remains the default', async () => {
        server.route('POST', '/json', { body: { ok: true } });
        const j = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/json',
        });

        await j({ body: { a: 1 } });

        const call = server.calls('/json')[0];
        expect(call?.headers['content-type']).toMatch(/application\/json/);
        expect(call?.body).toEqual({ a: 1 }); // mock parsed it back as JSON
    });
});

describe('cookieSession content-aware refresh (soft wall)', () => {
    test('re-logs-in when a 200 response is actually a login page', async () => {
        process.env.SOFT_USER = 'u';
        process.env.SOFT_PASS = 'p';
        server.route('POST', '/auth', {
            setCookie: { name: 'SID', value: 'OK' },
            body: 'ok',
        });
        // call #0: a 200 login page (stale session); call #1: the real data.
        server.route('GET', '/data', {
            statuses: [200, 200],
            body: ['<html>please log in</html>', { items: [1, 2] }],
        });

        const login = stitch({
            method: 'POST',
            baseUrl: server.url,
            path: '/auth',
            bodyType: 'form',
        });
        const data = stitch({
            baseUrl: server.url,
            path: '/data',
            auth: cookieSession({
                login,
                cookie: 'SID',
                // status is 200, so only a content predicate can catch this wall:
                refreshWhen: (res) =>
                    typeof res.body === 'string' && /log in/i.test(res.body),
                loginInput: () => ({
                    body: { u: env('SOFT_USER')(), p: env('SOFT_PASS')() },
                }),
            }),
        });

        const out = await data();
        expect(out).toEqual({ items: [1, 2] });
        expect(server.callCount('/auth')).toBe(2); // initial auto-login + content-triggered refresh
        expect(server.callCount('/data')).toBe(2);
    });
});
