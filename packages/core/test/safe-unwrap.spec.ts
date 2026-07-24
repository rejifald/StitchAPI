// The never-throwing call surfaces (`stitch.safe()` / `stitch(...).safe()`) and the explicit
// throwing twin (`stitch.unwrap()`), plus the typed StitchError they share. Driven by the real
// mock server so status/attempts come off an actual response, like resilience.spec.
import { StitchError, stitch } from '../src';
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

// ── safe(): success ─────────────────────────────────────────────────────────
test('safe() resolves { ok: true, data, error: null } on success', async () => {
    server.route('GET', '/u', { body: { ok: true } });
    const call = stitch({ baseUrl: server.url, path: '/u' });

    const res = await call.safe();

    // Discriminated union: `ok`/`error`/`data` all line up on the success branch.
    expect(res).toEqual({ ok: true, data: { ok: true }, error: null });
});

// ── safe(): failure never throws ────────────────────────────────────────────
test('safe() returns { ok: false, data: null, error } instead of throwing', async () => {
    server.route('GET', '/down', {
        statuses: [503, 503, 503],
        body: { error: 'unavailable' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/down',
        retry: { attempts: 3, on: [503], baseDelay: 5 },
    });

    const res = await call.safe();

    expect(res.ok).toBe(false);
    expect(res.data).toBeNull();
    expect(res.error).toBeInstanceOf(StitchError);
    expect(res.error).toMatchObject({ status: 503, attempts: 3 });
    expect(server.callCount('/down')).toBe(3);
});

// ── safe(): also on the result object (parity with the eager method) ─────────
test('stitch(input).safe() mirrors stitch.safe(input)', async () => {
    server.route('GET', '/u', { body: { ok: true } });
    const call = stitch({ baseUrl: server.url, path: '/u' });

    expect(await call().safe()).toEqual({
        ok: true,
        data: { ok: true },
        error: null,
    });
});

// ── unwrap(): the explicit throwing twin ────────────────────────────────────
test('unwrap() resolves the value on success and throws StitchError on failure', async () => {
    server.route('GET', '/ok', { body: { id: 1 } });
    server.route('GET', '/bad', { statuses: [500], body: { error: 'boom' } });

    await expect(
        stitch({ baseUrl: server.url, path: '/ok' }).unwrap(),
    ).resolves.toEqual({ id: 1 });

    await expect(
        stitch({ baseUrl: server.url, path: '/bad' }).unwrap(),
    ).rejects.toBeInstanceOf(StitchError);
});

// ── the bare await still throws the same typed error (refactor regression) ───
test('await sugar still rejects with a StitchError carrying .status', async () => {
    server.route('GET', '/bad', { statuses: [500], body: { error: 'boom' } });
    const call = stitch({ baseUrl: server.url, path: '/bad' });

    await expect(call()).rejects.toBeInstanceOf(StitchError);
    await expect(call()).rejects.toMatchObject({ status: 500 });
});

// ── .with(...) composes with safe()/unwrap() ────────────────────────────────
test('a bound stitch (.with) exposes safe() and unwrap()', async () => {
    server.route('GET', '/u', { body: { ok: true } });
    const bound = stitch({ baseUrl: server.url, path: '/u' }).with({
        query: { expand: 'roles' },
    });

    expect(await bound.safe()).toEqual({
        ok: true,
        data: { ok: true },
        error: null,
    });
    await expect(bound.unwrap()).resolves.toEqual({ ok: true });
});
