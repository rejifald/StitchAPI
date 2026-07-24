// `seam` — a primitive stitches belong to (ADR 0002). These tests assert the firm decisions:
// members inherit the shared fragment and pool ONE throttle bucket; `seam.as(principal)` gives
// each principal its own session (no bleed) while sharing that bucket; `cookieSession` fails
// closed when no principal is bound; per-stitch throttle can only TIGHTEN, never escape the seam;
// secrets stay off `__config`; and `flush()`/`close()` drive the shared lifecycle.
import { bearer, cookieSession, memoryStore, seam, stitch } from '../src';
import type { StitchStore } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-seam-${process.pid}.jsonl`,
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

// Wall-clock of an async block — used to prove concurrency gating (serial vs parallel).
const elapsed = async (fn: () => Promise<unknown>): Promise<number> => {
    const t = Date.now();
    await fn();
    return Date.now() - t;
};

// A login stitch standing in for "exchange credentials for a Set-Cookie session".
const loginStitch = () =>
    stitch({ method: 'POST', baseUrl: server.url, path: '/login' });

test('member stitches inherit the seam fragment (baseUrl + default headers)', async () => {
    server.route('GET', '/ping', { body: { ok: true } });
    const api = seam({ baseUrl: server.url, headers: { 'x-seam': 'yes' } });

    const ping = api.stitch('/ping');
    await expect(ping()).resolves.toEqual({ ok: true });

    const call = server.calls('/ping')[0]!;
    expect(call.headers['x-seam']).toBe('yes'); // inherited default header
    expect(call.path).toBe('/ping'); // relative path resolved against the inherited baseUrl
});

test('the seam pools ONE throttle bucket across its different member stitches', async () => {
    server.route('GET', '/x', { delay: 150, body: { r: 'x' } });
    server.route('GET', '/y', { delay: 150, body: { r: 'y' } });
    const api = seam({ baseUrl: server.url, throttle: { concurrency: 1 } });
    const x = api.stitch('/x');
    const y = api.stitch('/y');

    // Two DIFFERENT members fired together must serialize on the shared concurrency=1 bucket —
    // independent stitches (own buckets) would run in parallel (~150ms).
    const ms = await elapsed(() => Promise.all([x(), y()]));
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(server.callCount('/x')).toBe(1);
    expect(server.callCount('/y')).toBe(1);
});

test('a per-stitch throttle can only TIGHTEN — it cannot escape the seam budget', async () => {
    server.route('GET', '/z', { delay: 150, body: { r: 'z' } });
    const api = seam({ baseUrl: server.url, throttle: { concurrency: 1 } });
    // The member asks for a LOOSER limit (5); the seam's concurrency=1 still gates, so two
    // concurrent calls serialize — the local throttle stacks, it does not replace the shared one.
    const loose = api.stitch({ path: '/z', throttle: { concurrency: 5 } });

    const ms = await elapsed(() => Promise.all([loose(), loose()]));
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(server.callCount('/z')).toBe(2);
});

test('seam.as(principal) gives each principal its OWN session — no cross-principal bleed', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'OK' },
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const api = seam({
        baseUrl: server.url,
        auth: cookieSession({
            login: loginStitch(),
            cookie: 'sid',
            // trusted code maps the principal → that user's login credentials
            loginInput: (principal) => ({ body: { u: principal } }),
        }),
    });

    // Two DISTINCT stitch instances for principal A share A's session via the seam vault → 1 login.
    await api.as('A').stitch('/data')();
    await api.as('A').stitch('/data')();
    // Principal B's key differs, so B logs in on its own — it never reuses A's session (the bleed).
    await api.as('B').stitch('/data')();

    expect(server.callCount('/login')).toBe(2); // one per principal, not one shared session
    const logins = server.calls('/login');
    expect((logins[0]!.body as { u: string }).u).toBe('A'); // loginInput got the principal
    expect((logins[1]!.body as { u: string }).u).toBe('B');
});

test('cookieSession fails closed: default tenancy throws when no principal is bound', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'OK' },
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const api = seam({
        baseUrl: server.url,
        auth: cookieSession({ login: loginStitch(), cookie: 'sid' }),
    });

    // Root seam — no principal bound — must refuse rather than silently run app-scoped.
    await expect(api.stitch('/data')()).rejects.toThrow(/principal/i);
    expect(server.callCount('/login')).toBe(0); // failed closed before any login
});

test("tenancy: 'app' is the explicit opt-in to ONE session shared across all callers", async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'OK' },
        body: { ok: true },
    });
    server.route('GET', '/data', {
        requireCookie: { name: 'sid' },
        body: { ok: true },
    });

    const api = seam({
        baseUrl: server.url,
        auth: cookieSession({
            login: loginStitch(),
            cookie: 'sid',
            tenancy: 'app',
            loginInput: (principal) => ({ body: { u: principal ?? 'app' } }),
        }),
    });

    // Different principal handles, one shared app session → a single login.
    await api.as('A').stitch('/data')();
    await api.as('B').stitch('/data')();
    expect(server.callCount('/login')).toBe(1);
});

test('__config is redacted (no store/auth/adapter) yet the auth still applies', async () => {
    server.route('GET', '/p', {
        requireHeader: { name: 'authorization', value: 'Bearer TOK' },
        body: { ok: true },
    });
    const api = seam({
        baseUrl: server.url,
        headers: { a: 'b' },
        auth: bearer('TOK'),
        store: memoryStore(),
    });

    // Public surface leaks no live secret-bearing handles (exfil-at-rest, ADR §4/§6) — the
    // redacted public type omits them entirely, so reading them needs a cast (and they are also
    // absent at runtime).
    expect(api.__config.baseUrl).toBe(server.url);
    expect(api.__seam).toBe(true);
    const live = api.__config as {
        auth?: unknown;
        store?: unknown;
        adapter?: unknown;
    };
    expect(live.auth).toBeUndefined();
    expect(live.store).toBeUndefined();
    expect(live.adapter).toBeUndefined();

    const p = api.stitch('/p');
    expect((p.__config as { auth?: unknown }).auth).toBeUndefined(); // member is redacted too …
    expect(p.__config.headers).toEqual({ a: 'b' }); // (non-secret config still inherited)
    // … and yet the credential flows through the shared runtime: the request carries the Bearer.
    await expect(p()).resolves.toEqual({ ok: true });
});

test('redaction surfaces the auth SCHEME (non-secret) while stripping the credential', () => {
    const api = seam({
        baseUrl: 'https://api.example.com',
        auth: bearer('TOK'),
    });
    // The live, secret-bearing strategy is gone from the public config …
    expect((api.__config as { auth?: unknown }).auth).toBeUndefined();
    // … but its non-secret scheme is projected onto __config (the `authScheme` that feeds
    // `export --openapi`), so a stitch's auth round-trips as JSON without exposing the credential.
    expect((api.__config as { authScheme?: unknown }).authScheme).toEqual({
        type: 'http',
        scheme: 'bearer',
    });
    expect(JSON.stringify(api.__config)).not.toContain('TOK');
});

test('close() flushes the sink and closes the shared store', async () => {
    server.route('GET', '/p', { body: { ok: true } });
    let closed = false;
    const base = memoryStore();
    const spyStore: StitchStore = {
        get: (k) => base.get(k),
        set: (k, v, ttl) => base.set(k, v, ttl),
        incr: (k, ttl) => base.incr(k, ttl),
        close: async () => {
            closed = true;
            await base.close?.();
        },
    };

    const api = seam({ baseUrl: server.url, store: spyStore });
    await api.stitch('/p')();

    await expect(api.flush()).resolves.toBeUndefined();
    await api.close();
    expect(closed).toBe(true);
});
