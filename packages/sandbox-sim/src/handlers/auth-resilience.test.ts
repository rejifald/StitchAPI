/**
 * S4 smoke test — auth-resilience handlers.
 *
 * Uses node:assert + a plain main() function.
 * Run with:  npx tsx packages/sandbox-sim/src/handlers/auth-resilience.test.ts
 */
import type {
    SimKnobs,
    SimRequest,
} from '../../../../docs/playground/contracts/sim';
import { authResilienceHandlers } from './auth-resilience';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
    method: string,
    path: string,
    headers: Record<string, string> = {},
): SimRequest {
    return {
        method,
        url: new URL(`https://demo.stitchapi.dev${path}`),
        headers: new Headers(headers),
    };
}

const emptyKnobs: SimKnobs = {};

function findHandler(req: SimRequest) {
    const h = authResilienceHandlers.find((handler) => handler.match(req));
    if (!h)
        throw new Error(`No handler matched ${req.method} ${req.url.pathname}`);
    return h;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function main() {
    // -----------------------------------------------------------------------
    // /auth/me — 401 without token
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/auth/me');
        const h = findHandler(req);
        const res = await h.handle(req, emptyKnobs);

        assert.equal(res.status, 401, '/auth/me without token must be 401');
        assert.ok(
            res.headers?.['WWW-Authenticate'],
            '/auth/me 401 must include WWW-Authenticate header',
        );
        const body = res.body as Record<string, unknown>;
        assert.equal(
            body.error,
            'unauthorized',
            '/auth/me 401 body.error must be "unauthorized"',
        );
    }

    // -----------------------------------------------------------------------
    // /auth/me — 401 with empty bearer
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/auth/me', { Authorization: 'Bearer ' });
        const h = findHandler(req);
        const res = await h.handle(req, emptyKnobs);
        assert.equal(res.status, 401, '/auth/me with empty bearer must be 401');
    }

    // -----------------------------------------------------------------------
    // /auth/me — 200 with valid bearer token
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/auth/me', {
            Authorization: 'Bearer my-simulated-token',
        });
        const h = findHandler(req);
        const res = await h.handle(req, emptyKnobs);

        assert.equal(res.status, 200, '/auth/me with bearer must be 200');
        const body = res.body as Record<string, unknown>;
        assert.ok(body.id, '/auth/me 200 body must have id');
        assert.ok(body.username, '/auth/me 200 body must have username');
        assert.equal(
            body.credentialKind,
            'bearer',
            '/auth/me with bearer must report credentialKind=bearer',
        );
    }

    // -----------------------------------------------------------------------
    // /auth/me — 200 with session cookie
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/auth/me', {
            Cookie: 'session=abc123; other=val',
        });
        const h = findHandler(req);
        const res = await h.handle(req, emptyKnobs);

        assert.equal(
            res.status,
            200,
            '/auth/me with session cookie must be 200',
        );
        const body = res.body as Record<string, unknown>;
        assert.equal(
            body.credentialKind,
            'cookieSession',
            '/auth/me with cookie must report credentialKind=cookieSession',
        );
    }

    // -----------------------------------------------------------------------
    // /auth/me — match() returns false for wrong method / wrong path
    // -----------------------------------------------------------------------
    {
        const wrongMethod = makeReq('POST', '/auth/me');
        const wrongPath = makeReq('GET', '/auth/other');
        const h = authResilienceHandlers.find((handler) =>
            handler.match(wrongMethod),
        );
        assert.equal(
            h,
            undefined,
            'POST /auth/me must not match authMeHandler',
        );
        const h2 = authResilienceHandlers.find((handler) =>
            handler.match(wrongPath),
        );
        assert.equal(
            h2,
            undefined,
            'GET /auth/other must not match authMeHandler',
        );
    }

    // -----------------------------------------------------------------------
    // /limited — always 429 + Retry-After
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/limited');
        const h = findHandler(req);
        const res = await h.handle(req, emptyKnobs);

        assert.equal(res.status, 429, '/limited must return 429');
        assert.equal(
            res.headers?.['Retry-After'],
            '1',
            '/limited must include Retry-After: 1',
        );
        const body = res.body as Record<string, unknown>;
        assert.equal(
            body.error,
            'rate_limited',
            '/limited body.error must be "rate_limited"',
        );
        assert.equal(
            body.retryAfterSeconds,
            1,
            '/limited body.retryAfterSeconds must be 1',
        );
    }

    // -----------------------------------------------------------------------
    // /drift — schema-valid when drift=false (or absent)
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/drift');
        const h = findHandler(req);
        const res = await h.handle(req, { drift: false });

        assert.equal(res.status, 200, '/drift (no drift) must return 200');
        const body = res.body as Record<string, unknown>;

        // Schema: { id: number, name: string }
        assert.equal(
            typeof body.id,
            'number',
            '/drift (no drift) body.id must be a number',
        );
        assert.equal(
            typeof body.name,
            'string',
            '/drift (no drift) body.name must be a string',
        );
        assert.equal(
            body.hasOwnProperty('extra'),
            false,
            '/drift (no drift) must not have extra field',
        );
    }

    // -----------------------------------------------------------------------
    // /drift — drifted payload when drift=true
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/drift');
        const h = findHandler(req);
        const res = await h.handle(req, { drift: true });

        assert.equal(res.status, 200, '/drift (drift=true) must return 200');
        const body = res.body as Record<string, unknown>;

        // Drift violations:
        assert.equal(
            typeof body.id,
            'string',
            '/drift (drift=true) body.id must be a STRING (type violation)',
        );
        assert.equal(
            body.hasOwnProperty('name'),
            false,
            '/drift (drift=true) must be missing name field',
        );
        assert.equal(
            body.hasOwnProperty('extra'),
            true,
            '/drift (drift=true) must have unexpected extra field',
        );
    }

    // -----------------------------------------------------------------------
    // Determinism — same request, same response (no wall-clock/random)
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/auth/me', { Authorization: 'Bearer tok' });
        const h = findHandler(req);
        const r1 = await h.handle(req, emptyKnobs);
        const r2 = await h.handle(req, emptyKnobs);
        assert.deepEqual(r1, r2, '/auth/me responses must be deterministic');
    }

    {
        const req = makeReq('GET', '/drift');
        const h = findHandler(req);
        const r1 = await h.handle(req, { drift: true });
        const r2 = await h.handle(req, { drift: true });
        assert.deepEqual(
            r1,
            r2,
            '/drift (drift=true) responses must be deterministic',
        );
    }

    console.log('S4 OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
