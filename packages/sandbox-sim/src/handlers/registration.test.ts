/**
 * F1 — Smoke test for handler registration.
 *
 * Verifies:
 *   1. registerAllHandlers() populates the registry correctly
 *   2. GET /__sandbox returns the static catalogue with status 200
 *   3. A known route (GET /users) still dispatches
 *   4. No other files changed
 */
import { dispatch } from '../dispatch';
import { handlers } from '../index';
import { allHandlers, registerAllHandlers } from './index';

import assert from 'node:assert';

async function main() {
    // 1. Register all handlers and verify count.
    registerAllHandlers();
    assert.strictEqual(
        handlers.length,
        allHandlers.length,
        `Expected ${allHandlers.length} handlers registered, got ${handlers.length}`,
    );
    console.log(`✓ Registered ${handlers.length} handlers`);

    // 2. Test GET /__sandbox — verify status 200 and catalogue structure.
    const sandboxUrl = new URL('http://demo.stitchapi.dev/__sandbox');
    const sandboxReq = {
        method: 'GET',
        url: sandboxUrl,
        headers: new Headers(),
    };
    const sandboxRes = await dispatch(handlers, sandboxReq);
    assert.strictEqual(
        sandboxRes.status,
        200,
        'GET /__sandbox should return 200',
    );
    assert(
        typeof sandboxRes.body === 'object' && sandboxRes.body !== null,
        'GET /__sandbox body should be an object',
    );
    const catalogueBody = sandboxRes.body as Record<string, unknown>;
    assert(
        Array.isArray(catalogueBody.routes),
        'Catalogue should have a "routes" array',
    );
    const routes = catalogueBody.routes as unknown[];
    assert(routes.length > 0, 'Catalogue routes array should not be empty');
    // Verify /drift is present in the catalogue.
    const driftRoute = routes.find(
        (r: unknown) =>
            typeof r === 'object' &&
            r !== null &&
            (r as Record<string, unknown>).path === '/drift',
    );
    assert(driftRoute, 'Catalogue should include /drift route');
    console.log(
        `✓ GET /__sandbox returns catalogue with ${routes.length} routes`,
    );

    // 3. Test GET /users — verify a known route still dispatches.
    const usersUrl = new URL('http://demo.stitchapi.dev/users');
    const usersReq = {
        method: 'GET',
        url: usersUrl,
        headers: new Headers(),
    };
    const usersRes = await dispatch(handlers, usersReq);
    assert.strictEqual(usersRes.status, 200, 'GET /users should return 200');
    assert(
        typeof usersRes.body === 'object' && usersRes.body !== null,
        'GET /users body should be an object',
    );
    const usersBody = usersRes.body as Record<string, unknown>;
    assert(
        Array.isArray(usersBody.data),
        'GET /users body should have a "data" array',
    );
    console.log(`✓ GET /users still dispatches correctly`);

    console.log('F1 OK');
}

main().catch((err) => {
    console.error('F1 FAILED:', err);
    process.exit(1);
});
