import { preset, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-url-contract-${process.pid}.jsonl`,
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

// `url` is the atomic spelling: a single full endpoint, no base to share.
test('url alone hits the endpoint', async () => {
    server.route('GET', '/users', { body: { ok: true } });
    const users = stitch({ url: `${server.url}/users` });
    await expect(users()).resolves.toEqual({ ok: true });
});

test('url supports {param} templating and an appended query', async () => {
    server.route('GET', '/users/1', { body: { id: 1 } });
    const getUser = stitch({ url: `${server.url}/users/{id}` });
    await expect(
        getUser({ params: { id: 1 }, query: { expand: 'roles' } }),
    ).resolves.toEqual({ id: 1 });
    expect(server.calls('/users/1')[0]?.query).toEqual({ expand: 'roles' });
});

test('url may be a function (lazy/env resolution)', async () => {
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ url: () => `${server.url}/ping` });
    await expect(ping()).resolves.toEqual({ ok: true });
});

// Precedence: when both spellings are present, `url` wins (resolved away at compose time).
test('url takes precedence over baseUrl + path', async () => {
    server.route('GET', '/right', { body: { hit: 'url' } });
    const s = stitch({
        url: `${server.url}/right`,
        baseUrl: 'https://wrong.example.com',
        path: '/wrong',
    });
    expect(s.__config.url).toBe(`${server.url}/right`);
    expect(s.__config.baseUrl).toBeUndefined();
    expect(s.__config.path).toBeUndefined();
    await expect(s()).resolves.toEqual({ hit: 'url' });
    expect(server.callCount('/right')).toBe(1);
});

// Composition: the endpoint is one mutually-exclusive slot — the last writer wins it whole.
test('a child url overrides an inherited baseUrl/path', async () => {
    server.route('GET', '/from-url', { body: { ok: true } });
    const base = preset({
        baseUrl: 'https://wrong.example.com',
        path: '/wrong',
    });
    const s = stitch({ extends: [base], url: `${server.url}/from-url` });

    expect(s.__config.url).toBe(`${server.url}/from-url`);
    expect(s.__config.baseUrl).toBeUndefined();
    expect(s.__config.path).toBeUndefined();
    await expect(s()).resolves.toEqual({ ok: true });
});

test('a child baseUrl/path overrides an inherited url', async () => {
    server.route('GET', '/from-path', { body: { ok: true } });
    const base = preset({ url: 'https://wrong.example.com/wrong' });
    const s = stitch({
        extends: [base],
        baseUrl: server.url,
        path: '/from-path',
    });

    expect(s.__config.baseUrl).toBe(server.url);
    expect(s.__config.path).toBe('/from-path');
    expect(s.__config.url).toBeUndefined();
    await expect(s()).resolves.toEqual({ ok: true });
});

// baseUrl may itself contain a path prefix; the path is appended, not replaced.
test('baseUrl with path prefix concatenates with path', async () => {
    server.route('GET', '/v1/users', { body: { ok: true } });
    const users = stitch({ baseUrl: `${server.url}/v1`, path: '/users' });
    await expect(users()).resolves.toEqual({ ok: true });
    expect(server.callCount('/v1/users')).toBe(1);
});

// Guard: a relative endpoint can't be fetched — fail with a clear config error rather than a
// cryptic transport error from fetch.
test('a relative path with no baseUrl throws a clear config error', async () => {
    const s = stitch({ path: '/relative' });
    await expect(s()).rejects.toThrow(/not absolute/i);
});

test('a relative url throws a clear config error', async () => {
    const s = stitch({ url: '/relative' });
    await expect(s()).rejects.toThrow(/not absolute/i);
});

// Regression: an absolute string in `path` still resolves (the tolerant fallback).
test('an absolute URL in path still works', async () => {
    server.route('GET', '/legacy', { body: { ok: true } });
    const s = stitch({ path: `${server.url}/legacy` });
    await expect(s()).resolves.toEqual({ ok: true });
});
