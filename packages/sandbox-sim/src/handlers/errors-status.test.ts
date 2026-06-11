/**
 * S2 smoke test — exercises every handler in errorsStatusHandlers.
 *
 * Run with:
 *   npx -y tsx packages/sandbox-sim/src/handlers/errors-status.test.ts
 *
 * Prints "S2 OK" and exits 0 on success; throws / exits non-zero on failure.
 * Uses node:assert only — no test framework required.
 */

import assert from 'node:assert/strict';

// The contract import is type-only at runtime (interfaces erase), so tsx handles
// it without needing the file to exist as JS.
import type { SimRequest, SimKnobs } from '../../../../docs/playground/contracts/sim';
import { errorsStatusHandlers } from './errors-status';

// ---------------------------------------------------------------------------
// Minimal helpers to build SimRequest objects without a real fetch stack.
// ---------------------------------------------------------------------------

function makeReq(method: string, urlStr: string): SimRequest {
    return {
        method,
        url: new URL(urlStr),
        headers: new Headers(),
    };
}

const EMPTY_KNOBS: SimKnobs = {};

// ---------------------------------------------------------------------------
// Helper: find the first handler that matches, assert one exists.
// ---------------------------------------------------------------------------

function dispatch(req: SimRequest) {
    const h = errorsStatusHandlers.find((handler) => handler.match(req));
    assert.ok(h, `No handler matched ${req.method} ${req.url.pathname}`);
    return h.handle(req, EMPTY_KNOBS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    // ------------------------------------------------------------------
    // 1. GET /users  — list
    // ------------------------------------------------------------------
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/users');
        const res = await dispatch(req);

        assert.equal(res.status, 200, '/users status should be 200');
        assert.ok(res.body, '/users body should be present');
        const body = res.body as { data: unknown[]; total: number };
        assert.ok(Array.isArray(body.data), '/users body.data should be an array');
        assert.equal(body.data.length, 3, '/users should return 3 fixture users');
        assert.equal(body.total, 3, '/users total should equal array length');
        // Spot-check first user shape
        const first = body.data[0] as Record<string, unknown>;
        assert.equal(first.id, 1);
        assert.equal(first.name, 'Alice Liddell');
        assert.ok(typeof first.email === 'string');
    }

    // ------------------------------------------------------------------
    // 2. GET /users/:id  — found
    // ------------------------------------------------------------------
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/users/2');
        const res = await dispatch(req);

        assert.equal(res.status, 200, '/users/2 status should be 200');
        const body = res.body as { data: Record<string, unknown> };
        assert.equal(body.data.id, 2);
        assert.equal(body.data.name, 'Bob Hoskins');
        assert.equal(body.data.role, 'member');
    }

    // ------------------------------------------------------------------
    // 3. GET /users/:id  — not found
    // ------------------------------------------------------------------
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/users/999');
        const res = await dispatch(req);

        assert.equal(res.status, 404, '/users/999 should return 404');
        const body = res.body as { error: string };
        assert.equal(body.error, 'not_found');
    }

    // ------------------------------------------------------------------
    // 4. GET /status/:code — various codes
    // ------------------------------------------------------------------
    for (const code of [200, 400, 401, 403, 404, 429, 500, 503]) {
        const req = makeReq('GET', `https://demo.stitchapi.dev/status/${code}`);
        const res = await dispatch(req);

        assert.equal(res.status, code, `/status/${code} should echo status ${code}`);
        const body = res.body as { status: number; sandbox: boolean };
        assert.equal(body.status, code, `/status/${code} body.status mismatch`);
        assert.equal(body.sandbox, true);
    }

    // /status/:code — a code not in the description map still works
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/status/418');
        const res = await dispatch(req);
        assert.equal(res.status, 418);
        const body = res.body as { description: string };
        // Unknown codes get a fallback description — just check it's a string
        assert.ok(typeof body.description === 'string');
    }

    // ------------------------------------------------------------------
    // 5. GET /malformed  — 200 with HTML body
    // ------------------------------------------------------------------
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/malformed');
        const res = await dispatch(req);

        assert.equal(res.status, 200, '/malformed status should be 200');
        assert.ok(typeof res.body === 'string', '/malformed body should be a string (not JSON)');
        assert.ok((res.body as string).startsWith('<!DOCTYPE html>'), '/malformed body should be HTML');
        // Confirm content-type is text/html to prove it's not JSON
        assert.equal(res.headers?.['content-type'], 'text/html');
    }

    // ------------------------------------------------------------------
    // 6. Non-matching requests should NOT be claimed
    // ------------------------------------------------------------------
    {
        const postUsers = makeReq('POST', 'https://demo.stitchapi.dev/users');
        const claimed = errorsStatusHandlers.some((h) => h.match(postUsers));
        assert.equal(claimed, false, 'POST /users should not be matched by any S2 handler');
    }

    {
        const unknown = makeReq('GET', 'https://demo.stitchapi.dev/unknown-route');
        const claimed = errorsStatusHandlers.some((h) => h.match(unknown));
        assert.equal(claimed, false, 'GET /unknown-route should not be matched by any S2 handler');
    }

    // ------------------------------------------------------------------
    // 7. Determinism — same request returns equal body on repeated calls
    // ------------------------------------------------------------------
    {
        const req = makeReq('GET', 'https://demo.stitchapi.dev/users/3');
        const r1 = await dispatch(req);
        const r2 = await dispatch(req);
        assert.deepEqual(r1.body, r2.body, '/users/3 should return identical body on repeated calls');
    }

    console.log('S2 OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
