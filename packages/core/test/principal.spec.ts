// The trusted principal boundary (`seam.as(principal)`, ADR 0002 §2–3). A per-principal handle
// is the object trusted server code hands to the LEAST-trusted caller (the agent): it binds one
// identity in the closure so the caller can never name another principal. This suite owns the
// boundary's integrity guarantees — chiefly that a principal handle gets the principal's *use* of
// the shared runtime without the *authority* to tear that runtime down. `seam.as(id)` therefore
// returns a lifecycle-free `PrincipalSeam` (no `flush` / `close` / `invalidate`); only the root
// seam can tear down (or cache-bust) the runtime every other principal shares.
import { memoryStore, seam, stitch } from '../src';
import type { Seam, StitchStore } from '../src';
import { cookieSession } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-principal-${process.pid}.jsonl`,
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

// A login stitch standing in for "exchange credentials for a Set-Cookie session".
const loginStitch = () =>
    stitch({ method: 'POST', baseUrl: server.url, path: '/login' });

// A store that records whether close() was ever called, delegating everything else to memory.
function spyStore(): { store: StitchStore; closed: () => boolean } {
    const base = memoryStore();
    let didClose = false;
    return {
        closed: () => didClose,
        store: {
            get: (k) => base.get(k),
            set: (k, v, ttl) => base.set(k, v, ttl),
            incr: (k, ttl) => base.incr(k, ttl),
            close: async () => {
                didClose = true;
                await base.close?.();
            },
        },
    };
}

describe('seam.as(principal) — the trusted principal boundary', () => {
    test('a principal handle cannot tear down the shared runtime — close/invalidate are root-only', async () => {
        server.route('GET', '/p', { body: { ok: true } });
        const spy = spyStore();
        const api = seam({ baseUrl: server.url, store: spy.store });

        // The handle trusted code derives per request and hands to the agent/caller.
        const userApi = api.as('req-user-1');
        await userApi.stitch('/p')();

        // The shared-runtime levers are absent on the type AND at runtime — a per-request handle
        // can neither close the store every other principal shares nor cache-bust them.
        const probe = userApi as {
            close?: () => Promise<void>;
            invalidate?: () => Promise<void>;
        };
        expect(probe.close).toBeUndefined();
        expect(probe.invalidate).toBeUndefined();
        await probe.close?.();
        expect(spy.closed()).toBe(false);

        // The shared surface is still alive for other principals after the agent "closed" its handle.
        await expect(api.as('req-user-2').stitch('/p')()).resolves.toEqual({
            ok: true,
        });

        // Only the ROOT seam owns the lifecycle.
        await api.close();
        expect(spy.closed()).toBe(true);
    });

    test('each principal gets its OWN session — no cross-principal bleed', async () => {
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
                loginInput: (principal) => ({ body: { u: principal } }),
            }),
        });

        await api.as('A').stitch('/data')();
        await api.as('B').stitch('/data')();

        expect(server.callCount('/login')).toBe(2); // one session per principal, never shared
        const logins = server.calls('/login');
        expect((logins[0]!.body as { u: string }).u).toBe('A');
        expect((logins[1]!.body as { u: string }).u).toBe('B');
    });

    test('as() chaining rebinds the principal — the innermost binding wins', async () => {
        server.route('POST', '/login', {
            setCookie: { name: 'sid', value: 'OK' },
            body: { ok: true },
        });
        server.route('GET', '/data', {
            requireCookie: { name: 'sid' },
            body: { ok: true },
        });

        const api: Seam = seam({
            baseUrl: server.url,
            auth: cookieSession({
                login: loginStitch(),
                cookie: 'sid',
                loginInput: (principal) => ({ body: { u: principal } }),
            }),
        });

        // `.as('A').as('B')` is last-writer-wins: the request runs as B, not A.
        await api.as('A').as('B').stitch('/data')();

        expect(server.callCount('/login')).toBe(1);
        expect((server.calls('/login')[0]!.body as { u: string }).u).toBe('B');
    });
});
